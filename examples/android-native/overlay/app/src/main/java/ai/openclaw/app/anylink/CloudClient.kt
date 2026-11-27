package ai.openclaw.app.anylink

import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.random.Random
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal val linkJson = Json { ignoreUnknownKeys = true }
internal fun JsonObject.text(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
internal fun jsonObject(vararg values: Pair<String, JsonElement>): JsonObject = JsonObject(values.toMap())
internal fun str(value: String): JsonPrimitive = JsonPrimitive(value)
internal class LinkFailure(val code: String, message: String, val unknown: Boolean = false) : IOException(message)

internal data class CloudConnection(
  val server: String,
  val token: String,
  val deviceId: String,
  val agentId: String = "",
  val installId: String = "",
  val deviceSlug: String = "",
) {
  fun wsUrl(resumeAfterSeq: Long = 0L): String {
    val base = server.trimEnd('/')
    val raw = when {
      base.startsWith("https://") -> "wss://" + base.removePrefix("https://") + "/edge/v1/ws"
      base.startsWith("http://") -> "ws://" + base.removePrefix("http://") + "/edge/v1/ws"
      else -> "$base/edge/v1/ws"
    }
    return if (resumeAfterSeq > 0L) "$raw?resume_after_seq=$resumeAfterSeq" else raw
  }

  companion object {
    private fun serverUrl(server: String) = server.trim().toHttpUrl().also { url ->
      require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null && url.encodedPath == "/") { "请填写服务器根地址，不含路径、账号或查询参数" }
      require(url.isHttps || url.host in setOf("localhost", "127.0.0.1", "::1")) { "远程连接需要 HTTPS；本机调试可用回环隧道" }
    }
    private val joinHttp = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
      .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS).build()

    /** Join with the owner login password (>=6 chars) or join key: upserts this install's device and android-dafeiyu agent. */
    suspend fun join(server: String, joinKey: String, installId: String, deviceName: String, deviceSlug: String = ""): CloudConnection = withContext(Dispatchers.IO) {
      val cleanSecret = joinKey.trim()
      require(cleanSecret.length >= 6 && !cleanSecret.any { it == '\n' || it == '\r' }) { "请填写服务器预设登录密码（至少 6 位）或加入密钥" }
      require(Regex("android-[0-9a-fA-F-]{36}").matches(installId)) { "安装标识无效" }
      val cleanSlug = deviceSlug.trim().lowercase()
      if (cleanSlug.isNotBlank()) require(Regex("[a-z0-9][a-z0-9_-]{1,39}").matches(cleanSlug)) { "设备短别名仅支持 2-40 位小写字母、数字、短横线或下划线" }
      val base = serverUrl(server).toString().trimEnd('/')
      val body = buildJsonObject {
        put("device", buildJsonObject {
          put("install_id", str(installId))
          put("name", str(deviceName.trim().ifBlank { "Android" }.take(80)))
          put("platform", str("android"))
          if (cleanSlug.isNotBlank()) put("slug", str(cleanSlug))
        })
        put("agent", jsonObject(
          "key" to str("android-dafeiyu"),
          "name" to str("手机大肥鱼"),
          "kind" to str("device-agent"),
          "summary" to str("手机本地大肥鱼：支持语音陪伴、查看手机基础状态与播报提醒"),
        ))
      }
      val request = Request.Builder().url("$base/edge/v1/connect").header("Authorization", "Bearer $cleanSecret")
        .post(body.toString().toRequestBody("application/json".toMediaType())).build()
      joinHttp.newCall(request).execute().use { response ->
        val raw = response.body.string()
        val data = runCatching { linkJson.parseToJsonElement(raw).jsonObject }.getOrNull()
        if (response.code != 201 || data == null) {
          val code = (data?.get("error") as? JsonObject)?.text("code") ?: "HTTP_${response.code}"
          throw LinkFailure(code, "加入失败：$code", response.code >= 500)
        }
        val token = data.text("token")
        require(Regex("ak_[A-Za-z0-9_-]{30,100}").matches(token)) { "服务器返回的凭据格式无效" }
        UUID.fromString(data.text("device_id")); UUID.fromString(data.text("agent_id"))
        CloudConnection(base, token, data.text("device_id"), data.text("agent_id"), installId, data.text("device_slug").ifBlank { cleanSlug })
      }
    }

    suspend fun adoptInstallId(transport: LinkTransport, installId: String): Boolean {
      return try { transport.request("POST", "/edge/v1/device/install-id", jsonObject("install_id" to str(installId))); true }
      catch (e: LinkFailure) { if (e.code == "EDGE_AUTH_REQUIRED" || e.code == "HTTP_401") false else throw e }
    }

    fun parse(server: String, credential: String): CloudConnection {
      val url = serverUrl(server)
      val value = linkJson.parseToJsonElement(credential).jsonObject
      val token = value.text("token")
      require(Regex("ak_[A-Za-z0-9_-]{30,100}").matches(token)) { "请导入服务器签发的设备凭据 JSON" }
      val device = value.text("device_id")
      UUID.fromString(device)
      val agent = value.text("agent_id")
      if (agent.isNotBlank()) UUID.fromString(agent)
      val install = value.text("install_id")
      if (install.isNotBlank()) require(Regex("android-[0-9a-fA-F-]{36}").matches(install)) { "安装标识无效" }
      return CloudConnection(url.toString().trimEnd('/'), token, device, agent, install, value.text("device_slug"))
    }
  }
}

internal interface LinkTransport {
  suspend fun request(method: String, path: String, body: JsonObject? = null, key: String? = null, revision: Int? = null): JsonObject
  suspend fun completion(body: JsonObject, onText: (String) -> Unit): JsonObject
  suspend fun uploadArtifact(bytes: ByteArray, filename: String, contentType: String = "application/octet-stream"): JsonObject =
    throw LinkFailure("UNSUPPORTED", "当前传输不支持上传附件")
  suspend fun uploadArtifactStream(context: android.content.Context, uri: android.net.Uri, filename: String, contentType: String = "application/octet-stream", sizeBytes: Long = -1L, maxBytes: Long = AnyLinkFiles.HARD_MAX_BYTES): JsonObject =
    throw LinkFailure("UNSUPPORTED", "当前传输不支持流式上传附件")
  suspend fun downloadArtifact(artifactId: String): DownloadedArtifact =
    throw LinkFailure("UNSUPPORTED", "当前传输不支持下载附件")
  suspend fun downloadArtifactToStorage(context: android.content.Context, artifactId: String, preferredFilename: String = "", preferredMime: String = "", expectedSha256: String = "", maxBytes: Long = AnyLinkFiles.MAX_BYTES): Pair<SavedFile, String> =
    throw LinkFailure("UNSUPPORTED", "当前传输不支持流式下载附件")
  fun cancel()
}

/** Thread-safe AnyLink HTTP client with Protocol v3.2 SSE detach-on-disconnect recovery and O(1)-RAM large file streaming. */
internal class CloudClient(private val connection: CloudConnection) : LinkTransport {
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(125, TimeUnit.SECONDS).callTimeout(130, TimeUnit.SECONDS).build()
  private val transferHttp = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .retryOnConnectionFailure(false).connectTimeout(20, TimeUnit.SECONDS)
    .writeTimeout(10, TimeUnit.MINUTES).readTimeout(10, TimeUnit.MINUTES).callTimeout(15, TimeUnit.MINUTES).build()
  private val inFlight = ConcurrentHashMap.newKeySet<Call>()

  private fun call(method: String, path: String, body: JsonObject?, key: String?, revision: Int?, extraHeaders: Map<String, String> = emptyMap()): Call {
    require(path.startsWith('/') && !path.startsWith("//"))
    val request = Request.Builder().url(connection.server + path).header("Authorization", "Bearer ${connection.token}")
    if (key != null) request.header("Idempotency-Key", key)
    if (revision != null) request.header("If-Match", revision.toString())
    for ((k, v) in extraHeaders) request.header(k, v)
    val payload = body?.toString()?.toRequestBody("application/json".toMediaType())
    return http.newCall(request.method(method, if (method in setOf("POST", "PATCH")) payload ?: "{}".toRequestBody("application/json".toMediaType()) else payload).build())
  }

  override suspend fun request(method: String, path: String, body: JsonObject?, key: String?, revision: Int?): JsonObject = withContext(Dispatchers.IO) {
    val writing = method != "GET" && !path.endsWith("/search") && !path.endsWith("/assemble")
    val call = call(method, path, body, key, revision)
    inFlight.add(call)
    try {
      call.execute().use { response ->
        val raw = response.body.string()
        if (raw.length > 2_000_000) throw LinkFailure("RESPONSE_TOO_LARGE", "服务器响应过大", writing)
        val data = runCatching { linkJson.parseToJsonElement(raw).jsonObject }.getOrNull()
        if (!response.isSuccessful) {
          val error = data?.get("error") as? JsonObject
          val code = error?.text("code")?.takeIf { it.isNotBlank() } ?: "HTTP_${response.code}"
          throw LinkFailure(code, error?.text("message")?.takeIf { it.isNotBlank() } ?: "服务器请求失败：$code", writing && response.code >= 500 && code != "PROVIDER_NOT_CONFIGURED")
        }
        data ?: throw LinkFailure("INCOMPLETE_RESPONSE", "服务器响应未完整确认", writing)
      }
    } catch (error: IOException) {
      throw if (error is LinkFailure) error else LinkFailure("TRANSPORT_ERROR", "连接中断；已提交操作的结果可能未知，没有自动重试", writing)
    } finally { inFlight.remove(call) }
  }

  /** Recover a detached streaming model completion by X-AnyLink-Request-Id after a mobile network blip. */
  private suspend fun recoverDetachedRequest(requestId: String, onText: (String) -> Unit): JsonObject? {
    repeat(10) { attempt ->
      delay(if (attempt == 0) 600L else 1200L)
      val status = runCatching { request("GET", "/model/v1/requests/$requestId") }.getOrNull() ?: return@repeat
      val partial = status.text("partial_text")
      if (partial.isNotBlank()) onText(partial)
      if (status.text("state") == "completed") {
        val snap = status["result"] as? JsonObject ?: return null
        val content = snap.text("content")
        val toolCalls = snap["tool_calls"] as? JsonArray
        if (content.isNotBlank()) onText(content)
        return buildJsonObject {
          put("role", "assistant")
          put("content", content)
          if (toolCalls != null && toolCalls.isNotEmpty()) put("tool_calls", toolCalls)
        }
      }
      if (status.text("state") in setOf("rejected", "cancelled", "submission_unknown")) return null
    }
    return null
  }

  override suspend fun completion(body: JsonObject, onText: (String) -> Unit): JsonObject = withContext(Dispatchers.IO) {
    val call = call("POST", "/model/v1/chat/completions", body, null, null, mapOf("X-AnyLink-Detach-On-Disconnect" to "on"))
    inFlight.add(call)
    var serverRequestId: String? = null
    try {
      call.execute().use { response ->
        serverRequestId = response.header("X-AnyLink-Request-Id")?.takeIf { it.isNotBlank() }
        if (!response.isSuccessful) {
          val data = runCatching { linkJson.parseToJsonElement(response.body.string()).jsonObject }.getOrNull()
          val code = (data?.get("error") as? JsonObject)?.text("code") ?: "HTTP_${response.code}"
          throw LinkFailure(code, "模型请求失败：$code", response.code >= 500 && code != "PROVIDER_NOT_CONFIGURED")
        }
        if (!response.header("Content-Type").orEmpty().contains("text/event-stream")) throw LinkFailure("INVALID_STREAM", "模型未返回流式响应", true)
        val collector = CompletionCollector(onText)
        val source = response.body.source()
        var event = StringBuilder()
        while (!source.exhausted()) {
          val line = source.readUtf8LineStrict(2_000_000)
          if (line.isEmpty()) {
            if (collector.event(event.toString())) return@withContext collector.finish()
            event = StringBuilder()
          } else if (line.startsWith("data:")) {
            event.append(line.removePrefix("data:").removePrefix(" ")).append('\n')
            if (event.length > 2_000_000) throw LinkFailure("INVALID_STREAM", "模型事件过大", true)
          }
        }
        throw LinkFailure("STREAM_INCOMPLETE", "模型响应中断，没有自动重发", true)
      }
    } catch (error: IOException) {
      if (!call.isCanceled() && serverRequestId != null && (error !is LinkFailure || error.code == "STREAM_INCOMPLETE")) {
        recoverDetachedRequest(serverRequestId!!, onText)?.let { return@withContext it }
      }
      throw if (error is LinkFailure) error else LinkFailure("STREAM_INCOMPLETE", "模型响应未完整确认，没有自动重发", true)
    } catch (_: Exception) {
      throw LinkFailure("INVALID_STREAM", "模型响应格式未完整确认，没有自动重发或执行工具", true)
    } finally { inFlight.remove(call) }
  }

  override suspend fun uploadArtifact(bytes: ByteArray, filename: String, contentType: String): JsonObject = withContext(Dispatchers.IO) {
    if (bytes.size.toLong() > AnyLinkFiles.MAX_BYTES) throw LinkFailure("ARTIFACT_TOO_LARGE", "文件超过 200 MiB 上限")
    val safeName = AnyLinkFiles.sanitizeFilename(filename)
    val safeMime = contentType.substringBefore(';').trim().ifBlank { "application/octet-stream" }
    val request = Request.Builder()
      .url(connection.server + "/edge/v1/artifacts")
      .header("Authorization", "Bearer ${connection.token}")
      .header("X-AnyLink-Filename", java.net.URLEncoder.encode(safeName, "UTF-8").replace("+", "%20"))
      .header("X-AnyLink-Content-Type", safeMime)
      .post(bytes.toRequestBody("application/octet-stream".toMediaType()))
      .build()
    val call = transferHttp.newCall(request)
    inFlight.add(call)
    try {
      call.execute().use { response ->
        val raw = response.body.string()
        val data = runCatching { linkJson.parseToJsonElement(raw).jsonObject }.getOrNull()
        if (!response.isSuccessful || data == null) {
          val code = (data?.get("error") as? JsonObject)?.text("code")?.takeIf { it.isNotBlank() } ?: "HTTP_${response.code}"
          throw LinkFailure(code, "上传附件失败：$code", response.code >= 500)
        }
        data
      }
    } catch (error: IOException) {
      throw if (error is LinkFailure) error else LinkFailure("TRANSPORT_ERROR", "上传附件连接中断", false)
    } finally { inFlight.remove(call) }
  }

  override suspend fun uploadArtifactStream(
    context: android.content.Context,
    uri: android.net.Uri,
    filename: String,
    contentType: String,
    sizeBytes: Long,
    maxBytes: Long,
  ): JsonObject = withContext(Dispatchers.IO) {
    if (sizeBytes > maxBytes) throw LinkFailure("ARTIFACT_TOO_LARGE", "文件超过单文件上限 ${AnyLinkFiles.formatSize(maxBytes)}")
    val safeName = AnyLinkFiles.sanitizeFilename(filename)
    val safeMime = contentType.substringBefore(';').trim().ifBlank { "application/octet-stream" }
    val body = object : okhttp3.RequestBody() {
      override fun contentType() = "application/octet-stream".toMediaType()
      override fun contentLength(): Long = if (sizeBytes > 0L) sizeBytes else -1L
      override fun writeTo(sink: okio.BufferedSink) {
        val stream = context.contentResolver.openInputStream(uri) ?: throw LinkFailure("FILE_UNREADABLE", "无法读取选中的文件")
        stream.use { input ->
          val buf = ByteArray(32 * 1024)
          var total = 0L
          while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            total += n
            if (total > maxBytes) throw LinkFailure("ARTIFACT_TOO_LARGE", "文件超过单文件上限 ${AnyLinkFiles.formatSize(maxBytes)}")
            sink.write(buf, 0, n)
          }
          if (total == 0L) throw LinkFailure("FILE_EMPTY", "文件为空，未发送")
        }
      }
    }
    val request = Request.Builder()
      .url(connection.server + "/edge/v1/artifacts")
      .header("Authorization", "Bearer ${connection.token}")
      .header("X-AnyLink-Filename", java.net.URLEncoder.encode(safeName, "UTF-8").replace("+", "%20"))
      .header("X-AnyLink-Content-Type", safeMime)
      .post(body)
      .build()
    val call = transferHttp.newCall(request)
    inFlight.add(call)
    try {
      call.execute().use { response ->
        val raw = response.body.string()
        val data = runCatching { linkJson.parseToJsonElement(raw).jsonObject }.getOrNull()
        if (!response.isSuccessful || data == null) {
          val code = (data?.get("error") as? JsonObject)?.text("code")?.takeIf { it.isNotBlank() } ?: "HTTP_${response.code}"
          val msg = (data?.get("error") as? JsonObject)?.text("message")?.takeIf { it.isNotBlank() } ?: "上传附件失败：$code"
          throw LinkFailure(code, msg, response.code >= 500)
        }
        data
      }
    } catch (error: IOException) {
      throw if (error is LinkFailure) error else LinkFailure("TRANSPORT_ERROR", "上传附件连接中断", false)
    } finally { inFlight.remove(call) }
  }

  override suspend fun downloadArtifact(artifactId: String): DownloadedArtifact = withContext(Dispatchers.IO) {
    val encodedId = java.net.URLEncoder.encode(artifactId.trim(), "UTF-8")
    val request = Request.Builder().url(connection.server + "/edge/v1/artifacts/$encodedId").header("Authorization", "Bearer ${connection.token}").get().build()
    val call = transferHttp.newCall(request)
    inFlight.add(call)
    try {
      call.execute().use { response ->
        if (!response.isSuccessful) {
          val raw = runCatching { response.body.string() }.getOrDefault("")
          val code = runCatching { (linkJson.parseToJsonElement(raw).jsonObject["error"] as? JsonObject)?.text("code") }.getOrNull()?.takeIf { it.isNotBlank() } ?: "HTTP_${response.code}"
          throw LinkFailure(code, "下载附件失败：$code", response.code >= 500)
        }
        val bytes = response.body.bytes()
        if (bytes.size.toLong() > AnyLinkFiles.MAX_BYTES + 1024L) throw LinkFailure("ARTIFACT_TOO_LARGE", "下载的附件超过 200 MiB 上限")
        val actualSha = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val expectedSha = response.header("X-AnyLink-SHA256")?.trim().orEmpty()
        if (expectedSha.isNotBlank() && !expectedSha.equals(actualSha, ignoreCase = true)) {
          throw LinkFailure("SHA256_MISMATCH", "附件完整性校验未通过")
        }
        val rawName = response.header("X-AnyLink-Filename")?.let { runCatching { java.net.URLDecoder.decode(it, "UTF-8") }.getOrDefault(it) } ?: "attachment.bin"
        val mime = response.header("Content-Type")?.substringBefore(';')?.trim()?.ifBlank { "application/octet-stream" } ?: "application/octet-stream"
        DownloadedArtifact(bytes = bytes, filename = AnyLinkFiles.sanitizeFilename(rawName), contentType = mime, sha256 = actualSha)
      }
    } catch (error: IOException) {
      throw if (error is LinkFailure) error else LinkFailure("TRANSPORT_ERROR", "下载附件连接中断", false)
    } finally { inFlight.remove(call) }
  }

  override suspend fun downloadArtifactToStorage(
    context: android.content.Context,
    artifactId: String,
    preferredFilename: String,
    preferredMime: String,
    expectedSha256: String,
    maxBytes: Long,
  ): Pair<SavedFile, String> = withContext(Dispatchers.IO) {
    val encodedId = java.net.URLEncoder.encode(artifactId.trim(), "UTF-8")
    val request = Request.Builder().url(connection.server + "/edge/v1/artifacts/$encodedId").header("Authorization", "Bearer ${connection.token}").get().build()
    val call = transferHttp.newCall(request)
    inFlight.add(call)
    try {
      call.execute().use { response ->
        if (!response.isSuccessful) {
          val raw = runCatching { response.body.string() }.getOrDefault("")
          val code = runCatching { (linkJson.parseToJsonElement(raw).jsonObject["error"] as? JsonObject)?.text("code") }.getOrNull()?.takeIf { it.isNotBlank() } ?: "HTTP_${response.code}"
          throw LinkFailure(code, "下载附件失败：$code", response.code >= 500)
        }
        val headerName = response.header("X-AnyLink-Filename")?.let { runCatching { java.net.URLDecoder.decode(it, "UTF-8") }.getOrDefault(it) } ?: "attachment.bin"
        val headerMime = response.header("Content-Type")?.substringBefore(';')?.trim()?.ifBlank { "application/octet-stream" } ?: "application/octet-stream"
        val checkSha = expectedSha256.ifBlank { response.header("X-AnyLink-SHA256")?.trim().orEmpty() }
        AnyLinkFiles.streamToSavedFile(
          context = context,
          input = response.body.byteStream(),
          filename = preferredFilename.ifBlank { headerName },
          contentType = preferredMime.ifBlank { headerMime },
          maxBytes = maxBytes,
          expectedSha256 = checkSha,
        )
      }
    } catch (error: IOException) {
      throw if (error is LinkFailure) error else LinkFailure("TRANSPORT_ERROR", "下载附件连接中断", false)
    } finally { inFlight.remove(call) }
  }

  override fun cancel() {
    for (c in inFlight.toList()) runCatching { c.cancel() }
  }
}

/** Real-time Protocol v3.2 WebSocket client (/edge/v1/ws) with seq cursor resume, pong watchdog, and Full Jitter backoff. */
internal class AnyLinkWebSocket(
  private val connection: CloudConnection,
  private val onState: (Boolean) -> Unit = {},
  private val onFrame: (JsonObject) -> Unit,
) {
  private val http = OkHttpClient.Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .pingInterval(20, TimeUnit.SECONDS)
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .build()
  private val scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "anylink-ws-bus").apply { isDaemon = true }
  }
  @Volatile private var ws: WebSocket? = null
  @Volatile private var pendingReconnect: ScheduledFuture<*>? = null
  @Volatile private var pingTask: ScheduledFuture<*>? = null
  @Volatile private var pongWatchdog: ScheduledFuture<*>? = null
  @Volatile private var closedByUser = false
  @Volatile private var attempt = 0
  @Volatile var lastSeq: Long = 0L
    private set
  @Volatile var connected: Boolean = false
    private set

  fun connect() {
    closedByUser = false
    attempt = 0
    pendingReconnect?.cancel(false)
    pendingReconnect = null
    openNow()
  }

  private fun stopHeartbeats() {
    pingTask?.cancel(false); pingTask = null
    pongWatchdog?.cancel(false); pongWatchdog = null
  }

  private fun startHeartbeats(activeWs: WebSocket) {
    stopHeartbeats()
    pingTask = runCatching {
      scheduler.scheduleWithFixedDelay({
        if (closedByUser || ws !== activeWs) return@scheduleWithFixedDelay
        val ok = runCatching { activeWs.send("""{"type":"ping","ts":${System.currentTimeMillis()}}""") }.getOrDefault(false)
        if (!ok) {
          runCatching { activeWs.cancel() }
          return@scheduleWithFixedDelay
        }
        if (pongWatchdog == null || pongWatchdog?.isDone == true) {
          pongWatchdog = runCatching {
            scheduler.schedule({
              if (ws === activeWs) runCatching { activeWs.close(4000, "Pong timeout") }
            }, 15, TimeUnit.SECONDS)
          }.getOrNull()
        }
      }, 20, 20, TimeUnit.SECONDS)
    }.getOrNull()
  }

  private fun openNow() {
    if (closedByUser) return
    stopHeartbeats()
    val prev = ws; ws = null; runCatching { prev?.cancel() }
    val req = Request.Builder()
      .url(connection.wsUrl(lastSeq))
      .header("Authorization", "Bearer ${connection.token}")
      .build()
    ws = http.newWebSocket(req, object : WebSocketListener() {
      override fun onMessage(webSocket: WebSocket, text: String) {
        pongWatchdog?.cancel(false); pongWatchdog = null
        val frame = runCatching { linkJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        frame["seq"]?.jsonPrimitive?.longOrNull?.let { if (it > lastSeq) lastSeq = it }
        if (frame.text("type") == "hello") {
          attempt = 0
          frame["latest_event_seq"]?.jsonPrimitive?.longOrNull?.let { if (lastSeq == 0L) lastSeq = it }
          connected = true
          startHeartbeats(webSocket)
          onState(true)
        }
        onFrame(frame)
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        handleDrop(code)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = handleDrop(code)
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = handleDrop(response?.code ?: 1006)
    })
  }

  fun send(frame: JsonObject): Boolean = ws?.send(frame.toString()) == true

  fun ackReceipt(taskId: String): Boolean = send(jsonObject("type" to str("task.receipt_ack"), "task_id" to str(taskId)))

  private fun handleDrop(code: Int) {
    stopHeartbeats()
    markClosed()
    if (closedByUser || code == 4001 || code == 4003) return
    val capMs = minOf(30_000L, 1000L * (1L shl minOf(attempt, 5)))
    val delayMs = Random.nextLong(500L, maxOf(600L, capMs))
    attempt++
    pendingReconnect?.cancel(false)
    pendingReconnect = runCatching { scheduler.schedule({ if (!closedByUser) openNow() }, delayMs, TimeUnit.MILLISECONDS) }.getOrNull()
  }

  private fun markClosed() {
    if (connected) {
      connected = false
      onState(false)
    }
  }

  fun close() {
    closedByUser = true
    stopHeartbeats()
    pendingReconnect?.cancel(false)
    pendingReconnect = null
    val current = ws
    ws = null
    markClosed()
    runCatching { current?.close(1000, "closed") }
  }
}

/** Tools become executable only after finish_reason AND the terminal SSE event. */
internal class CompletionCollector(private val onText: (String) -> Unit) {
  private data class Tool(var id: String = "", var name: String = "", var arguments: String = "")
  private val tools = sortedMapOf<Int, Tool>()
  private val text = StringBuilder()
  private var reason = ""
  private var done = false
  fun event(raw: String): Boolean {
    val data = raw.trimEnd('\n')
    if (data.isBlank()) return false
    if (data == "[DONE]") { done = true; return true }
    val payload = linkJson.parseToJsonElement(data).jsonObject
    if (payload["error"] != null) throw LinkFailure("MODEL_STREAM_ERROR", "模型流返回错误", true)
    val choice = (payload["choices"] as? JsonArray)?.firstOrNull() as? JsonObject ?: return false
    reason = choice.text("finish_reason").ifBlank { reason }
    val delta = choice["delta"] as? JsonObject ?: return false
    text.append(delta.text("content")); onText(text.toString())
    for (part in delta["tool_calls"] as? JsonArray ?: JsonArray(emptyList())) {
      val item = part.jsonObject; val index = item["index"]?.jsonPrimitive?.intOrNull
      if (index == null || index !in 0..15) throw LinkFailure("BAD_TOOL_CALL", "工具格式未确认", true)
      val tool = tools.getOrPut(index) { Tool() }; val function = item["function"] as? JsonObject
      tool.id += item.text("id"); tool.name += function?.text("name").orEmpty(); tool.arguments += function?.text("arguments").orEmpty()
      if (tool.arguments.length > 32000) throw LinkFailure("BAD_TOOL_CALL", "工具参数过长", true)
    }
    return false
  }
  fun finish(): JsonObject {
    if (!done || reason.isBlank() || (tools.isNotEmpty() && reason != "tool_calls")) throw LinkFailure("INCOMPLETE_RESPONSE", "模型工具调用未完整结束，未执行工具", true)
    if (text.length > 100000) throw LinkFailure("RESPONSE_TOO_LARGE", "回复过长", true)
    val seen = mutableSetOf<String>()
    val calls = tools.values.map { tool ->
      if (tool.id.isBlank() || !seen.add(tool.id) || !Regex("[a-zA-Z0-9_-]+").matches(tool.name)) throw LinkFailure("BAD_TOOL_CALL", "工具编号或名称无效", true)
      linkJson.parseToJsonElement(tool.arguments).jsonObject
      jsonObject("id" to str(tool.id), "type" to str("function"), "function" to jsonObject("name" to str(tool.name), "arguments" to str(tool.arguments)))
    }
    return buildJsonObject { put("role", "assistant"); put("content", text.toString()); if (calls.isNotEmpty()) put("tool_calls", JsonArray(calls)) }
  }
}
