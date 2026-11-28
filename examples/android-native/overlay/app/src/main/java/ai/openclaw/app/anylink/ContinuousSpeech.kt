package ai.openclaw.app.anylink

import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Text arrives from the model while one HTTP response and AudioTrack carry the entire reply. */
internal class LiveSpeechTurn(val initial: String, val source: String) {
  val id = UUID.randomUUID().toString()
  val input = Channel<String>(32)
  val finished = CompletableDeferred<Unit>()
  @Volatile var text = initial; private set
  @Volatile private var transportFailed = false
  fun append(words: String) {
    if (finished.isCompleted) return
    val part = words.take((8000 - text.length).coerceAtLeast(0))
    if (part.isEmpty()) { finish(); return }
    text += part
    if (transportFailed) return
    if (!input.trySend(part).isSuccess) { input.close(IllegalStateException("TTS_INPUT_QUEUE_FULL")); finished.complete(Unit) }
  }
  fun finish() { finished.complete(Unit); input.close() }
  fun cancel() { input.cancel(); finished.cancel() }

  suspend fun open(http: OkHttpClient, scope: CoroutineScope, conn: CloudConnection): PcmSpeechStream {
    val json = Json { ignoreUnknownKeys = true }
    fun event(line: String) = json.parseToJsonElement(line).jsonObject
    fun body(value: JsonObject) = value.toString().toRequestBody("application/json".toMediaType())
    val call = http.newCall(Request.Builder().url(conn.server + "/model/v1/speech/live")
      .header("Authorization", "Bearer ${conn.token}").header("Accept", "application/x-ndjson")
      .post(body(jsonObject("id" to str(id), "text" to str(initial.take(1000)), "source" to str(source)))).build())
    val owner = currentCoroutineContext()[Job]!!
    val response = call.execute()
    var stream: PcmSpeechStream? = null; var sender: Job? = null
    try {
      check(response.isSuccessful && response.header("Content-Type").orEmpty().startsWith("application/x-ndjson")) { "TTS_LIVE_UNAVAILABLE" }
      val inputAudio = response.body.source()
      val start = event(inputAudio.readUtf8LineStrict(1024 * 1024))
      check(start.text("type") == "start" && start.text("format") == "pcm_s16le" && start.text("sample_rate") == "24000" && start.text("channels") == "1")
      val active = PcmSpeechStream(start.text("spoken_text"), start.text("resolved_voice"), start.text("request_id"), sessionId = start.text("session_id"), speechRate = start.text("speech_rate").toFloatOrNull() ?: 0f)
      stream = active
      active.closeNetwork = { call.cancel(); sender?.cancel(); input.cancel() }
      owner.invokeOnCompletion { if (it != null) active.cancel() }
      sender = scope.launch(Dispatchers.IO) {
        fun patch(text: String, finish: Boolean) {
          http.newCall(Request.Builder().url(conn.server + "/model/v1/speech/live/$id").header("Authorization", "Bearer ${conn.token}")
            .patch(body(jsonObject("text" to str(text), "finish" to JsonPrimitive(finish)))).build()).execute().use { check(it.isSuccessful) { "TTS_INPUT_REJECTED" } }
        }
        try {
          for (part in input) {
            ensureActive(); val batch = StringBuilder(part)
            while (batch.length < 1000) { val next = input.tryReceive().getOrNull() ?: break; batch.append(next) }
            patch(batch.toString(), false)
          }
          ensureActive(); patch("", true)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { active.audio.close(e); call.cancel() }
      }
      var total = 0
      fun readAudio(): ByteArray? {
        while (true) {
          val e = event(inputAudio.readUtf8LineStrict(1024 * 1024))
          if (e.text("type") == "text") { active.spoken += e.text("text"); continue }
          if (e.text("type") == "done") { check(e.text("frames").toLongOrNull() == total / 2L); active.completed = true; return null }
          check(e.text("type") == "audio") { "PCM_STREAM_INCOMPLETE" }
          val bytes = android.util.Base64.decode(e.text("audio_base64"), android.util.Base64.DEFAULT)
          total += bytes.size
          check(bytes.isNotEmpty() && bytes.size % 2 == 0 && bytes.size <= 256 * 1024 && total <= 6 * 1024 * 1024)
          return bytes
        }
      }
      val first = readAudio() ?: error("PCM_STREAM_EMPTY"); check(active.audio.trySend(first).isSuccess)
      active.producer = scope.launch(Dispatchers.IO) {
        try {
          while (true) { ensureActive(); val bytes = readAudio() ?: break; active.audio.send(bytes) }
          active.audio.close()
        } catch (e: Exception) { active.audio.close(e) }
        finally { sender.cancel(); response.close() }
      }
      active.producer?.invokeOnCompletion { response.close() }
      return active
    } catch (e: Exception) { transportFailed = true; input.cancel(); stream?.cancel(); sender?.cancel(); call.cancel(); response.close(); throw e }
  }
}
