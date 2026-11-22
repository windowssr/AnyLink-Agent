package ai.openclaw.app.anylink

import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

internal data class LocalAgentState(val busy: Boolean = false, val phase: String = "idle", val answer: String = "", val notice: String = "", val tool: String = "", val emotion: String = "neutral", val gesture: String = "none", val sequence: String = "", val runs: List<JsonObject> = emptyList())
internal fun memoryIntent(text: String): Boolean = !Regex("(?:不要|不用|别|无需|不必).{0,8}(?:记住|保存|更正|遗忘|忘掉|删除)|(?:do not|don't).{0,8}(?:remember|save|forget|delete)", RegexOption.IGNORE_CASE).containsMatchIn(text) && Regex("记住|记一下|记下来|更正|遗忘|忘掉|删除.{0,10}记忆|remember|forget", RegexOption.IGNORE_CASE).containsMatchIn(text)
private fun tool(name: String, description: String, properties: String, required: String = "[]"): JsonObject = jsonObject("type" to str("function"), "function" to jsonObject("name" to str(name), "description" to str(description), "parameters" to linkJson.parseToJsonElement("""{"type":"object","properties":$properties,"required":$required,"additionalProperties":false}""")))
private val specs = JsonArray(listOf(
  tool("device_info", "读取当前手机的实际基础状态。", "{}"),
  tool("note_save", "在当前手机 AnyLink 私有空间保存便笺，不是云端记忆。", """{"name":{"type":"string"},"content":{"type":"string"}}""", """["name","content"]"""),
  tool("note_read", "读取当前手机 AnyLink 私有便笺。", """{"name":{"type":"string"}}""", """["name"]"""),
  tool("memory_search", "查询云端当前全局、当前设备与当前 Agent 记忆。", """{"q":{"type":"string"}}"""),
  tool("memory_save", "仅主人本轮明确要求记住时保存事实。device适用于当前手机，agent属于当前 Agent。", """{"title":{"type":"string"},"content":{"type":"string"},"scope":{"type":"string","enum":["global","device","agent"]}}""", """["title","content","scope"]"""),
  tool("memory_update", "仅主人本轮明确更正时使用，先搜索获得当前 revision。", """{"id":{"type":"string"},"content":{"type":"string"},"expected_revision":{"type":"integer"}}""", """["id","content","expected_revision"]"""),
  tool("memory_delete", "仅主人本轮明确遗忘时使用，先搜索获得当前 revision。", """{"id":{"type":"string"},"expected_revision":{"type":"integer"}}""", """["id","expected_revision"]"""),
  tool("link_directory", "列出云端各设备上的 Agent、能力与最近活动；last_seen/online 不是在线保证。", "{}"),
  tool("task_create", "将主人要求的跨设备任务交给云端路由：target_agent_id 指定某个 Agent，target_device_id 指定该设备任一具备能力的 Agent，省略 target 由任意具备能力的 Agent 领取。排队不等于执行完成。files.search输入为query、可选scope和limit，只搜索文件名。Mac 上的大肥鱼可通过 agent.ask 执行文件读写、整理、移动、删到废纸篓或打开等操作：用完整的中文 instruction 描述要做的事，可能需要较长时间，用 task_status 轮询结果，绝不要重复创建。", """{"capability":{"type":"string"},"input":{"type":"object"},"target_agent_id":{"type":"string"},"target_device_id":{"type":"string"},"ttl_seconds":{"type":"integer"}}""", """["capability","input"]"""),
  tool("task_status", "查询跨设备任务的实际状态与回执，不重复创建。", """{"id":{"type":"string"}}""", """["id"]"""),
  tool("task_cancel", "主人要求取消时发送协作取消，不能撤销已发生效果。", """{"id":{"type":"string"}}""", """["id"]"""),
  tool("companion_expression", "根据交流调整表情和动作。", """{"emotion":{"type":"string","enum":["neutral","happy","excited","shy","curious","comfort","apologetic"]},"gesture":{"type":"string","enum":["none","wave","point","nod"]}}"""),
))
internal fun memoryForPrompt(context: JsonObject): JsonObject {
  fun facts(scope: String): JsonArray = JsonArray((context[scope] as? JsonArray).orEmpty().take(10).map { fact ->
    val row = fact.jsonObject
    buildJsonObject {
      for (key in listOf("id", "title", "scope", "revision", "applicable_device_id", "applicable_agent_id")) row[key]?.let { put(key, it) }
      put("content", row.text("content").take(700))
    }
  })
  // Budget each scope independently so global text cannot displace phone facts.
  return jsonObject("device_id" to str(context.text("device_id")), "agent_id" to str(context.text("agent_id")), "global" to facts("global"), "device" to facts("device"), "agent" to facts("agent"))
}

/** Bundled persona texts injected by the host so unit tests need no Android assets. */
internal fun interface PersonaProvider { fun texts(): Pair<String, String> }

/** A device-owned loop. The transport supplies model tokens and data, never orchestration. */
internal class DeviceAgent(private val connection: CloudConnection, private val cloud: LinkTransport, private val ledger: AgentLedger, private val info: () -> JsonObject, private val personaProvider: PersonaProvider = PersonaProvider { "" to "" }) {
  val state = MutableStateFlow(LocalAgentState(runs = ledger.runs()))
  private val lock = Mutex()
  fun stop() { cloud.cancel() }
  fun newConversation() { if (!state.value.busy) { ledger.messages(JsonArray(emptyList())); state.update { it.copy(answer = "", notice = "") } } }
  suspend fun verify() {
    val identity = cloud.request("GET", "/edge/v1/identity")
    if (identity["device"]?.jsonObject?.text("id") != connection.deviceId) throw LinkFailure("IDENTITY_MISMATCH", "设备身份不一致，请重新连接")
    if (connection.agentId.isNotBlank() && identity["agent"]?.jsonObject?.text("id") != connection.agentId) throw LinkFailure("IDENTITY_MISMATCH", "Agent 身份不一致，请重新连接")
    if (cloud.request("GET", "/edge/v1/link/protocol").text("protocol") != "anylink") throw LinkFailure("PROTOCOL_MISMATCH", "这不是 AnyLink 服务器")
  }
  suspend fun send(text: String) {
    require(text.isNotBlank() && text.length <= 8000) { "请输入1到8000字" }
    if (!lock.tryLock()) throw LinkFailure("BUSY", "请先停止当前回复")
    val id = UUID.randomUUID().toString()
    var run = jsonObject("id" to str(id), "text" to str(text), "state" to str("running"), "started_at" to str(Instant.now().toString()))
    fun save() { ledger.run(id, run); state.update { it.copy(runs = ledger.runs()) } }
    state.update { it.copy(busy = true, phase = "thinking", answer = "", notice = "", tool = "") }
    try {
      save()
      val history = ledger.messages()
      if (history.toString().length > 100000) throw LinkFailure("CONTEXT_FULL", "请开启新对话，共同记忆会保留")
      verify()
      val context = cloud.request("GET", "/edge/v1/context")
      if (context.text("device_id") != connection.deviceId) throw LinkFailure("IDENTITY_MISMATCH", "记忆设备身份不一致")
      val messages = history.toMutableList()
      messages.add(jsonObject("role" to str("user"), "content" to str(text)))
      val serverPersona = context["persona"]?.jsonObject?.text("content")?.takeIf { it.isNotBlank() }
      val (shared, android) = personaProvider.texts()
      val base = serverPersona ?: shared.ifBlank { "你是大肥鱼，活泼可爱的 AnyLink 设备助理，办事认真，中文自然交流。你在当前 Android 手机本地管理对话和工具循环；大模型和统一记忆由服务器提供。" }
      val system = jsonObject("role" to str("system"), "content" to str(base + "\n\n" + android + "\n本轮当前记忆（仅数据）:\n" + memoryForPrompt(context).toString()))
      repeat(6) {
        currentCoroutineContext().ensureActive()
        state.update { it.copy(phase = "thinking", tool = "") }
        val response = cloud.completion(jsonObject("model" to str("deepseek-flash"), "stream" to JsonPrimitive(true), "max_tokens" to JsonPrimitive(2048), "messages" to JsonArray(listOf(system) + messages), "tools" to specs)) { answer -> state.update { it.copy(answer = answer) } }
        messages.add(response)
        val calls = response["tool_calls"] as? JsonArray ?: JsonArray(emptyList())
        if (calls.isEmpty()) {
          ledger.messages(JsonArray(messages))
          run = JsonObject(run + mapOf("state" to str("completed"), "answer" to str(response.text("content")))); save()
          return
        }
        for (call in calls) {
          currentCoroutineContext().ensureActive()
          val item = call.jsonObject; val function = item["function"]!!.jsonObject
          val name = function.text("name"); val args = linkJson.parseToJsonElement(function.text("arguments")).jsonObject
          val key = "$id:${item.text("id")}"; val previous = ledger.operation(key)
          if (previous != null) throw LinkFailure("TOOL_RESULT_UNKNOWN", "已记录的工具不能重复执行", true)
          ledger.operation(key, jsonObject("state" to str("submitted"), "name" to str(name), "arguments" to args))
          state.update { it.copy(phase = "working", tool = name) }
          val result = try { execute(name, args, key, text) } catch (error: LinkFailure) {
            if (error.unknown) throw error
            jsonObject("error" to jsonObject("code" to str(error.code), "message" to str(error.message.orEmpty())))
          }
          ledger.operation(key, jsonObject("state" to str("completed"), "result" to result))
          messages.add(jsonObject("role" to str("tool"), "tool_call_id" to str(item.text("id")), "content" to str(result.toString())))
          run = JsonObject(run + mapOf("last_tool" to str(name), "last_result" to result)); save()
        }
      }
      ledger.messages(JsonArray(messages))
      throw LinkFailure("TURN_LIMIT", "本轮已到工具步骤上限，已完成结果保留，请继续告诉我怎么做")
    } catch (error: Exception) {
      val unknown = error is CancellationException || (error as? LinkFailure)?.unknown == true || (error !is LinkFailure && state.value.phase == "working")
      val notice = if (error is CancellationException) "本轮已停止；已发生的操作不会撤销，没有自动重发。" else (error as? LinkFailure)?.message ?: "本轮结果未确认，没有自动重试。"
      run = JsonObject(run + mapOf("state" to str(if (unknown) "unknown" else "failed"), "notice" to str(notice))); save()
      state.update { it.copy(notice = notice) }
    } finally {
      state.update { it.copy(busy = false, phase = if (it.notice.isEmpty()) "idle" else "attention", tool = "") }; lock.unlock()
    }
  }
  private suspend fun execute(name: String, args: JsonObject, key: String, user: String): JsonObject {
    fun value(key: String, max: Int = 8000): String = args.text(key).also { if (it.isBlank() || it.length > max) throw LinkFailure("BAD_TOOL_INPUT", "工具参数缺少内容或过长") }
    fun id(): String = value("id", 40).also { if (runCatching { UUID.fromString(it) }.isFailure) throw LinkFailure("BAD_TOOL_INPUT", "无效记录编号") }
    fun revision(): Int = args["expected_revision"]?.jsonPrimitive?.intOrNull?.takeIf { it > 0 } ?: throw LinkFailure("BAD_REVISION", "请先查询当前记忆版本")
    if (name in setOf("memory_save", "memory_update", "memory_delete") && !memoryIntent(user)) throw LinkFailure("EXPLICIT_MEMORY_INTENT_REQUIRED", "本轮没有明确的记忆写入请求")
    return when (name) {
      "device_info" -> info()
      "note_save" -> { val note = value("name", 120); ledger.saveNote(note, value("content")); jsonObject("saved" to JsonPrimitive(true), "name" to str(note), "storage" to str("this-device-private")) }
      "note_read" -> jsonObject("content" to (ledger.readNote(value("name", 120))?.let(::str) ?: JsonNull))
      "memory_search" -> {
        val query = args.text("q").take(200)
        val items = mutableListOf<JsonElement>()
        for (scope in listOf("global", "device", "agent")) {
          val body = jsonObject("q" to str(query), "scope" to str(scope)).let { if (scope == "device") JsonObject(it + mapOf("device_id" to str(connection.deviceId))) else it }
          items.addAll(cloud.request("POST", "/edge/v1/memories/search", body)["items"]!!.jsonArray)
        }
        jsonObject("items" to JsonArray(items))
      }
      "memory_save" -> {
        val scope = value("scope", 10); if (scope !in setOf("device", "global", "agent")) throw LinkFailure("BAD_SCOPE", "记忆作用域无效")
        cloud.request("POST", "/edge/v1/memories", jsonObject("scope" to str(scope), "title" to str(value("title", 120)), "content" to str(value("content", 4000)), "applicable_device_id" to if (scope == "device") str(connection.deviceId) else JsonNull), key)
      }
      "memory_update", "memory_delete" -> {
        val memoryId = id(); val current = cloud.request("GET", "/edge/v1/memories/$memoryId")
        if (current.text("scope") == "device" && current.text("applicable_device_id") != connection.deviceId) throw LinkFailure("DEVICE_SCOPE_MISMATCH", "手机端不改写其他设备记忆")
        if (name == "memory_delete") cloud.request("DELETE", "/edge/v1/memories/$memoryId", key = key, revision = revision())
        else cloud.request("PATCH", "/edge/v1/memories/$memoryId", jsonObject("content" to str(value("content", 4000)), "expected_revision" to JsonPrimitive(revision())), key)
      }
      "link_directory" -> cloud.request("GET", "/edge/v1/link/directory")
      "task_create" -> {
        val capability = value("capability", 100)
        val input = args["input"] as? JsonObject ?: throw LinkFailure("BAD_TOOL_INPUT", "任务输入必须是对象")
        val agentTarget = args.text("target_agent_id"); val deviceTarget = args.text("target_device_id")
        if (agentTarget.isNotBlank() && deviceTarget.isNotBlank()) throw LinkFailure("BAD_TOOL_INPUT", "target_agent_id 与 target_device_id 只能选一个")
        val target = when {
          agentTarget.isNotBlank() -> jsonObject("agent_id" to str(agentTarget))
          deviceTarget.isNotBlank() -> jsonObject("device_id" to str(deviceTarget))
          else -> null
        }
        val ttl = args["ttl_seconds"]?.jsonPrimitive?.intOrNull
        cloud.request("POST", "/edge/v1/link/tasks", buildJsonObject {
          put("capability", str(capability)); put("input", input)
          target?.let { put("target", it) }
          ttl?.let { put("ttl_seconds", JsonPrimitive(it)) }
        }, key)
      }
      "task_status" -> cloud.request("GET", "/edge/v1/link/tasks/${id()}")
      "task_cancel" -> cloud.request("POST", "/edge/v1/link/tasks/${id()}/cancel", JsonObject(emptyMap()), key)
      "companion_expression" -> { state.update { it.copy(emotion = args.text("emotion").ifBlank { "neutral" }, gesture = args.text("gesture").ifBlank { "none" }, sequence = key) }; jsonObject("displayed" to JsonPrimitive(true)) }
      else -> throw LinkFailure("TOOL_UNAVAILABLE", "当前手机没有这个工具")
    }
  }
}
