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

private const val CLIENT_VOICE_REWRITE_SYSTEM = """你是「大肥鱼」（住在数据海里的深海蓝白鲸鱼娘），负责把要给主人听的文字精炼改写成 1-2 句适合直接语音播报的简短中文口语：
- 只提炼最核心的结论、关键结果或明确原因，严禁照念长段文字、代码、Markdown 格式、路径、URL、表格、列表或英文报错码。
- 严格贴合「蓝色大肥鱼」人设：聪明惜力、软糯轻快、带一点傲娇和熟人感，自然称呼「主人」，绝不使用客服套话、播音腔、括号动作描写、颜文字或「喵」。
- 务必简洁利落（不超过 65 个中文字），只输出最终要念出来的纯口播文本，不要任何引号、前缀或解释。"""

private data class Pending(val text: String, val summarize: Boolean, val forceRewrite: Boolean = false)
internal data class SpeechPayload(val spoken: String?, val audio: String? = null, val format: String = "mp3", val provider: String = "system") {
  companion object {
    fun parse(body: JsonObject): SpeechPayload = SpeechPayload(body.text("spoken_text"), body.text("audio_base64").takeIf { it.isNotBlank() },
      if (body.text("format") == "wav") "wav" else "mp3", if (body.text("provider") == "qwen") "qwen" else "microsoft")
  }
}
private data class PreparedSpeech(val file: File, val spoken: String, val envelope: SpeechEnvelope, val provider: String)

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
) {
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(45000, java.util.concurrent.TimeUnit.MILLISECONDS).build()
  private val json = Json { ignoreUnknownKeys = true }
  private val main = Handler(Looper.getMainLooper())
  private val pending = ArrayDeque<Pending>()
  private var player: MediaPlayer? = null
  private var busy = false
  private var epoch = 0
  private var fetchJob: Job? = null
  private var prepared: PreparedSpeech? = null
  private var currentFile: File? = null
  private var levelTick: Runnable? = null
  val isActive: Boolean get() = busy || pending.isNotEmpty() || fetchJob != null || prepared != null

  fun enqueue(text: String, summarize: Boolean, interrupt: Boolean, forceRewrite: Boolean = true) {
    if (interrupt) interrupt()
    if (text.isBlank()) return
    pending.addLast(Pending(text, summarize, forceRewrite))
    pump()
  }
  fun interrupt() {
    epoch++; pending.clear(); fetchJob?.cancel(); fetchJob = null
    prepared?.file?.delete(); prepared = null
    http.dispatcher.cancelAll()
    stopPlayer(); busy = false
  }
  private fun pump() {
    if (!busy) prepared?.let { ready ->
      prepared = null; busy = true
      play(ready.file, ready.spoken, ready.envelope, epoch, ready.provider)
    }
    // Fetch at most one next utterance while the active one plays. No pose/voice callbacks until playback.
    if (fetchJob != null || prepared != null) return
    val next = pending.pollFirst() ?: run { if (!busy) onIdle(); return }
    val stamp = epoch
    fetchJob = scope.launch(start = CoroutineStart.LAZY) {
      var file: File? = null
      try {
        val payload = fetch(next)
        ensureActive()
        val words = payload.spoken ?: SpeechSanitizer.clean(next.text)
        file = if (payload.audio != null) withContext(Dispatchers.IO) {
          File(context.cacheDir, "speech-${UUID.randomUUID()}.${payload.format}").also { file = it; it.writeBytes(android.util.Base64.decode(payload.audio, android.util.Base64.DEFAULT)) }
        } else synthesizeLocal(words)
        ensureActive()
        if (stamp != epoch) return@launch
        val ready = file ?: return@launch
        val envelope = try { SpeechEnvelope.decode(ready) } catch (e: CancellationException) { throw e } catch (_: Exception) { SpeechEnvelope(emptyList()) }
        ensureActive()
        if (stamp != epoch) return@launch
        prepared = PreparedSpeech(ready, words, envelope, if (payload.audio != null) payload.provider else "system")
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

  /** Dedicated lightweight chat API call to condense & rewrite any output into 1-2 short in-character spoken sentences. */
  private fun rewriteViaCompletionApi(conn: CloudConnection, rawText: String): String? = runCatching {
    val body = jsonObject(
      "model" to str("deepseek-flash"),
      "stream" to kotlinx.serialization.json.JsonPrimitive(false),
      "max_tokens" to kotlinx.serialization.json.JsonPrimitive(180),
      "temperature" to kotlinx.serialization.json.JsonPrimitive(0.72),
      "messages" to kotlinx.serialization.json.JsonArray(listOf(
        jsonObject("role" to str("system"), "content" to str(CLIENT_VOICE_REWRITE_SYSTEM)),
        jsonObject("role" to str("user"), "content" to str(rawText.take(4000))),
      )),
    ).toString().toRequestBody("application/json".toMediaType())
    val response = http.newCall(
      Request.Builder()
        .url(conn.server + "/model/v1/chat/completions")
        .header("Authorization", "Bearer ${conn.token}")
        .post(body)
        .build(),
    ).execute()
    response.use { res ->
      if (!res.isSuccessful) return@runCatching null
      val parsed = runCatching { json.parseToJsonElement(res.body.string()).jsonObject }.getOrNull() ?: return@runCatching null
      val choices = parsed["choices"] as? kotlinx.serialization.json.JsonArray ?: return@runCatching null
      val content = (choices.firstOrNull() as? JsonObject)?.get("message")?.jsonObject?.text("content").orEmpty()
      SpeechSanitizer.clean(content).take(160).takeIf { it.isNotBlank() }
    }
  }.getOrNull()

  private fun requestSpeech(conn: CloudConnection, text: String, rewrite: Boolean): SpeechPayload? {
    val body = jsonObject("text" to str(text.take(8000)), "summarize" to kotlinx.serialization.json.JsonPrimitive(rewrite),
      "rewrite" to str(if (rewrite) "always" else "never"), "voice" to str("sweet-lively"), "style" to str("persona"))
      .toString().toRequestBody("application/json".toMediaType())
    return http.newCall(Request.Builder().url(conn.server + "/model/v1/speech")
      .header("Authorization", "Bearer ${conn.token}").post(body).build()).execute().use { res ->
      val parsed = runCatching { json.parseToJsonElement(res.body.string()).jsonObject }.getOrNull() ?: return@use null
      if (res.isSuccessful) SpeechPayload.parse(parsed)
      else (parsed["error"] as? JsonObject)?.text("spoken_text")?.takeIf { it.isNotBlank() }?.let { SpeechPayload(it) }
    }
  }

  private suspend fun fetch(next: Pending): SpeechPayload = withContext(Dispatchers.IO) {
    val conn = connection() ?: return@withContext SpeechPayload(null)
    val result = runCatching { requestSpeech(conn, next.text, next.forceRewrite || next.summarize) }.getOrNull()
    currentCoroutineContext().ensureActive()
    // A server 502 has already exhausted Momo and Microsoft; preserve its concise words for system TTS.
    if (result != null && !result.spoken.isNullOrBlank()) return@withContext result
    if (next.forceRewrite || next.summarize) {
      val rewritten = rewriteViaCompletionApi(conn, next.text)
      currentCoroutineContext().ensureActive()
      if (!rewritten.isNullOrBlank()) {
        val retry = runCatching { requestSpeech(conn, rewritten, false) }.getOrNull()
        currentCoroutineContext().ensureActive()
        return@withContext retry ?: SpeechPayload(rewritten)
      }
    }
    SpeechPayload(null)
  }

  private fun play(file: File, spoken: String, envelope: SpeechEnvelope, stamp: Int, provider: String) {
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
          mp.start(); onSpeaking(true); onUtterance(spoken); onVoice(provider)
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
    levelTick?.let(main::removeCallbacks); levelTick = null
    val old = player; player = null
    runCatching { old?.stop() }; old?.release()
    currentFile?.delete(); currentFile = null
    onLevel(0f); onSpeaking(false)
  }
}
