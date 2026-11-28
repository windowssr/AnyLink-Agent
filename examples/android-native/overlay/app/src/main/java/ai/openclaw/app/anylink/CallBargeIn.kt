package ai.openclaw.app.anylink

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** The model is downloaded separately, hash pinned, and never placed in an APK or Git. */
internal class CallVadModel(context: Context, scope: CoroutineScope) {
  companion object {
    val spec = OfflineModelFile("silero_vad.onnx", 643854, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")
    const val URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
  }
  val file = File(context.filesDir, "call-vad/${spec.sha256.take(12)}/${spec.name}")
  val state = MutableStateFlow("正在检查语音检测模型")
  @Volatile var ready = false; private set
  private val mutex = Mutex()
  private val refresh = scope.launch(Dispatchers.IO) {
    ready = verifyOfflineModelFile(file, spec); state.value = if (ready) "本地语音检测已就绪" else "首次使用需下载 629 KB 语音检测模型"
  }
  suspend fun prepare() = withContext(Dispatchers.IO) { refresh.join(); mutex.withLock {
    if (ready) return@withLock
    state.value = "正在下载语音检测模型…"
    val temporary = File(file.path + ".pending")
    val http = OkHttpClient.Builder().callTimeout(45, java.util.concurrent.TimeUnit.SECONDS).build()
    try {
      file.parentFile!!.mkdirs()
      val call = http.newCall(Request.Builder().url(URL).build())
      val cancellation = kotlinx.coroutines.currentCoroutineContext()[Job]!!.invokeOnCompletion { if (it != null) call.cancel() }
      try { call.execute().use { response ->
        check(response.isSuccessful && response.request.url.isHttps) { "语音检测模型下载失败" }
        response.body.byteStream().use { input -> temporary.outputStream().use { output ->
          val buffer = ByteArray(16384); var total = 0L
          while (true) {
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            val count = input.read(buffer); if (count < 0) break
            total += count; check(total <= spec.bytes) { "语音检测模型大小异常" }; output.write(buffer, 0, count)
          }
        } }
      } } finally { cancellation.dispose() }
      check(verifyOfflineModelFile(temporary, spec)) { "语音检测模型校验失败" }
      check(temporary.renameTo(file)) { "无法保存语音检测模型" }
      ready = true; state.value = "本地语音检测已就绪"
    } catch (e: CancellationException) { throw e }
    catch (_: Exception) { state.value = "语音检测模型未就绪，可点按人物插话，稍后重试下载。" }
    finally { temporary.delete(); http.dispatcher.executorService.shutdown(); http.connectionPool.evictAll() }
  } }
}

internal fun speechLetters(text: String) = text.filter { it.isLetterOrDigit() }.lowercase()

/** Text evidence supplements acoustic echo cancellation; volume alone never stops a reply. */
internal fun isPlaybackEcho(text: String, playback: String): Boolean {
  val heard = speechLetters(text); val spoken = speechLetters(playback)
  if (heard.length < 3 || spoken.isEmpty()) return false
  if (spoken.contains(heard)) return true
  // A single ASR typo in a longer echo should not turn the assistant's voice into user input.
  if (heard.length < 5) return false
  return spoken.windowed(heard.length, 1).any { candidate -> heard.indices.count { heard[it] == candidate[it] } >= (heard.length * .8).toInt().coerceAtLeast(4) }
}

internal class BargeInGate {
  var voicedMs = 0; private set
  var quietMs = 0; private set
  var confirmed = false; private set
  var ducked = false; private set
  private var interrupted = false
  fun feed(voiced: Boolean, text: String, assistantBusy: Boolean, echoGuard: Boolean, playback: String, overlapAllowed: Boolean): String {
    if (voiced) { voicedMs += 32; quietMs = 0 } else quietMs += 32
    if (quietMs >= 160) voicedMs = 0
    if (echoGuard && isPlaybackEcho(text, playback)) return "echo"
    if (confirmed && (!assistantBusy || interrupted)) return "continue"
    if (!assistantBusy && !echoGuard) { confirmed = true; return "accept" }
    if (!overlapAllowed) return "blocked"
    if (voicedMs >= 320 && speechLetters(text).length >= 2 && quietMs < 192) { confirmed = true; interrupted = true; return "interrupt" }
    if (!ducked && voicedMs >= 160 && speechLetters(text).isNotEmpty()) { ducked = true; return "duck" }
    return "wait"
  }
}

internal data class CallListenContext(val assistantBusy: Boolean, val playing: Boolean, val playback: String, val speaker: Boolean)

/** A single microphone remains open for the whole call. Cancellation releases it, never a second reader. */
internal class DuplexCallCapture(private val scope: CoroutineScope, private val speech: OfflineSpeechPlatform, private val model: CallVadModel) {
  private val mutex = Mutex()
  private var job: Job? = null
  @Volatile private var recorder: AudioRecord? = null
  private var epoch = 0
  val active get() = job?.isActive == true
  fun stop() { epoch++; job?.cancel(); job = null; runCatching { recorder?.stop() } }

  @SuppressLint("MissingPermission")
  fun start(context: () -> CallListenContext, onReady: (Boolean, Boolean) -> Unit, onDuck: (Boolean) -> Unit,
    onInterrupt: () -> Unit, onPartial: (String) -> Unit, onFinal: (String) -> Unit, onLevel: (Float) -> Unit,
    onDiagnostic: (String) -> Unit, onError: () -> Unit) {
    stop(); val stamp = epoch
    job = scope.launch(Dispatchers.IO) { mutex.withLock {
      var rec: AudioRecord? = null; var aec: AcousticEchoCanceler? = null; var ns: NoiseSuppressor? = null
      var vad: Vad? = null; var capture: OfflineSpeechCapture? = null
      suspend fun main(block: () -> Unit) = withContext(Dispatchers.Main.immediate) { if (stamp == epoch) block() }
      try {
        ensureActive()
        val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0)
        rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum * 4, 16000))
        check(rec.state == AudioRecord.STATE_INITIALIZED)
        recorder = rec
        aec = runCatching { AcousticEchoCanceler.create(rec.audioSessionId)?.also { it.enabled = true } }.getOrNull()
        ns = runCatching { NoiseSuppressor.create(rec.audioSessionId)?.also { it.enabled = true } }.getOrNull()
        val echoCancelled = aec?.enabled == true
        vad = Vad(config = VadModelConfig(sileroVadModelConfig = SileroVadModelConfig(model = model.file.path, windowSize = 512), numThreads = 1))
        speech.open().close() // Load the recognizer before recording, so cold model loading cannot drop input.
        ensureActive()
        rec.startRecording(); check(rec.recordingState == AudioRecord.RECORDSTATE_RECORDING)
        main { onReady(echoCancelled, ns?.enabled == true) }
        val buffer = ShortArray(512); val ring = ArrayDeque<ShortArray>()
        var frame = 0L; var speechRun = 0; var rejectUntilQuiet = false; var quietRun = 0
        var gate = BargeInGate(); var started = 0L; var duckedAt = -1L; var lastText = ""; var lastPlayback = -100L
        while (isActive && stamp == epoch) {
          var count = 0
          while (count < buffer.size && isActive) {
            val n = rec.read(buffer, count, buffer.size - count); check(n >= 0) { "MIC_READ_FAILED" }; if (n > 0) count += n
          }
          ensureActive(); frame++
          val state = withContext(Dispatchers.Main.immediate) { context() }
          if (state.playing) lastPlayback = frame
          val echoGuard = state.playing || frame - lastPlayback < 13 // 416 ms acoustic tail.
          val rms = WavEncoder.pcm16Rms(buffer, count)
          val voiced = vad.compute(FloatArray(512) { buffer[it] / 32768f }) >= .65f && rms >= .004f
          quietRun = if (voiced) 0 else quietRun + 1
          if (quietRun >= 8) rejectUntilQuiet = false
          ring.addLast(buffer.copyOf()); if (ring.size > 13) ring.removeFirst() // 416 ms preroll, RAM only.
          val overlapAllowed = !state.speaker || echoCancelled
          main { onLevel(if (state.assistantBusy && capture == null) 0f else (rms * 5.5f).coerceIn(0f, 1f)) }
          if (capture == null) {
            speechRun = if (voiced) speechRun + 1 else 0
            if (rejectUntilQuiet || speechRun < 3 || ((state.assistantBusy || echoGuard) && !overlapAllowed)) continue
            capture = speech.open(); gate = BargeInGate(); started = frame; duckedAt = -1; lastText = ""
            for (chunk in ring) lastText = capture.accept(chunk, chunk.size).text
            ring.clear()
          } else lastText = capture.accept(buffer, count).text
          when (gate.feed(voiced, lastText, state.assistantBusy, echoGuard, state.playback, overlapAllowed)) {
            "duck" -> { duckedAt = frame; main { onDuck(true); onDiagnostic("candidate") } }
            "interrupt" -> main { onDuck(false); onDiagnostic("confirmed"); onInterrupt() }
            "echo" -> {
              capture.close(); capture = null; rejectUntilQuiet = true; speechRun = 0; ring.clear()
              main { onDuck(false); onDiagnostic("echo_rejected") }; continue
            }
          }
          if (duckedAt >= 0 && !gate.confirmed && frame - duckedAt >= 10) {
            duckedAt = -1; main { onDuck(false); onDiagnostic("candidate_restored") }
          }
          if (gate.confirmed && lastText.isNotBlank()) main { onPartial(lastText) }
          val done = gate.quietMs >= 704 || frame - started >= 875 || (!gate.confirmed && frame - started >= 63)
          if (done) {
            val text = if (gate.confirmed) capture.finish().ifBlank { lastText } else ""
            capture.close(); capture = null; speechRun = 0; ring.clear()
            val accepted = text.isNotBlank() && !(echoGuard && isPlaybackEcho(text, state.playback))
            main { onDuck(false); if (accepted) { onDiagnostic("utterance"); onFinal(text) } else onDiagnostic("noise_rejected") }
          }
        }
      } catch (e: CancellationException) { throw e }
      catch (_: Exception) { main { onDuck(false); onError() } }
      catch (_: LinkageError) { main { onDuck(false); onError() } }
      finally {
        capture?.close(); vad?.release(); runCatching { rec?.stop() }; aec?.release(); ns?.release(); rec?.release()
        if (recorder === rec) recorder = null
      }
    } }
  }
}
