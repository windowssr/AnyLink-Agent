package ai.openclaw.app.anylink

import android.content.Context
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
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
  override fun saveNote(name: String, content: String) { notes[name] = content }
  override fun readNote(name: String) = notes[name]
}
private val testDevice = "11111111-1111-4111-8111-111111111111"
private val testToken = "ak_" + "x".repeat(32)
private fun response(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
private fun sse(content: String = "", call: String? = null, terminal: Boolean = true): String {
  val delta = if (call != null) """{"tool_calls":[{"index":0,"id":"call_1","function":$call}]}""" else """{"content":${str(content)}}"""
  return "data: {\"choices\":[{\"delta\":$delta,\"finish_reason\":null}]}\n\n" + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"${if (call != null) "tool_calls" else "stop"}\"}]}\n\n" + if (terminal) "data: [DONE]\n\n" else ""
}
private fun stream(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)
private fun prepare(server: MockWebServer) {
  server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
  server.enqueue(response("""{"protocol":"anylink","version":"1.0"}"""))
  server.enqueue(response("""{"device_id":"$testDevice","global":[{"content":"全局事实"}],"device":[{"content":"手机事实"}]}"""))
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AnyLinkAgentTest {
  @Test fun `phone owns HTTP model tool loop with no Mac or Gateway connection`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"device_info","arguments":"{}"}""")))
      server.enqueue(stream(sse("我是手机上的大肥鱼")))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val agent = DeviceAgent(connection, CloudClient(connection), ledger) { jsonObject("runtime" to str("android-local"), "mac_required" to JsonPrimitive(false)) }
      agent.send("这台设备是什么？")
      assertEquals("completed", ledger.runs().first().text("state")); assertFalse(agent.state.value.busy)
      assertEquals(5, server.requestCount)
      val requests = (1..5).map { server.takeRequest() }
      assertTrue(requests.all { it.path!!.startsWith("/edge/") || it.path!!.startsWith("/model/") })
      assertTrue(requests.all { it.getHeader("Authorization") == "Bearer $testToken" })
      val continuation = linkJson.parseToJsonElement(requests.last().body.readUtf8()).jsonObject["messages"]!!.jsonArray
      assertTrue(continuation.any { it.jsonObject.text("role") == "tool" && it.jsonObject.text("content").contains("android-local") })
      assertTrue(continuation.first().jsonObject.text("content").contains("手机事实"))
    }
  }
  @Test fun `interrupted stream never executes a partial tool or repeats the model`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"note_save","arguments":"{\"name\":\"draft\",\"content\":\"must not save\"}"}""", terminal = false)))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger) { JsonObject(emptyMap()) }.send("保存一条便笺")
      assertEquals("unknown", ledger.runs().first().text("state")); assertNull(ledger.readNote("draft")); assertEquals(4, server.requestCount); assertTrue(ledger.operations.isEmpty())
    }
  }
  @Test fun `malformed accepted SSE stays unknown without executing tools or retrying`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server); server.enqueue(stream("data: {broken\n\n"))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger) { JsonObject(emptyMap()) }.send("你好")
      assertEquals("unknown", ledger.runs().first().text("state")); assertEquals(4, server.requestCount); assertTrue(ledger.operations.isEmpty())
    }
  }
  @Test fun `device identity mismatch stops before reading memory or submitting a model`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); server.enqueue(response("""{"device":{"id":"different-device"}}"""))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger) { JsonObject(emptyMap()) }.send("你好")
      assertEquals("failed", ledger.runs().first().text("state")); assertEquals(1, server.requestCount)
    }
  }
  @Test fun `ordinary chat cannot be turned into a memory write by the model`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      server.enqueue(stream(sse(call = """{"name":"memory_save","arguments":"{\"title\":\"injected\",\"content\":\"no\",\"scope\":\"global\"}"}""")))
      server.enqueue(stream(sse("没有保存")))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger) { JsonObject(emptyMap()) }.send("你好")
      assertEquals(5, server.requestCount)
      assertTrue(ledger.operations.values.first().toString().contains("EXPLICIT_MEMORY_INTENT_REQUIRED"))
    }
  }
  @Test fun `cloud cross device tasks are queued without a direct Mac address`() = runBlocking {
    MockWebServer().use { server ->
      server.start(); prepare(server)
      val target = "22222222-2222-4222-8222-222222222222"
      val args = """{"target_device_id":"$target","capability":"files.search","input":{"query":"report"}}"""
      server.enqueue(stream(sse(call = jsonObject("name" to str("task_create"), "arguments" to str(args)).toString())))
      server.enqueue(response("""{"items":[{"id":"$target","capabilities":[{"name":"files.search"}]}]}"""))
      server.enqueue(response("""{"id":"33333333-3333-4333-8333-333333333333","state":"queued","capability":"files.search"}"""))
      server.enqueue(stream(sse("任务已排队，Mac离线不会影响我们聊天")))
      val ledger = MemoryLedger(); val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      DeviceAgent(connection, CloudClient(connection), ledger) { JsonObject(emptyMap()) }.send("帮我找电脑上的report文件")
      assertEquals("completed", ledger.runs().first().text("state")); assertEquals("queued", ledger.runs().first()["last_result"]!!.jsonObject.text("state"))
      val requests = (1..server.requestCount).map { server.takeRequest() }
      val create = requests.single { it.path == "/edge/v1/link/tasks" }
      assertNotNull(create.getHeader("Idempotency-Key")); assertFalse(create.body.readUtf8().contains("source_device_id"))
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
}
