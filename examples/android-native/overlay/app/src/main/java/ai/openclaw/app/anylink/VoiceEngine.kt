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
    val minimum = if (first) 8 else 18
    var end = -1
    for (i in 0 until pending.length) {
      val count = i + 1
      val ch = pending[i]
      if (ch in "。！？!?；;\n" || (count >= minimum && ch in "，,：:") || count >= 72) {
        end = i + 1
        break
      }
    }
    if (end < 0 && force && pending.isNotEmpty()) end = pending.length
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
internal fun chooseVoiceEngine(preferred: String, system: Boolean, cloud: Boolean): String? = when (preferred) {
  "cloud" -> if (cloud) "cloud" else null
  "system" -> if (system) "system" else null
  else -> if (cloud) "cloud" else if (system) "system" else null
}

/** One immutable callback set per capture. Retired recognizers and HTTP responses cannot finish a newer turn. */
internal class VoiceRecognizerController(
  private val context: Context,
  private val scope: CoroutineScope,
  private val connection: () -> CloudConnection?,
  private val isCloudAsrAvailable: () -> Boolean,
) {
  companion object {
    const val MODE_AUTO = "auto"
    const val MODE_CLOUD = "cloud"
    const val MODE_SYSTEM = "system"
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
  val isActive: Boolean get() = current != null
  private fun owns(s: Session) = current === s && !s.stopped
  fun available(preferred: String): Boolean = chooseVoiceEngine(preferred,
    runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false), isCloudAsrAvailable()) != null

  fun start(preferredMode: String = MODE_AUTO, silenceEndMs: Long = 1300L,
    onState: (String) -> Unit, onLevel: (Float) -> Unit, onPartial: (String) -> Unit,
    onFinal: (String) -> Unit, onError: (String, String) -> Unit,
  ) {
    cancel()
    val mode = chooseVoiceEngine(preferredMode,
      runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false), isCloudAsrAvailable())
    if (mode == null) {
      onError("ASR_NOT_AVAILABLE", if (preferredMode == MODE_CLOUD) "服务器尚未启用语音识别，可在语音设置切换系统识别。" else "手机没有可用的系统识别服务，服务器也尚未启用语音识别。请先配置识别服务。")
      return
    }
    val s = Session(mode, silenceEndMs, onState, onLevel, onPartial, onFinal, onError)
    current = s
    onState("starting")
    if (mode == MODE_CLOUD) startCloud(s) else startSystem(s, preferredMode == MODE_AUTO)
  }
  fun cancel() {
    val s = current ?: return
    current = null; s.stopped = true
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
    main.post { runCatching { recognizer?.cancel() }; runCatching { recognizer?.destroy() } }
  }
  private fun finish(s: Session, text: String = "", code: String = "NO_SPEECH", message: String = "没有听清，请再说一次。") {
    if (!owns(s)) return
    current = null; s.stopped = true
    destroySystem(s); s.level(0f)
    if (text.isNotBlank()) s.final(text.trim()) else s.error(code, message)
  }
  private fun watchdog(s: Session, timeout: Long, action: () -> Unit) {
    s.watchdog?.let(main::removeCallbacks)
    s.watchdog = Runnable { if (owns(s)) action() }.also { main.postDelayed(it, timeout) }
  }
  fun finishNow() {
    val s = current ?: return
    if (s.mode == MODE_CLOUD) s.finish = true else {
      runCatching { s.recognizer?.stopListening() }
      watchdog(s, 2000) { finish(s, s.latest) }
    }
  }
  private fun startSystem(s: Session, fallback: Boolean) {
    main.post {
      if (!owns(s)) return@post
      fun fail(code: String, message: String) {
        if (!owns(s)) return
        if (fallback && isCloudAsrAvailable()) {
          destroySystem(s)
          // A new capture has its own mode and callback ownership, including finishNow().
          start(MODE_CLOUD, s.silenceMs, s.state, s.level, s.partial, s.final, s.error)
        } else finish(s, code = code, message = message)
      }
      val sr = runCatching { SpeechRecognizer.createSpeechRecognizer(context) }.getOrNull()
      if (sr == null) { fail("NO_SYSTEM_ASR", "无法启动手机系统语音识别。"); return@post }
      s.recognizer = sr
      watchdog(s, 8000) { fail("ASR_START_TIMEOUT", "系统语音识别没有响应，请检查系统语音服务。") }
      sr.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
          if (!owns(s)) return
          s.state("listening")
          watchdog(s, 32000) { runCatching { sr.stopListening() }; watchdog(s, 2000) { finish(s, s.latest) } }
        }
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) { if (owns(s)) s.level(((rmsdB + 2f) / 12f).coerceIn(0f, 1f)) }
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() { if (owns(s)) { s.state("transcribing"); watchdog(s, 6000) { finish(s, s.latest, "ASR_TIMEOUT", "识别超时，请重试。") } } }
        override fun onPartialResults(results: Bundle?) {
          if (!owns(s)) return
          val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
          if (text.isNotBlank()) { s.latest = text; s.partial(text) }
        }
        override fun onResults(results: Bundle?) = finish(s,
          results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().ifBlank { s.latest })
        override fun onError(error: Int) {
          if (!owns(s)) return
          when (error) {
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_NO_MATCH -> finish(s, s.latest)
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> finish(s, code = "MIC_PERMISSION", message = "请授予麦克风权限后重试。")
            SpeechRecognizer.ERROR_AUDIO -> finish(s, code = "MIC_UNAVAILABLE", message = "麦克风无法录音，请检查是否被其他应用占用。")
            else -> fail("ASR_ERROR_$error", "系统识别暂时不可用，请检查语音服务或切换识别引擎。")
          }
        }
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
      })
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, s.silenceMs)
      }
      runCatching { sr.startListening(intent) }.onFailure { fail("ASR_START_FAILED", "无法启动系统语音识别。") }
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
