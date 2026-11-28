package ai.openclaw.app.anylink

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Streaming sentence chunker (Kotlin port of Mac VoiceUtteranceBuffer): splits SSE text on sentence
 * boundaries so real-time voice calls start speaking sentence 1 while sentence 2 is still generating. */
internal class VoiceSentenceChunker {
  private val pending = StringBuilder()
  private var first = true
  private var fenced = false
  private var ticks = 0

  fun append(delta: String) {
    for (ch in delta) {
      if (ch == '`') { ticks++; continue }
      if (ticks >= 3) fenced = !fenced
      ticks = 0
      if (!fenced) pending.append(ch)
    }
  }

  fun take(force: Boolean = false): String? {
    val minimum = if (first) 4 else 16
    var end = -1
    for (i in 0 until pending.length) {
      val count = i + 1
      val ch = pending[i]
      // Short comma fragments reset TTS prosody. Keep a quick first sentence, then complete phrases.
      if ((count >= minimum && ch in "。！？!?；;\n") || (count >= 32 && ch in "，,：:") || (count >= 48 && ch.isWhitespace()) || count >= 64) {
        end = i + 1
        break
      }
    }
    if (end < 0 && force && pending.isNotEmpty()) end = pending.length
    if (force && end > 0 && pending.length - end in 1..7) end = pending.length
    if (end <= 0) return null
    val raw = pending.substring(0, end)
    pending.delete(0, end)
    val cleaned = SpeechSanitizer.clean(raw)
    if (cleaned.isEmpty()) return take(force)
    first = false
    return cleaned
  }
}

/** Pure-Kotlin PCM16 mono WAV encoder & RMS helper (zero native dependencies). */
internal object WavEncoder {
  fun pcm16Rms(samples: ShortArray, count: Int): Float {
    if (count <= 0) return 0f
    var sum = 0.0
    for (i in 0 until count) {
      val v = samples[i].toDouble() / 32768.0
      sum += v * v
    }
    return sqrt(sum / count).toFloat().coerceIn(0f, 1f)
  }

  fun encodePcm16Mono(pcmData: ByteArray, sampleRate: Int = 16000): ByteArray {
    val channels = 1
    val bitsPerSample = 16
    val byteRate = sampleRate * channels * bitsPerSample / 8
    val blockAlign = channels * bitsPerSample / 8
    val totalDataLen = pcmData.size + 36
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray(Charsets.US_ASCII))
      putInt(totalDataLen)
      put("WAVE".toByteArray(Charsets.US_ASCII))
      put("fmt ".toByteArray(Charsets.US_ASCII))
      putInt(16)
      putShort(1) // PCM
      putShort(channels.toShort())
      putInt(sampleRate)
      putInt(byteRate)
      putShort(blockAlign.toShort())
      putShort(bitsPerSample.toShort())
      put("data".toByteArray(Charsets.US_ASCII))
      putInt(pcmData.size)
    }.array()
    return header + pcmData
  }
}

/** Adaptive noise-floor Voice Activity Detector for hands-free voice input & real-time calls. */
internal class VoiceVadDetector(
  private val speechHoldMs: Long = 120L,
  private val silenceEndMs: Long = 1150L,
  private val maxUtteranceMs: Long = 28_000L,
) {
  private var noiseFloor = 0.008f
  private var speechOnsetAt = 0L
  private var lastSpeechAt = 0L
  private var startedAt = 0L
  var hasSpeech = false
    private set

  enum class Decision { CONTINUE, SPEECH_STARTED, SPEECH_ENDED }

  fun reset(nowMs: Long) {
    noiseFloor = 0.008f
    speechOnsetAt = 0L
    lastSpeechAt = 0L
    startedAt = nowMs
    hasSpeech = false
  }

  fun feed(rms: Float, nowMs: Long): Decision {
    if (startedAt == 0L) startedAt = nowMs
    val threshold = maxOf(0.022f, noiseFloor * 3.0f)
    if (rms > threshold) {
      if (speechOnsetAt == 0L) speechOnsetAt = nowMs
      lastSpeechAt = nowMs
      if (!hasSpeech && nowMs - speechOnsetAt >= speechHoldMs) {
        hasSpeech = true
        return Decision.SPEECH_STARTED
      }
    } else {
      if (!hasSpeech) noiseFloor = (noiseFloor * 0.94f + rms.coerceAtMost(0.025f) * 0.06f).coerceIn(0.004f, 0.025f)
      if (nowMs - lastSpeechAt > 200L) speechOnsetAt = 0L
    }
    if (hasSpeech && lastSpeechAt > 0L && nowMs - lastSpeechAt >= silenceEndMs) {
      return Decision.SPEECH_ENDED
    }
    if (nowMs - startedAt >= maxUtteranceMs) {
      return if (hasSpeech) Decision.SPEECH_ENDED else Decision.CONTINUE
    }
    return Decision.CONTINUE
  }
}

/** Capability selection is shared by preflight and capture; an unavailable cloud is never a fallback. */
internal fun chooseVoiceEngine(preferred: String, system: Boolean, cloud: Boolean, offline: Boolean = false): String? = when (preferred) {
  "cloud" -> if (cloud) "cloud" else null
  "system" -> if (system) "system" else null
  "offline" -> if (offline) "offline" else null
  else -> if (offline) "offline" else if (cloud) "cloud" else if (system) "system" else null
}

/** One immutable callback set per capture. Retired recognizers and HTTP responses cannot finish a newer turn. */
internal class VoiceRecognizerController(
  private val context: Context,
  private val scope: CoroutineScope,
  private val connection: () -> CloudConnection?,
  private val isCloudAsrAvailable: () -> Boolean,
  private val systemSpeech: SystemSpeechPlatform = AndroidSystemSpeechPlatform(context),
  private val systemPreference: () -> String = { "auto" },
  private val onSystemStatus: (String) -> Unit = {},
  private val onActivity: (Boolean) -> Unit = {},
  private val offlineSpeech: OfflineSpeechPlatform? = null,
) {
  companion object {
    const val MODE_AUTO = "auto"
    const val MODE_CLOUD = "cloud"
    const val MODE_SYSTEM = "system"
    const val MODE_OFFLINE = "offline"
    private const val SAMPLE_RATE = 16000
  }
  private class Session(
    val mode: String, val silenceMs: Long,
    val state: (String) -> Unit, val level: (Float) -> Unit,
    val partial: (String) -> Unit, val final: (String) -> Unit, val error: (String, String) -> Unit,
  ) {
    @Volatile var stopped = false
    @Volatile var finish = false
    @Volatile var recorder: AudioRecord? = null
    var recognizer: SpeechRecognizer? = null
    var job: Job? = null
    var request: okhttp3.Call? = null
    var watchdog: Runnable? = null
    var latest = ""
  }
  private val main = Handler(Looper.getMainLooper())
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .connectTimeout(12, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS).build()
  @Volatile private var current: Session? = null
  private val offlineCaptureMutex = Mutex()
  val isActive: Boolean get() = current != null
  private fun owns(s: Session) = current === s && !s.stopped
  private fun systemAvailable() = systemSpeech.catalog().candidates(systemPreference()).isNotEmpty()
  fun available(preferred: String): Boolean = chooseVoiceEngine(preferred, systemAvailable(), isCloudAsrAvailable(), offlineSpeech?.available() == true) != null

  fun start(preferredMode: String = MODE_AUTO, silenceEndMs: Long = 1300L,
    onState: (String) -> Unit, onLevel: (Float) -> Unit, onPartial: (String) -> Unit,
    onFinal: (String) -> Unit, onError: (String, String) -> Unit,
  ) {
    cancel()
    val mode = chooseVoiceEngine(preferredMode,
      systemAvailable(), isCloudAsrAvailable(), offlineSpeech?.available() == true)
    if (mode == null) {
      val message = when (preferredMode) {
        MODE_OFFLINE -> "请先在「保活」中下载本地离线识别模型。"
        MODE_CLOUD -> "服务器尚未启用语音识别，可在语音设置切换本地或系统识别。"
        else -> "手机未提供可调用的系统识别服务，或所选服务已不可用。请在「保活」下载本地离线模型，或检测系统服务。"
      }
      onSystemStatus(message)
      onError("ASR_NOT_AVAILABLE", message)
      return
    }
    val s = Session(mode, silenceEndMs, onState, onLevel, onPartial, onFinal, onError)
    current = s
    onActivity(true)
    onState("starting")
    when (mode) {
      MODE_OFFLINE -> startOffline(s)
      MODE_CLOUD -> startCloud(s)
      else -> startSystem(s, preferredMode == MODE_AUTO)
    }
  }
  fun cancel(reason: String = "识别已取消") {
    val s = current ?: return
    current = null; s.stopped = true
    onActivity(false)
    if (s.mode == MODE_SYSTEM) onSystemStatus(reason)
    s.request?.cancel()
    runCatching { s.recorder?.stop() }
    s.job?.cancel()
    destroySystem(s)
    s.level(0f)
  }
  private fun destroySystem(s: Session) {
    s.watchdog?.let(main::removeCallbacks); s.watchdog = null
    val recognizer = s.recognizer; s.recognizer = null
    // Capture the retired instance, never access a new session's recognizer from a posted cleanup.
    val cleanup = Runnable { runCatching { recognizer?.cancel() }; runCatching { recognizer?.destroy() } }
    if (Looper.myLooper() == Looper.getMainLooper()) cleanup.run() else main.post(cleanup)
  }
  private fun finish(s: Session, text: String = "", code: String = "NO_SPEECH", message: String = "没有听清，请再说一次。") {
    if (!owns(s)) return
    current = null; s.stopped = true
    onActivity(false)
    if (s.mode == MODE_SYSTEM) onSystemStatus(if (text.isNotBlank()) "系统识别已完成" else "识别已结束：$message（$code）")
    destroySystem(s); s.level(0f)
    if (text.isNotBlank()) s.final(text.trim()) else s.error(code, message)
  }
  private fun watchdog(s: Session, timeout: Long, action: () -> Unit) {
    s.watchdog?.let(main::removeCallbacks)
    s.watchdog = Runnable { if (owns(s)) action() }.also { main.postDelayed(it, timeout) }
  }
  fun finishNow() {
    val s = current ?: return
    s.finish = true
    if (s.mode == MODE_SYSTEM) {
      if (s.recognizer == null) { finish(s, s.latest); return }
      runCatching { s.recognizer?.stopListening() }
      watchdog(s, 2000) { finish(s, s.latest) }
    }
  }
  private fun startSystem(s: Session, fallback: Boolean) {
    // Only the OS default/on-device services are selected automatically. Other installed services need an explicit choice.
    val attempts = systemSpeech.catalog().attempts(systemPreference())
    startSystemAttempt(s, fallback, attempts, 0)
  }
  private fun startSystemAttempt(s: Session, fallback: Boolean, attempts: List<SystemSpeechTarget>, index: Int) {
    main.post {
      if (!owns(s) || s.finish) return@post
      val target = attempts.getOrNull(index) ?: run {
        finish(s, code = "NO_SYSTEM_ASR", message = "没有可用的系统语音识别服务，请在「保活」中检测服务。"); return@post
      }
      val sr = runCatching { systemSpeech.create(target) }.getOrNull()
      // A retired service must not deliver callbacks or timeouts into its replacement in the same capture.
      fun active() = owns(s) && s.recognizer === sr && sr != null
      fun fail(code: String, message: String) {
        if (!owns(s)) return
        onSystemStatus("${target.label}：$message（$code）")
        if (s.finish) { finish(s, s.latest, code, message); return }
        val terminal = code in setOf("MIC_PERMISSION", "MIC_UNAVAILABLE")
        if (!terminal && index + 1 < attempts.size) {
          destroySystem(s)
          s.level(0f); s.state("starting")
          onSystemStatus("${target.label}未完成识别，正在重试${attempts[index + 1].label}…")
          main.postDelayed({ if (owns(s) && !s.finish) startSystemAttempt(s, fallback, attempts, index + 1) }, 350)
        } else if (!terminal && fallback && isCloudAsrAvailable()) {
          destroySystem(s)
          // A new capture has its own mode and callback ownership, including finishNow().
          start(MODE_CLOUD, s.silenceMs, s.state, s.level, s.partial, s.final, s.error)
        } else finish(s, code = code, message = message)
      }
      if (sr == null) { fail("NO_SYSTEM_ASR", "无法创建${target.label}。"); return@post }
      s.recognizer = sr
      if (index > 0) { s.latest = ""; s.partial("") }
      var capturing = false
      var ending = false
      fun captureStarted() {
        if (!active() || capturing || ending || s.finish) return
        capturing = true
        s.state("listening")
        onSystemStatus("${target.label}已响应，正在收音")
        watchdog(s, 32000) { if (active()) {
          ending = true; s.finish = true; s.state("transcribing")
          runCatching { sr.stopListening() }; watchdog(s, 2000) { if (active()) finish(s, s.latest) }
        } }
      }
      onSystemStatus("正在启动${target.label}（第 ${index + 1}/${attempts.size} 次）…")
      watchdog(s, 12000) { if (active()) fail("ASR_START_TIMEOUT", "${target.label}未返回识别状态。请在「保活」中检测或更换系统服务；输入法语音输入也可用于文字聊天。") }
      val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = captureStarted()
        override fun onBeginningOfSpeech() = captureStarted()
        override fun onRmsChanged(rmsdB: Float) { if (active()) { captureStarted(); s.level(if (rmsdB.isFinite()) ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) else 0f) } }
        override fun onBufferReceived(buffer: ByteArray?) { if (buffer != null && buffer.isNotEmpty()) captureStarted() }
        override fun onEndOfSpeech() { if (active()) { ending = true; s.level(0f); s.state("transcribing"); onSystemStatus("${target.label}正在转写")
          watchdog(s, 6000) { if (active()) finish(s, s.latest, "ASR_TIMEOUT", "系统服务已收音，但没有返回文字，请重试或更换系统服务。") }
        } }
        override fun onPartialResults(results: Bundle?) {
          if (!active()) return
          captureStarted()
          val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
          if (text.isNotBlank()) { s.latest = text; s.partial(text) }
        }
        override fun onResults(results: Bundle?) { if (active()) {
          onSystemStatus("${target.label}已返回识别结果")
          finish(s, results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().ifBlank { s.latest })
        } }
        override fun onError(error: Int) {
          if (!active()) return
          when (error) {
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_NO_MATCH -> finish(s, s.latest)
            else -> systemSpeechError(error).let { (code, message) -> fail(code, message) }
          }
        }
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
      }
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, s.silenceMs)
      }
      runCatching { sr.setRecognitionListener(listener); sr.startListening(intent) }.onFailure {
        fail(if (it is SecurityException) "MIC_PERMISSION" else "ASR_START_FAILED", if (it is SecurityException) "系统未允许语音服务访问麦克风，请检查应用权限和系统麦克风开关。" else "无法启动${target.label}。")
      }
    }
  }
  @SuppressLint("MissingPermission")
  private fun startOffline(s: Session) {
    s.job = scope.launch(Dispatchers.IO) {
      try { offlineCaptureMutex.withLock {
        if (!owns(s)) return@withLock
        if (s.finish) { withContext(Dispatchers.Main) { finish(s, s.latest) }; return@withLock }
        val capture = requireNotNull(offlineSpeech).open()
        var recorder: AudioRecord? = null
        try {
          if (!owns(s)) return@withLock
          if (s.finish) { withContext(Dispatchers.Main) { finish(s, s.latest) }; return@withLock }
          val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
          check(minimum > 0)
          recorder = listOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC).firstNotNullOfOrNull { source ->
            runCatching { AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum * 4, SAMPLE_RATE * 4)) }.getOrNull()?.let {
              if (it.state == AudioRecord.STATE_INITIALIZED) it else { it.release(); null }
            }
          } ?: throw IllegalStateException("麦克风无法录音，请检查权限及音频占用。")
          val rec = recorder
          s.recorder = rec
          if (!owns(s)) return@withLock
          rec.startRecording()
          withContext(Dispatchers.Main) { if (owns(s)) s.state("listening") }
          val buffer = ShortArray(640)
          val started = android.os.SystemClock.elapsedRealtime()
          val vad = VoiceVadDetector(silenceEndMs = s.silenceMs).also { it.reset(started) }
          var samples = 0
          while (isActive && owns(s) && !s.finish) {
            val count = rec.read(buffer, 0, buffer.size)
            if (count < 0) throw IllegalStateException("麦克风录音中断，请重试。")
            if (count == 0) continue
            samples += count
            val rms = WavEncoder.pcm16Rms(buffer, count)
            val result = capture.accept(buffer, count)
            withContext(Dispatchers.Main) { if (owns(s)) {
              s.level((rms * 5.5f).coerceIn(0f, 1f))
              if (result.text.isNotBlank() && result.text != s.latest) { s.latest = result.text; s.partial(result.text) }
            } }
            val now = android.os.SystemClock.elapsedRealtime()
            val ended = vad.feed(rms, now) == VoiceVadDetector.Decision.SPEECH_ENDED
            if ((result.text.isNotBlank() && (ended || (result.endpoint && !vad.hasSpeech))) || (result.text.isBlank() && now - started > 12000) || samples >= SAMPLE_RATE * 30) break
          }
          if (!owns(s)) return@withLock
          rec.stop(); s.recorder = null
          withContext(Dispatchers.Main) { if (owns(s)) { s.level(0f); s.state("transcribing") } }
          val text = capture.finish().ifBlank { s.latest }
          withContext(Dispatchers.Main) { finish(s, text) }
        } finally {
          s.recorder = null
          runCatching { recorder?.stop() }; recorder?.release(); capture.close()
        }
      } } catch (error: kotlinx.coroutines.CancellationException) { throw error }
      catch (_: LinkageError) { withContext(Dispatchers.Main) { finish(s, code = "OFFLINE_RUNTIME_UNAVAILABLE", message = "当前安装包无法加载本地识别引擎，请更新安装包。") } }
      catch (error: Exception) { withContext(Dispatchers.Main) { finish(s, code = "OFFLINE_ASR_FAILED", message = error.message?.take(140) ?: "本地语音识别失败，请重试或重新下载模型。") } }
    }
  }
  @SuppressLint("MissingPermission")
  private fun startCloud(s: Session) {
    s.job = scope.launch(Dispatchers.IO) {
      try {
        val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(min > 0)
        val rec = listOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.MIC).firstNotNullOfOrNull { source ->
          runCatching { AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min * 2, 6400)) }.getOrNull()?.let {
            if (it.state == AudioRecord.STATE_INITIALIZED) it else { it.release(); null }
          }
        } ?: throw IllegalStateException("Microphone unavailable")
        s.recorder = rec
        val aec = runCatching { if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true } else null }.getOrNull()
        val ns = runCatching { if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } else null }.getOrNull()
        val pcm = ByteArrayOutputStream(SAMPLE_RATE * 2 * 6)
        val buf = ShortArray(640)
        val vad = VoiceVadDetector(silenceEndMs = s.silenceMs)
        val started = android.os.SystemClock.elapsedRealtime(); vad.reset(started)
        try {
          if (!owns(s)) return@launch
          rec.startRecording()
          withContext(Dispatchers.Main) { if (owns(s)) s.state("listening") }
          while (isActive && owns(s) && !s.finish) {
            val n = rec.read(buf, 0, buf.size)
            if (n < 0) throw IllegalStateException("Recording failed")
            if (n == 0) continue
            val rms = WavEncoder.pcm16Rms(buf, n)
            val bytes = ByteArray(n * 2)
            for (i in 0 until n) { bytes[i * 2] = buf[i].toByte(); bytes[i * 2 + 1] = (buf[i].toInt() shr 8).toByte() }
            pcm.write(bytes)
            withContext(Dispatchers.Main) { if (owns(s)) s.level((rms * 5.5f).coerceIn(0f, 1f)) }
            val now = android.os.SystemClock.elapsedRealtime()
            if (vad.feed(rms, now) == VoiceVadDetector.Decision.SPEECH_ENDED || (!vad.hasSpeech && now - started > 12000) || pcm.size() >= SAMPLE_RATE * 2 * 30) break
          }
        } finally {
          s.recorder = null
          runCatching { rec.stop() }; aec?.release(); ns?.release(); rec.release()
        }
        if (!owns(s)) return@launch
        if ((!vad.hasSpeech && !s.finish) || pcm.size() < SAMPLE_RATE) {
          withContext(Dispatchers.Main) { finish(s) }; return@launch
        }
        withContext(Dispatchers.Main) { if (owns(s)) { s.level(0f); s.state("transcribing") } }
        val conn = connection() ?: throw IllegalStateException("Not connected")
        val body = jsonObject("audio_base64" to str(Base64.encodeToString(WavEncoder.encodePcm16Mono(pcm.toByteArray()), Base64.NO_WRAP)),
          "format" to str("wav"), "language" to str("zh")).toString().toRequestBody("application/json".toMediaType())
        val request = http.newCall(Request.Builder().url(conn.server + "/model/v1/audio/transcriptions")
          .header("Authorization", "Bearer ${conn.token}").post(body).build())
        s.request = request
        if (!owns(s)) { request.cancel(); return@launch }
        val result = request.execute().use { res ->
          val obj = runCatching { linkJson.parseToJsonElement(res.body.string()).jsonObject }.getOrNull()
          if (res.isSuccessful && obj != null) Triple(obj.text("text"), "NO_SPEECH", "没有识别到说话内容。") else {
            val error = obj?.get("error") as? JsonObject
            Triple("", error?.text("code").orEmpty().ifBlank { "HTTP_${res.code}" },
              if (res.code == 503) "服务器尚未启用语音识别，请配置 ASR 服务或切换系统识别。" else "语音识别服务暂时不可用，请重试。")
          }
        }
        withContext(Dispatchers.Main) { finish(s, result.first, result.second, result.third) }
      } catch (e: kotlinx.coroutines.CancellationException) { throw e }
      catch (e: Exception) {
        withContext(Dispatchers.Main) { finish(s, code = if (e is java.io.IOException) "TRANSPORT_ERROR" else "MIC_UNAVAILABLE",
          message = if (e is java.io.IOException) "语音上传失败，请检查网络后重试。" else "麦克风无法录音，请检查权限及音频占用。") }
      }
    }
  }
}
