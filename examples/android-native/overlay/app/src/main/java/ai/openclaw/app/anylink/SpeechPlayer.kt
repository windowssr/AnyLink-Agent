package ai.openclaw.app.anylink

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.ArrayDeque
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Kotlin port of server/speech.ts sanitizeSpeech: voice must never read code,
 * tables, markdown, links or emoji. Keep the two implementations in sync. */
internal object SpeechSanitizer {
  private val codeFence = Regex("```[\\s\\S]*?```|~~~[\\s\\S]*?~~~")
  private val tableLine = Regex("^\\s*\\|.*\\|?\\s*$")
  private val separatorLine = Regex("^\\s*\\|?[\\s:|-]+\\|?\\s*$")
  private val url = Regex("(?:https?://|www\\.)\\S+", RegexOption.IGNORE_CASE)
  private val inlineCode = Regex("`[^`\\n]*`")
  private val heading = Regex("^\\s{0,3}#{1,6}\\s*", RegexOption.MULTILINE)
  private val quote = Regex("^\\s{0,3}>\\s?", RegexOption.MULTILINE)
  private val bullet = Regex("^\\s*(?:[-*+]|\\d{1,3}[.)])\\s+", RegexOption.MULTILINE)
  private val markers = Regex("[*_~|]")
  private val emoji = Regex("[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF\\uFE0F\\u200D\\u2B00-\\u2BFF]")
  fun clean(raw: String): String {
    var text = raw.replace(codeFence, " ")
    text = text.lines().filter { line ->
      val t = line.trim()
      t.isEmpty() || !(separatorLine.containsMatchIn(t) && t.contains('-')) && !tableLine.containsMatchIn(t)
    }.joinToString("\n")
    return text.replace(inlineCode, " ").replace(url, " ").replace(heading, "").replace(quote, "")
      .replace(bullet, "").replace(markers, "").replace(emoji, "")
      .replace(Regex("\\s+"), " ").trim()
  }
}

private data class Pending(val text: String, val summarize: Boolean, val forceRewrite: Boolean, val source: String, val turn: String, val queued: Long = android.os.SystemClock.elapsedRealtime())
internal data class SpeechPayload(val spoken: String?, val audio: String? = null, val format: String = "mp3", val provider: String = "system", val stream: PcmSpeechStream? = null, val requestId: String = "", val reason: String = "", val resolvedVoice: String = "") {
  companion object {
    fun parse(body: JsonObject): SpeechPayload = SpeechPayload(body.text("spoken_text"), body.text("audio_base64").takeIf { it.isNotBlank() },
      if (body.text("format") == "wav") "wav" else "mp3", if (body.text("provider") == "qwen") "qwen" else "microsoft", requestId = body.text("request_id"), reason = body.text("fallback_reason"), resolvedVoice = body.text("resolved_voice"))
  }
}
private data class PreparedSpeech(val file: File?, val spoken: String, val envelope: SpeechEnvelope, val provider: String, val stream: PcmSpeechStream?, val pending: Pending, val requestId: String, val resolvedVoice: String)

/** Fetches /model/v1/speech and plays WAV/MP3 with one-utterance lookahead;
 * A server failure preserves its spoken text for original system TTS. If no words came back,
 * a lightweight chat rewrite keeps local fallback brief and in character. */
internal class SpeechPlayer(
  private val context: Context,
  private val scope: CoroutineScope,
  private val connection: () -> CloudConnection?,
  private val synthesizeLocal: suspend (String) -> File?,
  private val onSpeaking: (Boolean) -> Unit,
  private val onIdle: () -> Unit = {},
  private val onLevel: (Float) -> Unit = {},
  private val onUtterance: (String) -> Unit = {},
  private val inCall: () -> Boolean = { false },
  private val onError: (String) -> Unit = {},
  private val beforePlayback: () -> Boolean = { true },
  private val onVoice: (String) -> Unit = {},
  private val createPlayer: () -> MediaPlayer = { MediaPlayer() },
  private val createPcmOutput: (Int, Boolean) -> PcmOutput = { rate, call -> AndroidPcmOutput(rate, call) },
  private val onDiagnostic: (JsonObject) -> Unit = {},
  private val onPlaybackText: (String, String) -> Unit = { _, _ -> },
  private val localVoice: () -> String = { "system-default" },
) {
  private val http = AnyLinkHttp.builder().followRedirects(false).followSslRedirects(false).callTimeout(45000, java.util.concurrent.TimeUnit.MILLISECONDS).build()
  private val json = Json { ignoreUnknownKeys = true }
  private val main = Handler(Looper.getMainLooper())
  private val pending = ArrayDeque<Pending>()
  private val deferred = ArrayDeque<Pending>()
  private val providers = java.util.concurrent.ConcurrentHashMap<String, String>()
  private val streams = java.util.Collections.synchronizedSet(mutableSetOf<PcmSpeechStream>())
  private var pcmOutput: PcmOutput? = null
  private var pcmJob: Job? = null
  private var player: MediaPlayer? = null
  private var busy = false
  private var epoch = 0
  private var fetchJob: Job? = null
  private var prepared: PreparedSpeech? = null
  private var currentFile: File? = null
  private var levelTick: Runnable? = null
  val isActive: Boolean get() = busy || pending.isNotEmpty() || fetchJob != null || prepared != null

  fun enqueue(text: String, summarize: Boolean, interrupt: Boolean, forceRewrite: Boolean = false, source: String = "chat", turn: String = UUID.randomUUID().toString()) {
    if (text.isBlank()) return
    val next = Pending(text, summarize, forceRewrite, source, turn)
    if (inCall() && source == "notification") { if (deferred.size >= 32) deferred.pollFirst(); deferred.addLast(next); return }
    if (interrupt) interrupt()
    pending.addLast(next); pump()
  }
  fun releaseDeferred() { if (!inCall()) { while (deferred.isNotEmpty()) pending.addLast(deferred.removeFirst()); pump() } }
  fun interrupt() {
    epoch++; pending.clear(); fetchJob?.cancel(); fetchJob = null
    prepared?.file?.delete(); prepared?.stream?.cancel(); prepared = null
    synchronized(streams) { streams.toList() }.forEach { it.cancel() }; streams.clear()
    http.dispatcher.cancelAll()
    stopPlayer(); busy = false
  }
  private fun pump() {
    if (!busy) prepared?.let { ready ->
      prepared = null; busy = true
      if (ready.stream != null) playPcm(ready, epoch)
      else play(ready.file!!, ready.spoken, ready.envelope, epoch, ready.provider, ready.pending, ready.requestId, ready.resolvedVoice)
    }
    // Fetch at most one next utterance while the active one plays. No pose/voice callbacks until playback.
    if (fetchJob != null || prepared != null) return
    val next = pending.pollFirst() ?: run { if (!busy) onIdle(); return }
    val stamp = epoch
    fetchJob = scope.launch(start = CoroutineStart.LAZY) {
      var file: File? = null
      try {
        val payload = fetch(next)
        val actualProvider = if (payload.audio != null || payload.stream != null) payload.provider else "system"
        trace(next, actualProvider, payload.requestId, "received", payload.reason, payload.stream?.voice ?: payload.resolvedVoice)
        val rank = listOf("qwen", "microsoft", "system")
        if (rank.indexOf(actualProvider) > rank.indexOf(providers[next.turn] ?: "qwen")) providers[next.turn] = actualProvider
        if (providers.size > 32) providers.remove(providers.keys.first())
        ensureActive()
        val words = payload.spoken ?: SpeechSanitizer.clean(next.text).take(160)
        if (payload.stream != null) {
          prepared = PreparedSpeech(null, words, SpeechEnvelope(emptyList()), payload.provider, payload.stream, next, payload.requestId, payload.stream.voice)
          return@launch
        }
        file = if (payload.audio != null) withContext(Dispatchers.IO) {
          File(context.cacheDir, "speech-${UUID.randomUUID()}.${payload.format}").also { file = it; it.writeBytes(android.util.Base64.decode(payload.audio, android.util.Base64.DEFAULT)) }
        } else synthesizeLocal(words)
        ensureActive()
        if (stamp != epoch) return@launch
        val ready = file ?: return@launch
        val envelope = try { SpeechEnvelope.decode(ready) } catch (e: CancellationException) { throw e } catch (_: Exception) { SpeechEnvelope(emptyList()) }
        ensureActive()
        if (stamp != epoch) return@launch
        prepared = PreparedSpeech(ready, words, envelope, if (payload.audio != null) payload.provider else "system", null, next, payload.requestId, if (payload.audio != null) payload.resolvedVoice else localVoice())
        file = null // Ownership passes to the prepared slot, then the player.
      } catch (e: CancellationException) { throw e }
      catch (_: Exception) { if (stamp == epoch) onError("语音暂时无法播放，请查看文字回复。") }
      finally {
        file?.delete()
        if (stamp == epoch) { fetchJob = null; pump() }
      }
    }
    fetchJob?.start()
  }

  private fun event(line: String): JsonObject = json.parseToJsonElement(line).jsonObject
  private suspend fun requestSpeech(conn: CloudConnection, next: Pending): SpeechPayload? {
    val body = jsonObject("text" to str(next.text.take(8000)), "summarize" to kotlinx.serialization.json.JsonPrimitive(next.summarize),
      "rewrite" to str(if (next.forceRewrite) "always" else if (next.summarize) "auto" else "never"), "voice" to str("sweet-lively"), "style" to str("persona"))
      .toString().toRequestBody("application/json".toMediaType())
    val call = http.newCall(Request.Builder().url(conn.server + "/model/v1/speech")
      .header("Authorization", "Bearer ${conn.token}").header("Accept", "application/x-ndjson")
      .header("X-AnyLink-Speech-Source", next.source).header("X-AnyLink-Speech-Provider", providers[next.turn] ?: "qwen").post(body).build())
    currentCoroutineContext().ensureActive()
    val owner = currentCoroutineContext()[Job]!!
    val response = call.execute()
    if (response.isSuccessful && response.header("Content-Type").orEmpty().startsWith("application/x-ndjson")) {
      var stream: PcmSpeechStream? = null
      try {
        val input = response.body.source()
        val start = event(input.readUtf8LineStrict(1024 * 1024))
        check(start.text("type") == "start" && start.text("format") == "pcm_s16le" && start.text("sample_rate") == "24000" && start.text("channels") == "1")
        val active = PcmSpeechStream(start.text("spoken_text"), start.text("resolved_voice"), start.text("request_id")); stream = active
        active.closeNetwork = { call.cancel() }; streams.add(active)
        owner.invokeOnCompletion { failure -> if (failure != null) { active.cancel(); streams.remove(active) } }
        fun readAudio(e: JsonObject): ByteArray {
          check(e.text("type") == "audio") { "PCM_STREAM_INCOMPLETE" }
          val bytes = android.util.Base64.decode(e.text("audio_base64"), android.util.Base64.DEFAULT)
          check(bytes.isNotEmpty() && bytes.size % 2 == 0 && bytes.size <= 256 * 1024); return bytes
        }
        var bytes = readAudio(event(input.readUtf8LineStrict(1024 * 1024)))
        check(active.audio.trySend(bytes).isSuccess)
        val firstSize = bytes.size
        active.producer = scope.launch(Dispatchers.IO) {
          var total = firstSize
          try {
            while (true) {
              ensureActive(); val e = event(input.readUtf8LineStrict(1024 * 1024))
              if (e.text("type") == "done") { check(e.text("frames").toLongOrNull() == total / 2L); active.completed = true; active.audio.close(); break }
              bytes = readAudio(e); total += bytes.size; check(total <= 6 * 1024 * 1024); active.audio.send(bytes)
            }
          } catch (e: Exception) { active.audio.close(e) }
          finally { response.close() }
        }
        active.producer?.invokeOnCompletion { runCatching { response.close() } }
        return SpeechPayload(active.spoken, provider = "qwen", stream = active, requestId = active.requestId)
      } catch (e: Exception) { stream?.cancel(); stream?.let { streams.remove(it) }; response.close(); throw e }
    }
    return response.use { res ->
      val parsed = runCatching { json.parseToJsonElement(res.body.string()).jsonObject }.getOrNull() ?: return@use null
      if (res.isSuccessful) SpeechPayload.parse(parsed)
      else (parsed["error"] as? JsonObject)?.text("spoken_text")?.takeIf { it.isNotBlank() }?.let { SpeechPayload(it, requestId = parsed.text("request_id"), reason = "SPEECH_UNAVAILABLE") }
    }
  }
  private suspend fun fetch(next: Pending): SpeechPayload = withContext(Dispatchers.IO) {
    if (providers[next.turn] == "system") return@withContext SpeechPayload(SpeechSanitizer.clean(next.text).take(160))
    currentCoroutineContext().ensureActive()
    val conn = connection() ?: return@withContext SpeechPayload(SpeechSanitizer.clean(next.text).take(160))
    val result = runCatching { requestSpeech(conn, next) }.getOrNull()
    currentCoroutineContext().ensureActive()
    result ?: SpeechPayload(SpeechSanitizer.clean(next.text).take(160), reason = "SPEECH_TRANSPORT_FAILED")
  }
  private fun trace(next: Pending, provider: String, requestId: String, outcome: String, reason: String = "", resolvedVoice: String = "") {
    onDiagnostic(jsonObject("source" to str(next.source), "turn" to str(next.turn), "provider" to str(provider), "request_id" to str(requestId),
      "text_chars" to kotlinx.serialization.json.JsonPrimitive(next.text.length), "elapsed_ms" to kotlinx.serialization.json.JsonPrimitive(android.os.SystemClock.elapsedRealtime() - next.queued), "outcome" to str(outcome), "reason" to str(reason), "resolved_voice" to str(resolvedVoice), "at" to str(java.time.Instant.now().toString())))
  }
  private fun playPcm(ready: PreparedSpeech, stamp: Int) {
    val stream = ready.stream!!
    pcmJob = scope.launch(start = CoroutineStart.LAZY) {
      var output: PcmOutput? = null
      var announced = false
      try {
        if (!beforePlayback()) return@launch
        val out = createPcmOutput(stream.sampleRate, inCall()); output = out; pcmOutput = out
        val tick = object : Runnable {
          override fun run() {
            if (stamp != epoch || pcmOutput !== out) return
            val position = runCatching { out.positionFrames() }.getOrDefault(0)
            if (!announced && position > 0) {
              announced = true; onSpeaking(true); onUtterance(ready.spoken); onPlaybackText(ready.spoken, ready.pending.source); onVoice(ready.provider); trace(ready.pending, ready.provider, ready.requestId, "playing", resolvedVoice = stream.voice)
            }
            onLevel(stream.levels.levelAt(position)); main.postDelayed(this, 20)
          }
        }
        levelTick = tick; main.post(tick)
        withContext(Dispatchers.IO) { renderPcm(stream, out) }
        trace(ready.pending, ready.provider, ready.requestId, "completed", resolvedVoice = stream.voice)
      } catch (e: CancellationException) { throw e }
      catch (_: Exception) {
        if (stamp == epoch) {
          onError("语音传输中断，点人物可继续说话。"); trace(ready.pending, ready.provider, ready.requestId, "stream_interrupted", resolvedVoice = stream.voice); interrupt()
        }
      } finally {
        stream.cancel(); streams.remove(stream); output?.stop(); output?.release()
        if (stamp == epoch) { pcmOutput = null; pcmJob = null; stopPlayer(); busy = false; pump() }
      }
    }
    pcmJob?.start()
  }

  private fun play(file: File, spoken: String, envelope: SpeechEnvelope, stamp: Int, provider: String, next: Pending, requestId: String, resolvedVoice: String) {
    currentFile = file
    val mp = createPlayer(); player = mp
    try {
      val usage = if (inCall()) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA
      mp.setAudioAttributes(AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      mp.setDataSource(file.absolutePath)
      mp.setOnPreparedListener {
        if (stamp != epoch || player !== mp) return@setOnPreparedListener
        if (!beforePlayback()) { finish(mp, stamp); return@setOnPreparedListener }
        runCatching {
          mp.start(); onSpeaking(true); onUtterance(spoken); onPlaybackText(spoken, next.source); onVoice(provider); trace(next, provider, requestId, "playing", resolvedVoice = resolvedVoice)
          val tick = object : Runnable {
            override fun run() {
              if (stamp != epoch || player !== mp) return
              onLevel(envelope.levelAt(runCatching { mp.currentPosition }.getOrDefault(-1)))
              main.postDelayed(this, 20)
            }
          }
          levelTick = tick; main.post(tick)
        }.onFailure { finish(mp, stamp) }
      }
      mp.setOnCompletionListener { finish(mp, stamp) }
      mp.setOnErrorListener { _, _, _ ->
        if (stamp == epoch) onError("语音播放中断，请查看文字回复。")
        finish(mp, stamp); true
      }
      mp.prepareAsync()
    } catch (_: Exception) { finish(mp, stamp) }
  }
  private fun finish(mp: MediaPlayer, stamp: Int) {
    if (stamp != epoch || player !== mp) return
    stopPlayer(); busy = false; pump()
  }
  private fun stopPlayer() {
    pcmJob?.cancel(); pcmJob = null; pcmOutput?.stop(); pcmOutput = null
    levelTick?.let(main::removeCallbacks); levelTick = null
    val old = player; player = null
    runCatching { old?.stop() }; old?.release()
    currentFile?.delete(); currentFile = null
    onLevel(0f); onSpeaking(false)
  }
}
