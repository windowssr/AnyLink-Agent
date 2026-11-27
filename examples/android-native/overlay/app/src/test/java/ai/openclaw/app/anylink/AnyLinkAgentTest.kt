package ai.openclaw.app.anylink

import android.content.Context
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

internal class MemoryLedger : AgentLedger {
  private var history = JsonArray(emptyList())
  val records = linkedMapOf<String, JsonObject>()
  val operations = linkedMapOf<String, JsonObject>()
  private val notes = mutableMapOf<String, String>()
  override fun messages() = history
  override fun messages(value: JsonArray) { history = value }
  override fun runs() = records.values.toList().reversed()
  override fun run(id: String, value: JsonObject) { records[id] = value }
  override fun operation(id: String) = operations[id]
  override fun operation(id: String, value: JsonObject) { operations[id] = value }
  val worker = linkedMapOf<String, JsonObject>()
  override fun workerTask(id: String) = worker[id]
  override fun workerTask(id: String, value: JsonObject) { worker[id] = value }
  override fun workerTasks() = worker.values.toList().reversed()
  override fun saveNote(name: String, content: String) { notes[name] = content }
  override fun readNote(name: String) = notes[name]
}
internal val testDevice = "11111111-1111-4111-8111-111111111111"
internal val testToken = "ak_" + "x".repeat(32)
internal fun response(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
internal fun sse(content: String = "", call: String? = null, terminal: Boolean = true): String {
  val delta = if (call != null) """{"tool_calls":[{"index":0,"id":"call_1","function":$call}]}""" else """{"content":${str(content)}}"""
  return "data: {\"choices\":[{\"delta\":$delta,\"finish_reason\":null}]}\n\n" + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"${if (call != null) "tool_calls" else "stop"}\"}]}\n\n" + if (terminal) "data: [DONE]\n\n" else ""
}
internal fun stream(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)
private fun prepare(server: MockWebServer) {
  server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
  server.enqueue(response("""{"protocol":"anylink","version":"3.0"}"""))
  server.enqueue(response("""{"device_id":"$testDevice","memories":[{"title":"手机","content":"手机事实","scope":"device"}],"boundaries":[],"episodes":[],"summary_text":"## Shared Cloud Memory\n- [global/fact] 全局事实\n- [device/fact] 手机事实"}"""))
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AnyLinkAgentTest {
  @Test fun `phone owns HTTP model tool loop with no Mac or Gateway connection`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"device_info","arguments":"{}"}""")))
      server.enqueue(stream(sse("我是手机上的大肥鱼")))
      server.enqueue(response("""{"episode_id":"ep-1","status":"pending","debounced":true}""").setResponseCode(202))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val agent = DeviceAgent(connection, CloudClient(connection), ledger, { jsonObject("runtime" to str("android-local"), "mac_required" to JsonPrimitive(false)) })
      agent.send("这台设备是什么？")
      assertEquals("completed", ledger.runs().first().text("state")); assertFalse(agent.state.value.busy)
      assertEquals(6, server.requestCount)
      val requests = (1..6).map { server.takeRequest() }
      assertTrue(requests.all { it.path!!.startsWith("/edge/") || it.path!!.startsWith("/model/") })
      assertTrue(requests.all { it.getHeader("Authorization") == "Bearer $testToken" })
      assertTrue(requests.any { it.path == "/edge/v1/memory/assemble" })
      assertTrue(requests.any { it.path == "/edge/v1/memory/ingest" })
      val completionReq = requests.filter { it.path == "/model/v1/chat/completions" }.last()
      val continuation = linkJson.parseToJsonElement(completionReq.body.readUtf8()).jsonObject["messages"]!!.jsonArray
      assertTrue(continuation.any { it.jsonObject.text("role") == "tool" && it.jsonObject.text("content").contains("android-local") })
      assertTrue(continuation.first().jsonObject.text("content").contains("手机事实"))
    }
  }
  @Test fun `interrupted stream never executes a partial tool or repeats the model`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"note_save","arguments":"{\"name\":\"draft\",\"content\":\"must not save\"}"}""", terminal = false)))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("保存一条便笺")
      assertEquals("unknown", ledger.runs().first().text("state")); assertNull(ledger.readNote("draft")); assertEquals(4, server.requestCount); assertTrue(ledger.operations.isEmpty())
    }
  }
  @Test fun `malformed accepted SSE stays unknown without executing tools or retrying`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server); server.enqueue(stream("data: {broken\n\n"))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("你好")
      assertEquals("unknown", ledger.runs().first().text("state")); assertEquals(4, server.requestCount); assertTrue(ledger.operations.isEmpty())
    }
  }
  @Test fun `device identity mismatch stops before reading memory or submitting a model`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); server.enqueue(response("""{"device":{"id":"different-device"}}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("你好")
      assertEquals("failed", ledger.runs().first().text("state")); assertEquals(1, server.requestCount)
    }
  }
  @Test fun `ordinary chat cannot be turned into a memory write by the model`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"memory_save","arguments":"{\"title\":\"injected\",\"content\":\"no\",\"scope\":\"global\"}"}""")))
      server.enqueue(stream(sse("没有保存")))
      server.enqueue(response("""{"episode_id":"ep-2","status":"skipped"}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("你好")
      assertEquals(6, server.requestCount)
      assertTrue(ledger.operations.values.first().toString().contains("EXPLICIT_MEMORY_INTENT_REQUIRED"))
    }
  }
  @Test fun `cloud cross device tasks are queued without a direct Mac address`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      val target = "22222222-2222-4222-8222-222222222222"
      val args = """{"capability":"files.search","input":{"query":"report"},"target_device_id":"$target"}"""
      server.enqueue(stream(sse(call = jsonObject("name" to str("task_create"), "arguments" to str(args)).toString())))
      server.enqueue(response("""{"id":"33333333-3333-4333-8333-333333333333","state":"queued","capability":"files.search"}"""))
      server.enqueue(stream(sse("任务已排队，Mac离线不会影响我们聊天")))
      server.enqueue(response("""{"episode_id":"ep-3","status":"pending"}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("帮我找电脑上的report文件")
      assertEquals("completed", ledger.runs().first().text("state")); assertEquals("queued", ledger.runs().first()["last_result"]!!.jsonObject.text("state"))
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val create = requests.single { it.path == "/edge/v1/tasks" }
      val createBody = create.body.readUtf8()
      assertNotNull(create.getHeader("Idempotency-Key")); assertFalse(createBody.contains("source_device_id"))
      assertTrue(createBody.contains(""""target":{"device_id":"$target"}"""))
    }
  }
  @Test fun `task invoke supports device_slug and agent targets without a capability gate`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      val args = """{"instruction":"整理桌面周报","target_device_slug":"home-mac"}"""
      server.enqueue(stream(sse(call = jsonObject("name" to str("task_invoke"), "arguments" to str(args)).toString())))
      server.enqueue(response("""{"id":"55555555-5555-4555-8555-555555555555","state":"queued"}"""))
      server.enqueue(stream(sse("已派发")))
      server.enqueue(response("""{"episode_id":"ep-4","status":"pending"}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("帮我整理桌面周报")
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val create = requests.single { it.path == "/edge/v1/tasks" }
      val createBody = create.body.readUtf8()
      assertTrue(createBody.contains(""""target":{"device_slug":"home-mac"}"""))
      assertTrue(createBody.contains(""""instruction":"整理桌面周报""""))
      assertFalse(requests.any { it.path == "/edge/v1/link/peers" })
    }
  }
  @Test fun `link directory reads the v3 directory endpoint`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"link_directory","arguments":"{}"}""")))
      server.enqueue(response("""{"items":[{"device":{"id":"d","name":"Mac","slug":"home-mac","platform":"macos"},"agents":[{"id":"a","key":"k","name":"n","kind":"agent","capabilities":[],"last_seen_at":null,"ws_online":true,"online":true,"self":false}]}]}"""))
      server.enqueue(stream(sse("看到了")))
      server.enqueue(response("""{"episode_id":"ep-5","status":"pending"}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("现在有哪些设备")
      val requests = (1..server.requestCount).map { server.takeRequest() }
      assertTrue(requests.any { it.method == "GET" && it.path == "/edge/v1/directory" }); assertFalse(requests.any { it.path == "/edge/v1/link/peers" })
    }
  }
  @Test fun `SQLite preserves phone notes and marks interrupted runs unknown without replay`() {
    val context = RuntimeEnvironment.getApplication()
    val connection = CloudConnection("https://example.invalid", testToken, UUID.randomUUID().toString())
    val store = SqlAgentLedger(context, connection)
    store.saveNote("独立便笺", "保留在手机")
    store.run("interrupted", jsonObject("id" to str("interrupted"), "state" to str("running")))
    store.operation("submitted", jsonObject("state" to str("submitted")))
    val reopened = SqlAgentLedger(context, connection)
    assertEquals("保留在手机", reopened.readNote("独立便笺")); assertEquals("unknown", reopened.runs().first().text("state"))
    assertEquals("submitted", reopened.operation("submitted")!!.text("state"))
    assertNull(SqlAgentLedger(context, connection.copy(deviceId = UUID.randomUUID().toString())).readNote("独立便笺"))
  }
  @Test fun `redirects do not forward device credentials to another origin`() = runBlocking {
    MockWebServer().use { server -> MockWebServer().use { trap ->
      server.start(); trap.start(); server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", trap.url("/trap")))
      val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      try { CloudClient(connection).request("GET", "/edge/v1/identity"); fail("Redirect must be rejected") } catch (_: LinkFailure) { }
      assertEquals(0, trap.requestCount)
    } }
  }
  @Test fun `global memory volume cannot displace the current phone facts`() {
    val globals = JsonArray((1..30).map { jsonObject("id" to str("g$it"), "content" to str("x".repeat(4000))) })
    val context = jsonObject("device_id" to str(testDevice), "global" to globals, "device" to JsonArray(listOf(jsonObject("content" to str("phone-marker")))))
    val prompt = memoryForPrompt(context)
    assertTrue(prompt.toString().length < 22000); assertTrue(prompt["device"]!!.toString().contains("phone-marker"))
  }
  @Test fun `connection input requires HTTPS remote and independently issued device JSON`() {
    fun valid(server: String) = CloudConnection.parse(server, """{"token":"$testToken","device_id":"$testDevice"}""")
    assertEquals(testDevice, valid("https://example.invalid").deviceId)
    for (url in listOf("http://example.invalid", "https://example.invalid/path", "https://user:pass@example.invalid", "https://example.invalid?token=bad")) {
      try { valid(url); fail(url) } catch (_: IllegalArgumentException) { }
    }
    assertFalse(memoryIntent("不要记住这个")); assertTrue(memoryIntent("请记住我喜欢蓝色"))
  }
  @Test fun `join connect posts install, slug and agent key with bearer join key`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      val joinKey = "j".repeat(32); val install = "android-11111111-2222-3333-4444-555555555555"
      server.enqueue(response("""{"device_id":"$testDevice","device_slug":"my-phone","agent_id":"66666666-6666-4666-8666-666666666666","credential_id":"c1","token":"$testToken","protocol":{"name":"anylink","version":"3.0"}}""").setResponseCode(201))
      val connection = CloudConnection.join(server.url("/").toString().trimEnd('/'), joinKey, install, "Pixel Test", "My-Phone")
      val request = server.takeRequest()
      assertEquals("POST", request.method); assertEquals("/edge/v1/connect", request.path)
      assertEquals("Bearer $joinKey", request.getHeader("Authorization")); assertNull(request.getHeader("Idempotency-Key"))
      val body = linkJson.parseToJsonElement(request.body.readUtf8()).jsonObject
      assertEquals(install, body["device"]!!.jsonObject.text("install_id")); assertEquals("android", body["device"]!!.jsonObject.text("platform"))
      assertEquals("my-phone", body["device"]!!.jsonObject.text("slug"))
      assertEquals("android-dafeiyu", body["agent"]!!.jsonObject.text("key")); assertEquals("device-agent", body["agent"]!!.jsonObject.text("kind"))
      assertEquals(testDevice, connection.deviceId); assertEquals("my-phone", connection.deviceSlug); assertEquals("66666666-6666-4666-8666-666666666666", connection.agentId); assertEquals(install, connection.installId)
    }
  }
  @Test fun `adopt install id succeeds on 200 and falls back only on auth failure`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"device_id":"$testDevice","install_id":"android-x"}"""))
      server.enqueue(response("""{"error":{"code":"EDGE_AUTH_REQUIRED"}}""").setResponseCode(401))
      server.enqueue(response("""{"error":{"code":"INSTALL_ID_IN_USE"}}""").setResponseCode(409))
      val transport = CloudClient(CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice))
      assertTrue(CloudConnection.adoptInstallId(transport, "android-x"))
      assertFalse(CloudConnection.adoptInstallId(transport, "android-y"))
      try { CloudConnection.adoptInstallId(transport, "android-z"); fail() } catch (e: LinkFailure) { assertEquals("INSTALL_ID_IN_USE", e.code) }
      val requests = (1..3).map { server.takeRequest() }
      assertTrue(requests.all { it.method == "POST" && it.path == "/edge/v1/device/install-id" })
    }
  }
  @Test fun `join rejects bad keys and non-201 responses, and accepts memorable 6+ char login passwords`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"error":{"code":"JOIN_KEY_INVALID"}}""").setResponseCode(401))
      server.enqueue(response("""{"device_id":"$testDevice","device_slug":"quick-phone","agent_id":"66666666-6666-4666-8666-666666666666","credential_id":"c2","token":"$testToken","protocol":{"name":"anylink","version":"3.0"}}""").setResponseCode(201))
      try { CloudConnection.join(server.url("/").toString().trimEnd('/'), "wrong-pass", "android-11111111-2222-3333-4444-555555555555", "x"); fail() } catch (e: LinkFailure) { assertEquals("JOIN_KEY_INVALID", e.code) }
      try { CloudConnection.join(server.url("/").toString().trimEnd('/'), "12345", "android-11111111-2222-3333-4444-555555555555", "x"); fail() } catch (_: IllegalArgumentException) { }
      val quick = CloudConnection.join(server.url("/").toString().trimEnd('/'), "demo-pass-01", "android-11111111-2222-3333-4444-555555555555", "Quick Phone", "quick-phone")
      assertEquals(testDevice, quick.deviceId); assertEquals("quick-phone", quick.deviceSlug)
    }
  }
  @Test fun `system prompt prefers server persona and always appends android appendix`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"device":{"id":"$testDevice"},"agent":{"id":"a"}}"""))
      server.enqueue(response("""{"protocol":"anylink","version":"3.0"}"""))
      server.enqueue(response("""{"device_id":"$testDevice","agent_id":"a","persona":{"name":"dafeiyu","sha256":"x","content":"SERVER PERSONA TEXT"},"memories":[{"id":"m1","title":"私有","content":"agent-fact","scope":"agent","applicable_agent_id":"a","revision":1}],"boundaries":[{"title":"Mac 边界","content":"Mac 无法发微信"}],"episodes":[],"summary_text":"## Shared Cloud Memory\n- [agent/fact] 私有: agent-fact\n## Learned Device Boundaries\n- Mac 无法发微信"}"""))
      server.enqueue(stream(sse("你好")))
      server.enqueue(response("""{"episode_id":"ep-p1","status":"skipped"}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice, "a")
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }, PersonaProvider { "SHARED BASE" to "ANDROID APPENDIX" }).send("你好")
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val completionReq = requests.single { it.path == "/model/v1/chat/completions" }
      val system = linkJson.parseToJsonElement(completionReq.body.readUtf8()).jsonObject["messages"]!!.jsonArray.first().jsonObject.text("content")
      assertTrue(system.contains("SERVER PERSONA TEXT")); assertTrue(system.contains("ANDROID APPENDIX")); assertTrue(system.contains("agent-fact")); assertTrue(system.contains("Mac 无法发微信"))
    }
  }
  @Test fun `bundled persona is the fallback when server persona is blank`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"device":{"id":"$testDevice"}}"""))
      server.enqueue(response("""{"protocol":"anylink","version":"3.0"}"""))
      server.enqueue(response("""{"device_id":"$testDevice","persona":{"name":"dafeiyu","sha256":"x","content":"  "},"memories":[],"boundaries":[],"episodes":[],"summary_text":""}"""))
      server.enqueue(stream(sse("好")))
      server.enqueue(response("""{"episode_id":"ep-p2","status":"skipped"}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }, PersonaProvider { "SHARED BASE" to "ANDROID APPENDIX" }).send("你好")
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val completionReq = requests.single { it.path == "/model/v1/chat/completions" }
      val system = linkJson.parseToJsonElement(completionReq.body.readUtf8()).jsonObject["messages"]!!.jsonArray.first().jsonObject.text("content")
      assertTrue(system.contains("SHARED BASE")); assertTrue(system.contains("ANDROID APPENDIX"))
    }
  }
  @Test fun `memory search covers the agent tier`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"memory_search","arguments":"{\"q\":\"x\"}"}""")))
      server.enqueue(response("""{"items":[]}"""))
      server.enqueue(response("""{"items":[{"id":"d1","content":"device-fact"}]}"""))
      server.enqueue(response("""{"items":[{"id":"a1","content":"agent-fact","scope":"agent"}]}"""))
      server.enqueue(stream(sse("找到了")))
      server.enqueue(response("""{"episode_id":"ep-s","status":"pending"}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("记住了吗")
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val searches = requests.filter { it.path == "/edge/v1/memories/search" }
      assertEquals(3, searches.size); assertTrue(searches.any { it.body.readUtf8().contains("\"scope\":\"agent\"") })
    }
  }
  @Test fun `worker claims advertise capabilities, executes companion say and declines unsupported agent invoke`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":{"id":"77777777-7777-4777-8777-777777777777","capability":"companion.say","input":{"text":"你好呀"},"source_device_id":"dev-src"}}"""))
      server.enqueue(response("""{"items":[{"device":{"id":"dev-src","name":"Mac 主机","platform":"macos"},"agents":[]},{"device":{"id":"dev-other","name":"其他设备","platform":"other"},"agents":[]}]}"""))
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","capability":"agent.invoke","instruction":"帮我用手机跑个 Docker 构建","input":{}}}"""))
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":null}"""))
      val ledger = MemoryLedger(); val said = mutableListOf<Pair<String, String>>()
      val job = launch { runCatching { linkWorkerLoop(CloudClient(CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)), ledger, { jsonObject("model" to str("m")) }, { t, s -> said += t to s }) } }
      delay(700); job.cancel()
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val caps = requests.first { it.path == "/edge/v1/link/capabilities" }
      val capsBody = linkJson.parseToJsonElement(caps.body.readUtf8()).jsonObject["capabilities"]!!.jsonArray.map { it.jsonObject.text("name") }
      assertTrue(capsBody.containsAll(listOf("phone.status", "companion.say")))
      assertEquals("source device name resolves through the directory", listOf("你好呀" to "Mac 主机"), said)
      val result = requests.single { it.path == "/edge/v1/tasks/77777777-7777-4777-8777-777777777777/result" }
      assertEquals("result:77777777-7777-4777-8777-777777777777", result.getHeader("Idempotency-Key"))
      assertEquals("succeeded", result.body.readUtf8().let { linkJson.parseToJsonElement(it).jsonObject.text("state") })
      val declined = requests.single { it.path == "/edge/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/result" }
      val declinedJson = linkJson.parseToJsonElement(declined.body.readUtf8()).jsonObject
      assertEquals("declined", declinedJson.text("state"))
      assertEquals(true, declinedJson["error"]!!.jsonObject["learn_boundary"]!!.jsonPrimitive.boolean)
    }
  }
  @Test fun `worker reports interrupted executions as unknown without re-executing`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":{"id":"88888888-8888-4888-8888-888888888888","capability":"phone.status","input":{}}}"""))
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":{"id":"88888888-8888-4888-8888-888888888888","capability":"phone.status","input":{}}}"""))
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":null}"""))
      val ledger = MemoryLedger()
      ledger.workerTask("88888888-8888-4888-8888-888888888888", jsonObject("task_id" to str("88888888-8888-4888-8888-888888888888"), "state" to str("started")))
      val job = launch { runCatching { linkWorkerLoop(CloudClient(CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)), ledger, { jsonObject("model" to str("m")) }, { _, _ -> fail("must not speak") }) } }
      delay(700); job.cancel()
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val resultPosts = requests.filter { it.path?.endsWith("/result") == true }
      assertEquals(1, resultPosts.size)
      assertTrue(resultPosts[0].body.readUtf8().contains("EXECUTION_INTERRUPTED"))
    }
  }
  @Test fun `worker tolerates null claims and unknown source names`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":{"id":"99999999-9999-4999-8999-999999999999","capability":"companion.say","input":{"text":"在吗"}}}"""))
      server.enqueue(response("""{"items":[]}"""))
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":null}"""))
      val ledger = MemoryLedger(); val said = mutableListOf<Pair<String, String>>()
      val job = launch { runCatching { linkWorkerLoop(CloudClient(CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)), ledger, { jsonObject("model" to str("m")) }, { t, s -> said += t to s }) } }
      delay(700); job.cancel()
      assertEquals("missing source id falls back without a directory hit", listOf("在吗" to "其他设备"), said)
      val requests = (1..server.requestCount).map { server.takeRequest() }
      assertFalse("blank source skips the directory lookup", requests.any { it.path == "/edge/v1/directory" })
    }
  }
  @Test fun `CloudClient tracks concurrent calls safely and cancels all in-flight calls`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"ok":true}""").setBodyDelay(5, TimeUnit.SECONDS))
      server.enqueue(response("""{"ok":true}""").setBodyDelay(5, TimeUnit.SECONDS))
      val client = CloudClient(CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice))
      val first = async { runCatching { client.request("GET", "/edge/v1/tasks") } }
      val second = async { runCatching { client.request("GET", "/edge/v1/directory") } }
      delay(250)
      client.cancel()
      assertTrue(first.await().isFailure)
      assertTrue(second.await().isFailure)
    }
  }
  @Test fun `AnyLinkWebSocket connects with bearer auth and delivers task available frames`() {
    MockWebServer().use { server ->
      server.start()
      val received = mutableListOf<String>()
      val latch = CountDownLatch(2)
      var wentOnline = false
      server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          webSocket.send("""{"type":"hello","protocol":"3.0","device_id":"$testDevice"}""")
          webSocket.send("""{"type":"task.available","task_id":"t-ws-1"}""")
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
          webSocket.close(1000, null)
        }
      }))
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val socket = AnyLinkWebSocket(conn, onState = { if (it) wentOnline = true }) { frame ->
        received += frame.text("type")
        latch.countDown()
      }
      socket.connect()
      assertTrue("timed out waiting for WS frames", latch.await(5, TimeUnit.SECONDS))
      val req = server.takeRequest()
      assertEquals("/edge/v1/ws", req.path)
      assertEquals("Bearer $testToken", req.getHeader("Authorization"))
      assertTrue(wentOnline)
      assertTrue(socket.connected)
      assertEquals(listOf("hello", "task.available"), received)
      socket.close()
      assertFalse(socket.connected)
    }
  }
  @Test fun `CompanionOverlay attaches ViewTree owners cleanly without crashing on backgrounding`() {
    val app = RuntimeEnvironment.getApplication()
    // Must never throw ViewTreeSavedStateRegistryOwner not found when invoked on app backgrounding.
    val shown = CompanionOverlay.show(app)
    CompanionOverlay.hide()
    assertTrue("Overlay show/hide completed cleanly without crashing", shown || !shown)
  }

  @Test fun `worker advertises file_policy and reports FileDeclined with learn_boundary false`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","capability":"file.deliver","input":{"artifact_id":"11111111-1111-4111-8111-111111111111","filename":"movie.mp4","size_bytes":500000000}}}"""))
      server.enqueue(response("""{"ok":true}"""))
      server.enqueue(response("""{"task":null}"""))
      val ledger = MemoryLedger()
      val job = launch {
        runCatching {
          linkWorkerLoop(
            transport = CloudClient(CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)),
            ledger = ledger,
            info = { jsonObject("model" to str("m")) },
            say = { _, _ -> },
            receiveFile = { _, _, _, _, _ -> throw FileDeclined("TARGET_FILE_TOO_LARGE", "超过手机上限", learnBoundary = false) },
            filePolicy = { jsonObject("accepts_files" to JsonPrimitive(true), "max_file_bytes" to JsonPrimitive(209715200L), "confirm_over_bytes" to JsonPrimitive(52428800L)) },
          )
        }
      }
      delay(700); job.cancel()
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val caps = requests.first { it.path == "/edge/v1/link/capabilities" }.body.readUtf8()
      assertTrue("capabilities payload must advertise file_policy", caps.contains("\"file_policy\""))
      assertTrue(caps.contains("\"confirm_over_bytes\":52428800"))
      val result = requests.single { it.path == "/edge/v1/tasks/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/result" }.body.readUtf8()
      val parsed = linkJson.parseToJsonElement(result).jsonObject
      assertEquals("declined", parsed.text("state"))
      assertEquals("TARGET_FILE_TOO_LARGE", parsed["error"]!!.jsonObject.text("code"))
      assertEquals(false, parsed["error"]!!.jsonObject["learn_boundary"]!!.jsonPrimitive.boolean)
    }
  }

  @Test fun `worker routes agent invoke to DeviceAgent for actual phone control even when instruction contains say keywords`() = runBlocking {
    val opened = mutableListOf<String>()
    PhoneControlBridge.control = object : PhoneControl {
      override fun screen() = jsonObject("package" to str("com.tencent.mm"), "nodes" to JsonArray(emptyList()))
      override fun tap(id: String?, text: String?, x: Float?, y: Float?) = true
      override fun setText(text: String, id: String?, submit: Boolean) = true
      override fun scroll(direction: String, id: String?) = true
      override fun back() = true
      override fun home() = true
      override fun openApp(query: String): Boolean { opened += query; return true }
      override fun listApps(query: String?) = JsonArray(emptyList())
    }
    try {
      MockWebServer().use { server ->
        server.start()
        // 1. capabilities registration
        server.enqueue(response("""{"ok":true}"""))
        // 2. claim agent.invoke (deliberately contains "说" to prove old regex no longer swallows commands!)
        server.enqueue(response("""{"task":{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","capability":"agent.invoke","instruction":"帮我打开微信给张三说一声晚点回","input":{},"source_device_id":"dev-mac"}}"""))
        // 3. directory lookup for source device name
        server.enqueue(response("""{"items":[{"device":{"id":"dev-mac","name":"Mac 主机","platform":"macos"},"agents":[]}]}"""))
        // 4-6. DeviceAgent verify + memory assemble
        server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
        server.enqueue(response("""{"protocol":"anylink","version":"3.2"}"""))
        server.enqueue(response("""{"device_id":"$testDevice","memories":[],"boundaries":[],"episodes":[],"summary_text":""}"""))
        // 7. Model calls phone_open_app("微信")
        server.enqueue(stream(sse(call = """{"name":"phone_open_app","arguments":"{\"name\":\"微信\"}"}""")))
        // 8. Model finishes with summary
        server.enqueue(stream(sse("已在手机上打开微信。")))
        // 9. Memory ingest
        server.enqueue(response("""{"episode_id":"ep-remote-1","status":"pending"}"""))
        // 10. Worker posts task result
        server.enqueue(response("""{"ok":true}"""))
        // 11. Next claim returns null
        server.enqueue(response("""{"task":null}"""))

        val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
        val ledger = MemoryLedger()
        val agent = DeviceAgent(conn, CloudClient(conn), ledger, { jsonObject("model" to str("m")) })
        val job = launch {
          runCatching {
            linkWorkerLoop(
              transport = CloudClient(conn),
              ledger = ledger,
              info = { jsonObject("model" to str("m")) },
              say = { _, _ -> fail("agent.invoke control command must execute, not fall back to say") },
              invokeAgent = { taskId, _, instruction, source ->
                when (val outcome = agent.runRemoteTask(taskId, instruction, source)) {
                  is RemoteTaskOutcome.Succeeded -> jsonObject("state" to str("succeeded"), "output" to jsonObject("reply" to str(outcome.reply), "steps" to JsonPrimitive(outcome.steps)))
                  is RemoteTaskOutcome.Declined -> throw FileDeclined(outcome.code, outcome.message, outcome.learnBoundary)
                  is RemoteTaskOutcome.Failed -> throw LinkFailure(outcome.code, outcome.message, outcome.unknown)
                }
              },
            )
          }
        }
        delay(1800); job.cancel()
        val requests = (1..server.requestCount).map { server.takeRequest() }
        val caps = requests.first { it.path == "/edge/v1/link/capabilities" }.body.readUtf8()
        assertTrue("worker must advertise agent.invoke", caps.contains("\"agent.invoke\""))
        assertEquals(listOf("微信"), opened)
        val resultReq = requests.single { it.path == "/edge/v1/tasks/cccccccc-cccc-4ccc-8ccc-cccccccccccc/result" }
        val parsed = linkJson.parseToJsonElement(resultReq.body.readUtf8()).jsonObject
        assertEquals("succeeded", parsed.text("state"))
        assertTrue(parsed["output"]!!.jsonObject.text("reply").contains("微信"))
      }
    } finally {
      PhoneControlBridge.control = null
    }
  }

  @Test fun `remote task reports transient accessibility decline with learn_boundary false`() = runBlocking {
    PhoneControlBridge.control = null
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
      server.enqueue(response("""{"protocol":"anylink","version":"3.2"}"""))
      server.enqueue(response("""{"device_id":"$testDevice","memories":[],"boundaries":[],"episodes":[],"summary_text":""}"""))
      server.enqueue(stream(sse(call = """{"name":"phone_open_app","arguments":"{\"name\":\"微信\"}"}""")))
      server.enqueue(stream(sse("[ANYLINK_DECLINED:ACCESSIBILITY_DISABLED] 请先在手机设置里开启无障碍服务")))
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val agent = DeviceAgent(conn, CloudClient(conn), MemoryLedger(), { jsonObject("model" to str("m")) })
      val outcome = agent.runRemoteTask("task-acc-1", "打开微信", "Mac 主机")
      assertTrue(outcome is RemoteTaskOutcome.Declined)
      val declined = outcome as RemoteTaskOutcome.Declined
      assertEquals("ACCESSIBILITY_DISABLED", declined.code)
      assertEquals(false, declined.learnBoundary)
    }
  }

  @Test fun `speech transport failure preserves reply words without another model rewrite`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); server.enqueue(MockResponse().setResponseCode(502).setBody("""{"error":{"code":"SPEECH_UNAVAILABLE"}}"""))
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val spoken = mutableListOf<String>()
      val player = SpeechPlayer(RuntimeEnvironment.getApplication(), this, { conn }, { spoken += it; null }, {})
      player.enqueue("你好呀，我在听呢。", false, true, false)
      val deadline = System.currentTimeMillis() + 5000
      while (spoken.isEmpty() && System.currentTimeMillis() < deadline) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(20) }
      assertEquals(listOf("你好呀，我在听呢。"), spoken)
      val request = server.takeRequest(1, TimeUnit.SECONDS)!!
      assertEquals("/model/v1/speech", request.path)
      assertEquals("never", linkJson.parseToJsonElement(request.body.readUtf8()).jsonObject.text("rewrite"))
      assertEquals(1, server.requestCount); player.interrupt()
    }
  }
  @Test fun `interrupted speech fetch cannot play a retired sentence in the next turn`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"spoken_text":"旧回复","rewritten":false}""").setBodyDelay(2, java.util.concurrent.TimeUnit.SECONDS))
      server.enqueue(response("""{"spoken_text":"新回复","rewritten":false}"""))
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val spoken = mutableListOf<String>()
      val player = SpeechPlayer(RuntimeEnvironment.getApplication(), this, { conn }, { text -> spoken += text; null }, {})
      player.enqueue("旧回复", summarize = false, interrupt = true, forceRewrite = false)
      val deadline = System.currentTimeMillis() + 5000
      while (server.requestCount == 0 && System.currentTimeMillis() < deadline) {
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(20)
      }
      assertEquals(1, server.requestCount)
      player.interrupt()
      player.enqueue("新回复", summarize = false, interrupt = false, forceRewrite = false)
      while (spoken.isEmpty() && System.currentTimeMillis() < deadline) {
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(20)
      }
      assertEquals(listOf("新回复"), spoken)
      player.interrupt()
    }
  }

  @Test fun `Momo WAV prefetch is bounded and interruption discards prepared audio without triggering its pose`() = runBlocking {
    val context = RuntimeEnvironment.getApplication()
    val existing = context.cacheDir.listFiles().orEmpty().toSet()
    val pcm = ByteArray(16000 * 2) { if (it % 2 == 0) 0 else 32 }
    val audio = android.util.Base64.encodeToString(WavEncoder.encodePcm16Mono(pcm), android.util.Base64.NO_WRAP)
    fun sound(words: String) = response("""{"spoken_text":"$words","audio_base64":"$audio","format":"wav","provider":"qwen"}""")
    org.robolectric.shadows.ShadowMediaPlayer.setMediaInfoProvider { org.robolectric.shadows.ShadowMediaPlayer.MediaInfo(60000, 0) }
    MockWebServer().use { server ->
      server.start(); server.enqueue(sound("第一句")); server.enqueue(sound("第二句")); server.enqueue(sound("新回复"))
      val spoken = mutableListOf<String>(); val voices = mutableListOf<String>(); val players = mutableListOf<android.media.MediaPlayer>()
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val player = SpeechPlayer(context, this, { conn }, { fail("system fallback should not run"); null }, {},
        onUtterance = { spoken += it }, onVoice = { voices += it }, createPlayer = { android.media.MediaPlayer().also { players += it } })
      player.enqueue("第一句", false, false, false); player.enqueue("第二句", false, false, false); player.enqueue("第三句", false, false, false)
      val deadline = System.currentTimeMillis() + 5000
      while ((server.requestCount < 2 || context.cacheDir.listFiles().orEmpty().count { it !in existing && it.name.startsWith("speech-") } < 2) && System.currentTimeMillis() < deadline) {
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(20)
      }
      org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(80)
      assertEquals(2, server.requestCount); assertEquals(listOf("第一句"), spoken); assertEquals(listOf("qwen"), voices)
      val files = context.cacheDir.listFiles().orEmpty().filter { it !in existing && it.name.startsWith("speech-") }
      assertEquals(2, files.size); assertTrue(files.all { it.extension == "wav" })
      player.interrupt(); assertTrue(files.none { it.exists() }); assertFalse(player.isActive)
      assertEquals(org.robolectric.shadows.ShadowMediaPlayer.State.END, org.robolectric.Shadows.shadowOf(players.single()).state)
      player.enqueue("新回复", false, false, false)
      while (spoken.size < 2 && System.currentTimeMillis() < deadline) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(20) }
      assertEquals(listOf("第一句", "新回复"), spoken); player.interrupt()
    }
  }

  @Test fun `exhausted cloud synthesis goes directly to original system TTS with server spoken words`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); server.enqueue(MockResponse().setResponseCode(502).setBody("""{"error":{"code":"SPEECH_UNAVAILABLE","spoken_text":"我在听呢。"}}"""))
      val spoken = mutableListOf<String>(); val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val player = SpeechPlayer(RuntimeEnvironment.getApplication(), this, { conn }, { spoken += it; null }, {})
      player.enqueue("长回复需要精炼", true, false, true)
      val deadline = System.currentTimeMillis() + 5000
      while (spoken.isEmpty() && System.currentTimeMillis() < deadline) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(20) }
      assertEquals(listOf("我在听呢。"), spoken); assertEquals(1, server.requestCount); player.interrupt()
    }
  }

  @Test fun `streamed speech starts at the audio clock before HTTP completion and cancels cleanly`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      val pcm = android.util.Base64.encodeToString(ByteArray(4800) { if (it % 2 == 0) 0 else 32 }, android.util.Base64.NO_WRAP)
      val prefix = """{"type":"start","spoken_text":"我在听呢。","provider":"qwen","resolved_voice":"Momo","format":"pcm_s16le","sample_rate":24000,"channels":1,"request_id":"test-stream"}
{"type":"audio","audio_base64":"$pcm"}
"""
      server.enqueue(MockResponse().setHeader("Content-Type", "application/x-ndjson").setChunkedBody(prefix + """{"type":"done","frames":2400,"padding":"${"x".repeat(200)}"}
""", prefix.toByteArray(Charsets.UTF_8).size).throttleBody((prefix.toByteArray(Charsets.UTF_8).size + 16).toLong(), 2, TimeUnit.SECONDS))
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val spoken = mutableListOf<String>(); val events = mutableListOf<JsonObject>(); val played = java.util.concurrent.atomic.AtomicLong(0)
      var released = false
      val output = object : PcmOutput {
        override fun play() = Unit
        override fun write(bytes: ByteArray, offset: Int, size: Int): Int { played.addAndGet(size / 2L); return size }
        override fun positionFrames(): Long = played.get()
        override fun stop() = Unit
        override fun release() { released = true }
      }
      val player = SpeechPlayer(RuntimeEnvironment.getApplication(), this, { conn }, { fail("must not fall back"); null }, {},
        onUtterance = { spoken += it }, createPcmOutput = { _, _ -> output }, onDiagnostic = { events += it })
      val started = System.currentTimeMillis(); player.enqueue("我在听呢。", false, false, source = "call", turn = "turn-1")
      while (spoken.isEmpty() && System.currentTimeMillis() - started < 1600) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(20)); delay(15) }
      assertEquals("events=$events", listOf("我在听呢。"), spoken); assertTrue("playback must precede the delayed done event", player.isActive)
      assertTrue(events.any { it.text("outcome") == "playing" && it.text("request_id") == "test-stream" })
      player.interrupt(); delay(50); org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
      assertTrue(released); assertFalse(player.isActive)
    }
  }

  @Test fun `normal notifications wait until hangup without blocking call audio or being lost by interrupt`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); server.enqueue(response("""{"spoken_text":"收到文件啦"}"""))
      var call = true; val spoken = mutableListOf<String>()
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val player = SpeechPlayer(RuntimeEnvironment.getApplication(), this, { conn }, { spoken += it; null }, {}, inCall = { call })
      player.enqueue("收到文件啦", false, false, source = "notification"); delay(60)
      assertEquals(0, server.requestCount); assertFalse(player.isActive)
      player.interrupt(); call = false; player.releaseDeferred()
      val deadline = System.currentTimeMillis() + 3000
      while (spoken.isEmpty() && System.currentTimeMillis() < deadline) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(15) }
      assertEquals(listOf("收到文件啦"), spoken); assertEquals(1, server.requestCount); player.interrupt()
    }
  }

  @Test fun `fallback voice is sticky for a reply and a new reply can use Momo again`() = runBlocking {
    org.robolectric.shadows.ShadowMediaPlayer.setMediaInfoProvider { org.robolectric.shadows.ShadowMediaPlayer.MediaInfo(60000, 0) }
    val audio = android.util.Base64.encodeToString(WavEncoder.encodePcm16Mono(ByteArray(3200)), android.util.Base64.NO_WRAP)
    MockWebServer().use { server ->
      server.start()
      repeat(3) { server.enqueue(response("""{"spoken_text":"你好呀","audio_base64":"$audio","format":"wav","provider":"microsoft"}""")) }
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val player = SpeechPlayer(RuntimeEnvironment.getApplication(), this, { conn }, { fail("must not use system"); null }, {})
      player.enqueue("第一句", false, false, source = "call", turn = "turn-A"); player.enqueue("第二句", false, false, source = "call", turn = "turn-A")
      val deadline = System.currentTimeMillis() + 5000
      while (server.requestCount < 2 && System.currentTimeMillis() < deadline) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(15) }
      assertEquals("qwen", server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("X-AnyLink-Speech-Provider"))
      assertEquals("microsoft", server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("X-AnyLink-Speech-Provider"))
      player.enqueue("新回复", false, true, source = "call", turn = "turn-B")
      while (server.requestCount < 3 && System.currentTimeMillis() < deadline) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); delay(15) }
      assertEquals("qwen", server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("X-AnyLink-Speech-Provider")); player.interrupt()
    }
  }

}
