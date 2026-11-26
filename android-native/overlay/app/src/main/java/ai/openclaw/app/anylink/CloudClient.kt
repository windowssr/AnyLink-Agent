package ai.openclaw.app.anylink

import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
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
  fun wsUrl(): String {
    val base = server.trimEnd('/')
    return when {
      base.startsWith("https://") -> "wss://" + base.removePrefix("https://") + "/edge/v1/ws"
      base.startsWith("http://") -> "ws://" + base.removePrefix("http://") + "/edge/v1/ws"
      else -> "$base/edge/v1/ws"
    }
  }

  companion object {
    private fun serverUrl(server: String) = server.trim().toHttpUrl().also { url ->
      require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null && url.encodedPath == "/") { "请填写服务器根地址，不含路径、账号或查询参数" }
      require(url.isHttps || url.host in setOf("localhost", "127.0.0.1", "::1")) { "远程连接需要 HTTPS；本机调试可用回环隧道" }
    }
    private val joinHttp = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
      .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS).build()

    /** Join with the owner key: upserts this install's device (with optional unique slug) and android-dafeiyu agent. */
    suspend fun join(server: String, joinKey: String, installId: String, deviceName: String, deviceSlug: String = ""): CloudConnection = withContext(Dispatchers.IO) {
      require(joinKey.length >= 24 && !joinKey.any { it == '\n' || it == '\r' }) { "请填写服务器签发的加入密钥" }
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
      val request = Request.Builder().url("$base/edge/v1/connect").header("Authorization", "Bearer $joinKey")
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
  fun cancel()
}

/** Thread-safe AnyLink HTTP client. Tracks every in-flight call safely so concurrent
 * requests never clobber each other's cancellation handles. */
internal class CloudClient(private val connection: CloudConnection) : LinkTransport {
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(125, TimeUnit.SECONDS).callTimeout(130, TimeUnit.SECONDS).build()
  private val inFlight = ConcurrentHashMap.newKeySet<Call>()

  private fun call(method: String, path: String, body: JsonObject?, key: String?, revision: Int?): Call {
    require(path.startsWith('/') && !path.startsWith("//"))
    val request = Request.Builder().url(connection.server + path).header("Authorization", "Bearer ${connection.token}")
    if (key != null) request.header("Idempotency-Key", key)
    if (revision != null) request.header("If-Match", revision.toString())
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

  override suspend fun completion(body: JsonObject, onText: (String) -> Unit): JsonObject = withContext(Dispatchers.IO) {
    val call = call("POST", "/model/v1/chat/completions", body, null, null)
    inFlight.add(call)
    try {
      call.execute().use { response ->
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
      throw if (error is LinkFailure) error else LinkFailure("STREAM_INCOMPLETE", "模型响应未完整确认，没有自动重发", true)
    } catch (_: Exception) {
      throw LinkFailure("INVALID_STREAM", "模型响应格式未完整确认，没有自动重发或执行工具", true)
    } finally { inFlight.remove(call) }
  }

  override fun cancel() {
    for (c in inFlight.toList()) runCatching { c.cancel() }
  }
}

/** Real-time Protocol v3 WebSocket client (/edge/v1/ws) backed by OkHttp. */
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
  @Volatile private var ws: WebSocket? = null
  @Volatile var connected: Boolean = false
    private set

  fun connect() {
    close()
    val req = Request.Builder()
      .url(connection.wsUrl())
      .header("Authorization", "Bearer ${connection.token}")
      .build()
    ws = http.newWebSocket(req, object : WebSocketListener() {
      override fun onMessage(webSocket: WebSocket, text: String) {
        val frame = runCatching { linkJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        if (frame.text("type") == "hello") {
          connected = true
          onState(true)
        }
        onFrame(frame)
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        markClosed()
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = markClosed()
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = markClosed()
    })
  }

  fun send(frame: JsonObject): Boolean = ws?.send(frame.toString()) == true

  private fun markClosed() {
    if (connected) {
      connected = false
      onState(false)
    }
  }

  fun close() {
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
