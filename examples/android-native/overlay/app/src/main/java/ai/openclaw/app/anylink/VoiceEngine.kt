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

/** Dual-engine Android voice input controller:
 * 1) Online/OEM-friendly SpeechRecognizer (without forcing broken offline packs), AND
 * 2) Universal AudioRecord (16 kHz PCM16 + AEC + NS + adaptive VAD) -> /model/v1/audio/transcriptions.
 * Automatically falls back from System -> Cloud on Chinese ROMs lacking GMS SpeechRecognizer. */
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

  private val main = Handler(Looper.getMainLooper())
  private val http = OkHttpClient.Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(35, TimeUnit.SECONDS)
    .callTimeout(40, TimeUnit.SECONDS)
    .build()

  private var recognizer: SpeechRecognizer? = null
  private var recordJob: Job? = null
  @Volatile private var cloudStopRequested = false
  @Volatile private var active = false
  private var activeMode = MODE_SYSTEM
  private var currentOnPartial: ((String) -> Unit)? = null
  private var currentOnFinal: ((String) -> Unit)? = null
  private var currentOnLevel: ((Float) -> Unit)? = null
  private var currentOnError: ((String, String) -> Unit)? = null
  private var currentOnState: ((String) -> Unit)? = null
  private var currentSilenceMs: Long = 1300L
  private var latestPartial = ""

  fun start(
    preferredMode: String = MODE_AUTO,
    silenceEndMs: Long = 1300L,
    onState: (String) -> Unit,
    onLevel: (Float) -> Unit,
    onPartial: (String) -> Unit,
    onFinal: (String) -> Unit,
    onError: (String, String) -> Unit,
  ) {
    cancel()
    active = true
    latestPartial = ""
    currentSilenceMs = silenceEndMs
    currentOnState = onState
    currentOnLevel = onLevel
    currentOnPartial = onPartial
    currentOnFinal = onFinal
    currentOnError = onError

    val systemAvailable = runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false)
    val cloudAvailable = isCloudAsrAvailable()
    val chosen = when (preferredMode) {
      MODE_CLOUD -> MODE_CLOUD
      MODE_SYSTEM -> MODE_SYSTEM
      else -> when {
        cloudAvailable && !systemAvailable -> MODE_CLOUD
        systemAvailable -> MODE_SYSTEM
        else -> MODE_CLOUD
      }
    }
    if (chosen == MODE_CLOUD) {
      startCloudRecording(silenceEndMs)
    } else {
      startSystemRecognizer(allowCloudFallback = preferredMode == MODE_AUTO)
    }
  }

  /** Immediately stop capturing and finalize/transcribe whatever the user already said. */
  fun finishNow() {
    if (!active) return
    if (activeMode == MODE_CLOUD) {
      cloudStopRequested = true
    } else {
      main.post {
        runCatching { recognizer?.stopListening() }
        // If system recognizer doesn't return onResults promptly, deliver any captured partial.
        val snap = latestPartial.trim()
        if (snap.isNotBlank()) {
          main.postDelayed({
            if (active && latestPartial.trim() == snap) {
              val cb = currentOnFinal
              cancel()
              cb?.invoke(snap)
            }
          }, 900)
        }
      }
    }
  }

  fun cancel() {
    active = false
    cloudStopRequested = false
    recordJob?.cancel()
    recordJob = null
    main.post {
      runCatching { recognizer?.cancel() }
      runCatching { recognizer?.destroy() }
      recognizer = null
    }
    currentOnLevel?.invoke(0f)
  }

  private fun startSystemRecognizer(allowCloudFallback: Boolean) {
    activeMode = MODE_SYSTEM
    if (!runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false)) {
      if (allowCloudFallback) {
        startCloudRecording(currentSilenceMs)
      } else {
        active = false
        currentOnError?.invoke("NO_SYSTEM_ASR", "系统未安装语音识别服务，请切换为「云端识别」或在系统设置中启用语音输入服务。")
      }
      return
    }
    main.post {
      if (!active) return@post
      runCatching { recognizer?.destroy() }
      val sr = runCatching { SpeechRecognizer.createSpeechRecognizer(context) }.getOrNull()
      if (sr == null) {
        if (allowCloudFallback) startCloudRecording(currentSilenceMs)
        else { active = false; currentOnError?.invoke("NO_SYSTEM_ASR", "无法初始化系统语音识别服务") }
        return@post
      }
      recognizer = sr
      sr.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) { currentOnState?.invoke("listening") }
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) {
          val norm = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
          currentOnLevel?.invoke(norm)
        }
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() { currentOnState?.invoke("transcribing") }
        override fun onPartialResults(partialResults: Bundle?) {
          val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
          if (text.isNotBlank()) {
            latestPartial = text
            currentOnPartial?.invoke(text)
          }
        }
        override fun onResults(results: Bundle?) {
          if (!active) return
          val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().ifBlank { latestPartial }.trim()
          val onFinal = currentOnFinal
          val onError = currentOnError
          cancel()
          if (text.isNotBlank()) onFinal?.invoke(text) else onError?.invoke("NO_SPEECH", "没有听到说话内容，请再试一次。")
        }
        override fun onError(error: Int) {
          if (!active) return
          // If system recognizer already captured partial text before timing out, use it!
          val snap = latestPartial.trim()
          if (snap.isNotBlank() && (error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT || error == SpeechRecognizer.ERROR_NO_MATCH)) {
            val cb = currentOnFinal
            cancel()
            cb?.invoke(snap)
            return
          }
          // Engine unavailable / GMS missing / client failure -> automatically fall back to universal AudioRecord + Cloud ASR!
          val engineBroken = error in setOf(
            SpeechRecognizer.ERROR_CLIENT,
            SpeechRecognizer.ERROR_SERVER,
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
            12, // ERROR_LANGUAGE_NOT_SUPPORTED
            13, // ERROR_LANGUAGE_UNAVAILABLE
          )
          if (allowCloudFallback && engineBroken) {
            runCatching { recognizer?.destroy() }; recognizer = null
            startCloudRecording(currentSilenceMs)
            return
          }
          val msg = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没听清哦，请靠近麦克风再说一遍。"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "请先授予麦克风权限。"
            SpeechRecognizer.ERROR_AUDIO -> "麦克风被其他应用占用，请稍后再试。"
            else -> "系统语音识别异常（错误码 $error），可在「保活」设置中切换云端语音识别。"
          }
          val code = if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) "NO_SPEECH" else "ASR_ERROR_$error"
          val cb = currentOnError
          cancel()
          cb?.invoke(code, msg)
        }
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
      })
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, currentSilenceMs)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, currentSilenceMs)
        // Do NOT force EXTRA_PREFER_OFFLINE = true: Chinese ROMs rarely bundle Google offline zh-CN packs.
      }
      runCatching { sr.startListening(intent) }.onFailure {
        if (allowCloudFallback) startCloudRecording(currentSilenceMs)
        else { active = false; currentOnError?.invoke("ASR_START_FAILED", "无法启动系统语音识别") }
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun startCloudRecording(silenceEndMs: Long) {
    activeMode = MODE_CLOUD
    cloudStopRequested = false
    recordJob?.cancel()
    recordJob = scope.launch(Dispatchers.IO) {
      val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minBuf <= 0) {
        withContext(Dispatchers.Main) {
          val cb = currentOnError; cancel(); cb?.invoke("MIC_UNAVAILABLE", "无法初始化手机麦克风录音")
        }
        return@launch
      }
      val rec = runCatching {
        AudioRecord(
          MediaRecorder.AudioSource.VOICE_COMMUNICATION,
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          maxOf(minBuf * 2, 6400),
        )
      }.getOrNull()
      if (rec == null || rec.state != AudioRecord.STATE_INITIALIZED) {
        runCatching { rec?.release() }
        withContext(Dispatchers.Main) {
          val cb = currentOnError; cancel(); cb?.invoke("MIC_UNAVAILABLE", "麦克风初始化失败，请检查录音权限")
        }
        return@launch
      }
      val aec = runCatching { if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true } else null }.getOrNull()
      val ns = runCatching { if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } else null }.getOrNull()
      val pcmOut = ByteArrayOutputStream(SAMPLE_RATE * 2 * 6)
      val vad = VoiceVadDetector(silenceEndMs = silenceEndMs)
      val buf = ShortArray(640) // 40 ms @ 16 kHz
      val startedMs = System.currentTimeMillis()
      vad.reset(startedMs)
      withContext(Dispatchers.Main) { currentOnState?.invoke("listening") }
      try {
        rec.startRecording()
        while (isActive && active && !cloudStopRequested) {
          val read = rec.read(buf, 0, buf.size)
          if (read <= 0) continue
          val rms = WavEncoder.pcm16Rms(buf, read)
          val normLevel = (rms * 5.5f).coerceIn(0f, 1f)
          val now = System.currentTimeMillis()
          // Append little-endian PCM16 bytes
          val bytes = ByteArray(read * 2)
          for (i in 0 until read) {
            val s = buf[i].toInt()
            bytes[i * 2] = (s and 0xFF).toByte()
            bytes[i * 2 + 1] = ((s ushr 8) and 0xFF).toByte()
          }
          pcmOut.write(bytes)
          withContext(Dispatchers.Main) { currentOnLevel?.invoke(normLevel) }
          val decision = vad.feed(rms, now)
          if (decision == VoiceVadDetector.Decision.SPEECH_ENDED) break
          if (!vad.hasSpeech && now - startedMs > 12_000L) break
          if (pcmOut.size() >= SAMPLE_RATE * 2 * 30) break // 30s safety cap
        }
      } finally {
        runCatching { rec.stop() }
        runCatching { aec?.release() }
        runCatching { ns?.release() }
        runCatching { rec.release() }
      }
      if (!active) return@launch
      val pcmBytes = pcmOut.toByteArray()
      if ((!vad.hasSpeech && !cloudStopRequested) || pcmBytes.size < SAMPLE_RATE) {
        withContext(Dispatchers.Main) {
          val cb = currentOnError; cancel(); cb?.invoke("NO_SPEECH", "没有检测到说话声音，请靠近麦克风再试。")
        }
        return@launch
      }
      withContext(Dispatchers.Main) {
        currentOnLevel?.invoke(0f)
        currentOnState?.invoke("transcribing")
      }
      val conn = connection()
      if (conn == null) {
        withContext(Dispatchers.Main) {
          val cb = currentOnError; cancel(); cb?.invoke("NOT_CONNECTED", "请先连接 AnyLink 服务器后再使用云端语音识别。")
        }
        return@launch
      }
      val wav = WavEncoder.encodePcm16Mono(pcmBytes, SAMPLE_RATE)
      val b64 = Base64.encodeToString(wav, Base64.NO_WRAP)
      val payload = jsonObject(
        "audio_base64" to str(b64),
        "format" to str("wav"),
        "language" to str("zh"),
      ).toString().toRequestBody("application/json".toMediaType())
      val result = runCatching {
        http.newCall(
          Request.Builder()
            .url(conn.server + "/model/v1/audio/transcriptions")
            .header("Authorization", "Bearer ${conn.token}")
            .post(payload)
            .build(),
        ).execute().use { res ->
          val raw = res.body.string()
          val parsed = runCatching { linkJson.parseToJsonElement(raw).jsonObject }.getOrNull()
          if (res.isSuccessful && parsed != null) {
            "OK" to parsed.text("text").trim()
          } else {
            val errObj = parsed?.get("error") as? JsonObject
            val code = errObj?.text("code").orEmpty().ifBlank { "HTTP_${res.code}" }
            val msg = errObj?.text("message").orEmpty().ifBlank { "云端语音识别失败（$code）" }
            code to msg
          }
        }
      }.getOrElse { "TRANSPORT_ERROR" to "语音上传失败，请检查网络连接。" }

      withContext(Dispatchers.Main) {
        if (!active) return@withContext
        val onFinal = currentOnFinal
        val onError = currentOnError
        cancel()
        if (result.first == "OK") {
          if (result.second.isNotBlank()) onFinal?.invoke(result.second)
          else onError?.invoke("NO_SPEECH", "没听清刚才说的话，请再说一次。")
        } else if (result.first == "ASR_NOT_CONFIGURED") {
          onError?.invoke(
            "ASR_NOT_CONFIGURED",
            "手机未安装系统语音识别，且云端暂未配置语音转文字密钥（在服务器配置 ANYLINK_ASR_API_KEY 即可支持所有国产手机语音输入与实时通话）。",
          )
        } else {
          onError?.invoke(result.first, result.second)
        }
      }
    }
  }
}
