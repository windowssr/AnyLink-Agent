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

private data class Pending(val text: String, val summarize: Boolean, val interrupt: Boolean, val forceRewrite: Boolean = false)

/** Fetches /model/v1/speech (with mandatory persona rewrite when requested) and plays the mp3;
 * if /model/v1/speech fails or skips rewrite, performs a dedicated lightweight /model/v1/chat/completions
 * persona-rewrite API call before falling back to system TTS so voice output stays brief, core, and in-character. */
internal class SpeechPlayer(
  private val context: Context,
  private val scope: CoroutineScope,
  private val connection: () -> CloudConnection?,
  private val speakTts: (String, Boolean) -> Unit,
  private val onSpeaking: (Boolean) -> Unit,
  private val onIdle: () -> Unit = {},
) {
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(45000, java.util.concurrent.TimeUnit.MILLISECONDS).build()
  private val json = Json { ignoreUnknownKeys = true }
  private val main = Handler(Looper.getMainLooper())
  private val pending = ArrayDeque<Pending>()
  private var player: MediaPlayer? = null
  private var busy = false
  private var epoch = 0
  private var currentFile: File? = null
  val isActive: Boolean get() = busy || pending.isNotEmpty()

  fun enqueue(text: String, summarize: Boolean, interrupt: Boolean, forceRewrite: Boolean = true) {
    if (interrupt) { pending.clear(); epoch++; stopPlayer() }
    pending.addLast(Pending(text, summarize, interrupt, forceRewrite))
    pump()
  }

  fun interrupt() { pending.clear(); epoch++; stopPlayer() }

  private fun pump() {
    if (busy) return
    val next = pending.pollFirst() ?: run {
      onIdle()
      return
    }
    busy = true
    val stamp = epoch
    scope.launch {
      val result = fetch(next)
      withContext(Dispatchers.Main) {
        if (stamp != epoch) { busy = false; pump(); return@withContext }
        play(next, result)
      }
    }
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

  private suspend fun fetch(next: Pending): Pair<String?, String?> = withContext(Dispatchers.IO) {
    val conn = connection() ?: return@withContext null to null
    val wantRewrite = next.forceRewrite || next.summarize
    var spokenFromServer: String? = null
    var rewrittenByServer = false
    try {
      val body = jsonObject(
        "text" to str(next.text.take(8000)),
        "summarize" to kotlinx.serialization.json.JsonPrimitive(wantRewrite),
        "rewrite" to str(if (wantRewrite) "always" else "never"),
        "voice" to str("sweet-lively"),
        "style" to str("persona"),
      ).toString().toRequestBody("application/json".toMediaType())
      val response = http.newCall(Request.Builder().url(conn.server + "/model/v1/speech")
        .header("Authorization", "Bearer ${conn.token}").post(body).build()).execute()
      response.use { res ->
        val payload = res.body.string()
        val parsed = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull()
        if (res.code == 200) {
          val spoken = parsed?.get("spoken_text")?.jsonPrimitive?.content
          val audio = parsed?.get("audio_base64")?.jsonPrimitive?.content
          rewrittenByServer = parsed?.get("rewritten")?.jsonPrimitive?.content == "true"
          if (!audio.isNullOrBlank() && !spoken.isNullOrBlank() && (!wantRewrite || rewrittenByServer)) {
            return@withContext spoken to audio
          }
          spokenFromServer = spoken
        } else {
          // 502 SPEECH_UNAVAILABLE still carries server-rewritten spoken_text for client fallback.
          spokenFromServer = (parsed?.get("error") as? JsonObject)?.get("spoken_text")?.jsonPrimitive?.content
          rewrittenByServer = !spokenFromServer.isNullOrBlank() && spokenFromServer != SpeechSanitizer.clean(next.text)
        }
      }
    } catch (_: Exception) { }

    // Guarantee a dedicated persona-rewrite API pass whenever requested and not already rewritten by /model/v1/speech.
    if (wantRewrite && !rewrittenByServer) {
      val rewritten = rewriteViaCompletionApi(conn, next.text)
      if (!rewritten.isNullOrBlank()) {
        // Try synthesizing the already-rewritten concise line via /model/v1/speech (rewrite=never) for neural voice!
        val synthAudio = runCatching {
          val synthBody = jsonObject(
            "text" to str(rewritten),
            "summarize" to kotlinx.serialization.json.JsonPrimitive(false),
            "rewrite" to str("never"),
            "voice" to str("sweet-lively"),
            "style" to str("persona"),
          ).toString().toRequestBody("application/json".toMediaType())
          http.newCall(Request.Builder().url(conn.server + "/model/v1/speech")
            .header("Authorization", "Bearer ${conn.token}").post(synthBody).build()).execute().use { res ->
            if (res.code != 200) null
            else runCatching { json.parseToJsonElement(res.body.string()).jsonObject["audio_base64"]?.jsonPrimitive?.content }.getOrNull()?.takeIf { it.isNotBlank() }
          }
        }.getOrNull()
        return@withContext rewritten to synthAudio
      }
    }
    return@withContext spokenFromServer to null
  }

  private fun play(next: Pending, result: Pair<String?, String?>) {
    val (spoken, audio) = result
    if (audio == null) {
      // Server TTS unavailable or request failed: system TTS with spoken_text or
      // the locally sanitized text. TTS queues itself; advance immediately.
      val fallback = spoken ?: SpeechSanitizer.clean(next.text).ifBlank { next.text }.take(3500)
      speakTts(fallback, next.interrupt)
      busy = false; pump(); return
    }
    try {
      val bytes = android.util.Base64.decode(audio, android.util.Base64.DEFAULT)
      val file = File(context.cacheDir, "speech-${UUID.randomUUID()}.mp3").apply { writeBytes(bytes) }
      currentFile = file
      val mp = MediaPlayer()
      player = mp
      mp.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      mp.setDataSource(file.absolutePath)
      mp.setOnPreparedListener {
        onSpeaking(true)
        mp.start()
      }
      mp.setOnCompletionListener { finish() }
      mp.setOnErrorListener { _, _, _ -> finish(); true }
      mp.prepareAsync()
    } catch (_: Exception) { finish() }
  }

  private fun finish() {
    runCatching { player?.stop() }
    player?.release(); player = null
    currentFile?.delete(); currentFile = null
    onSpeaking(false)
    busy = false; pump()
  }

  private fun stopPlayer() {
    runCatching { player?.stop() }
    player?.release(); player = null
    currentFile?.delete(); currentFile = null
    onSpeaking(false)
    busy = false
  }
}
