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

private data class Pending(val text: String, val summarize: Boolean, val interrupt: Boolean)

/** Fetches /model/v1/speech and plays the mp3; falls back to system TTS with the
 * server's spoken_text (or the locally sanitized text when the request fails). */
internal class SpeechPlayer(
  private val context: Context,
  private val scope: CoroutineScope,
  private val connection: () -> CloudConnection?,
  private val speakTts: (String, Boolean) -> Unit,
  private val onSpeaking: (Boolean) -> Unit,
) {
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(20000, java.util.concurrent.TimeUnit.MILLISECONDS).build()
  private val json = Json { ignoreUnknownKeys = true }
  private val main = Handler(Looper.getMainLooper())
  private val pending = ArrayDeque<Pending>()
  private var player: MediaPlayer? = null
  private var busy = false
  private var epoch = 0
  private var currentFile: File? = null

  fun enqueue(text: String, summarize: Boolean, interrupt: Boolean) {
    if (interrupt) { pending.clear(); epoch++; stopPlayer() }
    pending.addLast(Pending(text, summarize, interrupt))
    pump()
  }

  fun interrupt() { pending.clear(); epoch++; stopPlayer() }

  private fun pump() {
    if (busy) return
    val next = pending.pollFirst() ?: return
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

  private suspend fun fetch(next: Pending): Pair<String?, String?> = withContext(Dispatchers.IO) {
    val conn = connection() ?: return@withContext null to null
    try {
      val body = jsonObject(
        "text" to str(next.text.take(8000)),
        "summarize" to kotlinx.serialization.json.JsonPrimitive(next.summarize),
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
          if (!audio.isNullOrBlank() && spoken != null) return@withContext spoken to audio
        }
        // 502 SPEECH_UNAVAILABLE still carries spoken_text for client fallback.
        val fallback = (parsed?.get("error") as? JsonObject)?.get("spoken_text")?.jsonPrimitive?.content
        return@withContext fallback to null
      }
    } catch (_: Exception) { null to null }
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
