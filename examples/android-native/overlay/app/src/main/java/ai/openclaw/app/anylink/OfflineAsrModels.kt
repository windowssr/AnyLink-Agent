package ai.openclaw.app.anylink

import android.content.Context
import android.os.StatFs
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

internal data class OfflineModelFile(val name: String, val bytes: Long, val sha256: String)
internal data class OfflineAsrModelSpec(val id: String, val revision: String, val repository: String, val origins: List<String>, val files: List<OfflineModelFile>) {
  val bytes get() = files.sumOf { it.bytes }
  init {
    require(id.matches(Regex("[a-z0-9-]+")) && revision.matches(Regex("[a-f0-9]{40}")))
    require(repository.matches(Regex("[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+")))
    require(origins.isNotEmpty() && origins.all { it in setOf("https://huggingface.co", "https://hf-mirror.com") })
    require(files.map { it.name }.toSet() == setOf("encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.onnx", "tokens.txt") && files.size == 4)
    require(files.all { it.bytes in 1..250_000_000 && it.sha256.matches(Regex("[a-f0-9]{64}")) } && bytes <= 300_000_000)
  }
  companion object {
    fun load(context: Context): OfflineAsrModelSpec {
      val json = context.assets.open("anylink/offline-asr.json").bufferedReader().use { JSONObject(it.readText()).getJSONObject("model") }
      val origins = json.getJSONArray("downloadOrigins")
      val files = json.getJSONArray("files")
      return OfflineAsrModelSpec(json.getString("id"), json.getString("revision"), json.getString("repository"),
        List(origins.length()) { origins.getString(it) }, List(files.length()) { index -> files.getJSONObject(index).let {
          OfflineModelFile(it.getString("name"), it.getLong("bytes"), it.getString("sha256"))
        } })
    }
  }
}

internal fun verifyOfflineModelFile(file: File, spec: OfflineModelFile): Boolean {
  if (!file.isFile || file.length() != spec.bytes) return false
  val hash = MessageDigest.getInstance("SHA-256")
  file.inputStream().buffered().use { input ->
    val buffer = ByteArray(64 * 1024)
    while (true) { val size = input.read(buffer); if (size < 0) break; hash.update(buffer, 0, size) }
  }
  return hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) } == spec.sha256
}

internal data class OfflineAsrModelState(val ready: Boolean = false, val downloading: Boolean = false, val receivedBytes: Long = 0, val totalBytes: Long = 0, val error: String = "")

/** Downloads only public pinned model files. No microphone or account credentials enter this client. */
internal class OfflineAsrModels(
  context: Context, scope: CoroutineScope,
  val spec: OfflineAsrModelSpec = OfflineAsrModelSpec.load(context),
  private val http: OkHttpClient = OkHttpClient.Builder().followSslRedirects(false)
    .connectTimeout(12, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(600, TimeUnit.SECONDS).build(),
) {
  private val root = File(context.filesDir, "offline-asr")
  val directory = File(root, spec.id + "-" + spec.revision.take(12))
  val state = MutableStateFlow(OfflineAsrModelState(totalBytes = spec.bytes))
  private val mutex = Mutex()
  @Volatile private var activeCall: Call? = null
  private val initialRefresh = scope.launch { refresh() }

  suspend fun refresh() = withContext(Dispatchers.IO) { mutex.withLock {
    val ready = runCatching { spec.files.all { verifyOfflineModelFile(File(directory, it.name), it) } }.getOrDefault(false)
    state.value = OfflineAsrModelState(ready = ready, totalBytes = spec.bytes, receivedBytes = if (ready) spec.bytes else 0)
  } }

  fun cancelDownload() { activeCall?.cancel() }

  suspend fun download() = withContext(Dispatchers.IO) { initialRefresh.join(); mutex.withLock {
    if (state.value.ready) return@withLock
    val staging = File(root, directory.name + ".pending")
    try {
      root.mkdirs()
      if (StatFs(root.absolutePath).availableBytes < spec.bytes * 2) throw IOException("存储空间不足，请至少保留 ${spec.bytes * 2 / 1048576 + 1} MB 可用空间。")
      staging.deleteRecursively(); check(staging.mkdirs())
      state.value = OfflineAsrModelState(downloading = true, totalBytes = spec.bytes)
      var completed = 0L
      for (file in spec.files) {
        currentCoroutineContext().ensureActive()
        val target = File(staging, file.name)
        var failure: IOException? = null
        for (origin in spec.origins) {
          currentCoroutineContext().ensureActive()
          val call = http.newCall(Request.Builder().url("$origin/${spec.repository}/resolve/${spec.revision}/${file.name}")
            .header("Accept-Encoding", "identity").build())
          activeCall = call
          try {
            call.execute().use { response ->
              if (!response.isSuccessful || !response.request.url.isHttps) throw IOException("模型下载失败（HTTP ${response.code}）")
              var received = 0L
              response.body.byteStream().use { input -> target.outputStream().buffered().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                  currentCoroutineContext().ensureActive()
                  val size = input.read(buffer); if (size < 0) break
                  received += size
                  if (received > file.bytes) throw IOException("模型下载大小异常")
                  output.write(buffer, 0, size)
                  state.value = OfflineAsrModelState(downloading = true, receivedBytes = completed + received, totalBytes = spec.bytes)
                }
              } }
            }
            if (!verifyOfflineModelFile(target, file)) throw IOException("模型完整性校验失败，请重新下载。")
            failure = null; break
          } catch (error: IOException) { failure = error; target.delete() }
          finally { if (activeCall === call) activeCall = null }
        }
        failure?.let { throw it }
        completed += file.bytes
      }
      currentCoroutineContext().ensureActive()
      if (directory.exists() && !directory.deleteRecursively()) throw IOException("无法更新本地模型目录")
      if (!staging.renameTo(directory)) throw IOException("无法保存离线模型")
      state.value = OfflineAsrModelState(ready = true, receivedBytes = spec.bytes, totalBytes = spec.bytes)
    } catch (error: CancellationException) {
      state.value = OfflineAsrModelState(totalBytes = spec.bytes); throw error
    } catch (error: Exception) {
      state.value = OfflineAsrModelState(totalBytes = spec.bytes, error = error.message ?: "离线模型下载失败，请检查网络后重试。")
    } finally { activeCall?.cancel(); activeCall = null; staging.deleteRecursively() }
  } }
}
