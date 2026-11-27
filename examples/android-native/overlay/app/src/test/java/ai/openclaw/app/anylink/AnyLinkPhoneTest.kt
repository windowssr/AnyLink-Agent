package ai.openclaw.app.anylink

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private fun sn(
  id: String, text: String = "", desc: String = "", cls: String = "View",
  pkg: String = "com.example.app", own: Boolean = false, visible: Boolean = true,
  focused: Boolean = false, clickable: Boolean = false, editable: Boolean = false,
  scrollable: Boolean = false, checkable: Boolean = false, checked: Boolean = false,
  bounds: IntArray = intArrayOf(0, 0, 100, 50), depth: Int = 0,
  clickId: String? = null, scrollId: String? = null,
) = ScreenNode(id, text, desc, cls, pkg, own, visible, focused, clickable, editable, scrollable, checkable, checked, bounds, depth, clickId, scrollId)

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AnyLinkPhoneTest {

  @Test fun `screen serializer keeps only visible foreign nodes within caps`() {
    val nodes = listOf(
      sn("n1", text = "设置", clickable = true, clickId = "n1"),
      sn("n2", text = "隐藏", visible = false),
      sn("n3", text = "自己", own = true),
      sn("n4", text = "其他包", pkg = "com.other"),
    )
    val out = PhoneScreenSerializer.serialize(nodes, "com.anylink.agent.debug", "com.example.app")
    val items = out["nodes"]!!.let { it as JsonArray }
    assertEquals(listOf("n1", "n4"), items.map { (it as JsonObject).text("id") })
    assertEquals("com.example.app", out.text("package"))
    assertEquals("false", out["truncated"].toString())

    val many = (1..PhoneScreenSerializer.MAX_NODES + 20).map { sn("m$it", text = "项$it") }
    val capped = PhoneScreenSerializer.serialize(many, "own", "pkg", maxBytes = 1024 * 1024)
    assertEquals(PhoneScreenSerializer.MAX_NODES, (capped["nodes"] as JsonArray).size)
    assertEquals("true", capped["truncated"].toString())
    val byteCapped = PhoneScreenSerializer.serialize(many, "own", "pkg", maxBytes = 4096)
    assertTrue((byteCapped["nodes"] as JsonArray).size < PhoneScreenSerializer.MAX_NODES)
    assertEquals("true", byteCapped["truncated"].toString())

    val fat = (1..40).map { sn("f$it", text = "长".repeat(200), desc = "述".repeat(200)) }
    val small = PhoneScreenSerializer.serialize(fat, "own", "pkg", maxBytes = 4096)
    assertTrue((small["nodes"] as JsonArray).size < fat.size)
    assertEquals("true", small["truncated"].toString())
    assertTrue(small.toString().toByteArray(Charsets.UTF_8).size <= 4096 + 64)
  }

  @Test fun `tap resolves id text clickable ancestor and coordinates`() {
    val parent = sn("p", clickable = true, clickId = "p", bounds = intArrayOf(0, 0, 200, 100))
    val label = sn("l", text = "确认删除", depth = 1, clickId = "p", bounds = intArrayOf(10, 10, 90, 40))
    val other = sn("o", text = "取消", clickable = true, clickId = "o")
    val nodes = listOf(parent, label, other)

    assertEquals(TapResolution.Node("p"), PhoneNodeResolver.resolveTap(nodes, "l", null, null, null))
    assertEquals(TapResolution.Node("o"), PhoneNodeResolver.resolveTap(nodes, null, "取消", null, null))
    assertEquals(TapResolution.Node("p"), PhoneNodeResolver.resolveTap(nodes, null, "确认", null, null))
    assertEquals(TapResolution.Point(50f, 60f), PhoneNodeResolver.resolveTap(nodes, null, null, 50f, 60f))
    assertEquals(TapResolution.NotFound, PhoneNodeResolver.resolveTap(nodes, "missing", null, null, null))
    assertEquals(TapResolution.NotFound, PhoneNodeResolver.resolveTap(nodes, null, "不存在", null, null))
    assertEquals(TapResolution.NotFound, PhoneNodeResolver.resolveTap(nodes, null, null, null, null))
  }

  @Test fun `editable and scrollable resolution prefer given focused then first`() {
    val field = sn("e1", editable = true, focused = true, bounds = intArrayOf(0, 0, 10, 10))
    val other = sn("e2", editable = true)
    val list = sn("s1", scrollable = true, scrollId = "s1")
    val nodes = listOf(field, other, list)
    assertEquals("e1", PhoneNodeResolver.resolveEditable(nodes, null)?.id)
    assertEquals("e2", PhoneNodeResolver.resolveEditable(nodes, "e2")?.id)
    assertEquals("s1", PhoneNodeResolver.resolveScrollable(nodes, null)?.id)
    assertNull(PhoneNodeResolver.resolveEditable(nodes, "s1"))
  }

  @Test fun `app matching prefers exact then contains`() {
    val apps = listOf(LaunchApp("设置", "com.android.settings"), LaunchApp("信息", "com.android.mms"), LaunchApp("微信", "com.tencent.mm"))
    assertEquals("com.android.settings", PhoneApps.match("设置", apps)?.pkg)
    assertEquals("com.tencent.mm", PhoneApps.match("com.tencent.mm", apps)?.pkg)
    assertEquals("com.android.mms", PhoneApps.match("信", apps)?.pkg)
    assertNull(PhoneApps.match("不存在", apps))
    // 微信, 信息 and 短信 labels all contain 信.
    assertEquals(3, PhoneApps.filter("信", apps + LaunchApp("短信", "com.android.messaging")).size)
  }

  @Test fun `history pruning keeps only the latest screen payload`() {
    fun call(id: String, name: String) = buildJsonObject {
      put("id", id); putJsonObject("function") { put("name", name); put("arguments", "{}") }
    }
    fun screenTool(id: String, content: String) = buildJsonObject {
      put("role", "tool"); put("tool_call_id", id); put("content", content)
    }
    fun assistant(vararg calls: JsonObject) = buildJsonObject {
      put("role", "assistant")
      putJsonArray("tool_calls") { calls.forEach { add(it) } }
    }
    val messages = JsonArray(listOf(
      buildJsonObject { put("role", "user"); put("content", "帮我操作") },
      assistant(call("c1", "phone_screen")), screenTool("c1", """{"nodes":[…旧屏幕…]}"""),
      assistant(call("c2", "phone_tap")), screenTool("c2", """{"ok":true,"screen":{"nodes":[…中间屏幕…]}}"""),
      assistant(call("c3", "phone_scroll")), screenTool("c3", """{"ok":true,"screen":{"nodes":[…最新屏幕…]}}"""),
      buildJsonObject { put("role", "assistant"); put("content", "完成了") },
      buildJsonObject { put("role", "user"); put("content", "下一句") },
      assistant(call("c4", "note_save")), screenTool("c4", """{"saved":true}"""),
    ))
    val pruned = pruneScreenPayloads(messages)
    assertEquals("[旧屏幕已省略]", (pruned[2] as JsonObject).text("content"))
    assertEquals("[旧屏幕已省略]", (pruned[4] as JsonObject).text("content"))
    assertTrue((pruned[6] as JsonObject).text("content").contains("最新屏幕"))
    assertTrue((pruned[10] as JsonObject).text("content").contains("saved"))
  }

  /** SSE tool-call response with a unique call id (the idempotency journal rejects repeats). */
  private fun sseCall(id: String, name: String, args: String = "{}"): String =
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"$id\",\"function\":{\"name\":\"$name\",\"arguments\":\"$args\"}}]},\"finish_reason\":null}]}\n\n" +
      "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n" +
      "data: [DONE]\n\n"

  @Test fun `turn budget defaults to 100, honors configured cap, prunes screens in-loop, and detects stalls`() = runBlocking {
    assertEquals(100, DEFAULT_AGENT_MAX_STEPS)
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
      server.enqueue(response("""{"protocol":"anylink","version":"3.0"}"""))
      server.enqueue(response("""{"device_id":"$testDevice","memories":[],"boundaries":[],"episodes":[],"summary_text":""}"""))
      // Run 25 steps (> legacy 20 limit) with a custom configured cap of 25, verifying loop hint and canContinue.
      repeat(26) { server.enqueue(stream(sseCall("call_${it + 1}", "companion_expression", "{\\\"emotion\\\":\\\"happy\\\"}"))) }
      val ledger = MemoryLedger()
      val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val agent = DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }, maxStepsProvider = { 25 })
      agent.send("动一动")
      val run = ledger.runs().first()
      assertEquals("failed", run.text("state"))
      assertTrue(run.text("notice").contains("25 步工具步骤上限"))
      assertTrue(agent.state.value.canContinue)
      // 3 setup (identity + protocol + memory/assemble) + 25 tool turns = 28 requests; the 26th completion never happens.
      assertEquals(28, server.requestCount)
      // On the 3rd consecutive identical call, _loop_hint is attached to nudge the model out of ruts.
      val thirdOp = ledger.operations.values.elementAt(2)
      assertTrue(thirdOp.toString().contains("_loop_hint"))
    }
  }

  @Test fun `trimHistoryForBudget compacts oldest complete user turns without breaking tool pairs`() {
    fun call(id: String, name: String) = buildJsonObject {
      put("id", id); putJsonObject("function") { put("name", name); put("arguments", "{}") }
    }
    val history = JsonArray(listOf(
      buildJsonObject { put("role", "user"); put("content", "第一轮：" + "甲".repeat(300)) },
      buildJsonObject { put("role", "assistant"); putJsonArray("tool_calls") { add(call("c1", "phone_screen")) } },
      buildJsonObject { put("role", "tool"); put("tool_call_id", "c1"); put("content", """{"nodes":["旧"]}""") },
      buildJsonObject { put("role", "assistant"); put("content", "第一轮完成") },
      buildJsonObject { put("role", "user"); put("content", "第二轮：" + "乙".repeat(100)) },
      buildJsonObject { put("role", "assistant"); put("content", "第二轮完成") },
    ))
    val trimmed = trimHistoryForBudget(history, maxChars = 400, maxMessages = 10)
    assertEquals("user", (trimmed.first() as JsonObject).text("role"))
    assertTrue((trimmed.first() as JsonObject).text("content").startsWith("第二轮"))
    assertEquals(2, trimmed.size)
  }

  @Test fun `in-loop screen pruning strips stale screen dumps before every model call`() = runBlocking {
    var reads = 0
    PhoneControlBridge.control = object : PhoneControl {
      override fun screen() = buildJsonObject { put("package", "com.demo"); put("marker", "SCREEN_${++reads}") }
      override fun tap(id: String?, text: String?, x: Float?, y: Float?) = true
      override fun setText(text: String, id: String?, submit: Boolean) = true
      override fun scroll(direction: String, id: String?) = true
      override fun back() = true
      override fun home() = true
      override fun openApp(query: String) = true
      override fun listApps(query: String?) = JsonArray(emptyList())
    }
    try {
      MockWebServer().use { server ->
        server.start()
        server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
        server.enqueue(response("""{"protocol":"anylink","version":"3.0"}"""))
        server.enqueue(response("""{"device_id":"$testDevice","memories":[],"boundaries":[],"episodes":[],"summary_text":""}"""))
        server.enqueue(stream(sseCall("c_s1", "phone_screen", "{}")))
        server.enqueue(stream(sseCall("c_s2", "phone_screen", "{}")))
        server.enqueue(stream(sse("看完了")))
        server.enqueue(response("""{"episode_id":"ep-prune","status":"pending"}"""))
        val ledger = MemoryLedger()
        val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
        DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) }).send("连看两屏")
        val requests = (1..server.requestCount).map { server.takeRequest() }
        val completions = requests.filter { it.path == "/model/v1/chat/completions" }
        assertEquals(3, completions.size)
        val thirdBody = completions[2].body.readUtf8()
        assertFalse("stale SCREEN_1 must be pruned before step 3", thirdBody.contains("SCREEN_1"))
        assertTrue("latest SCREEN_2 must be preserved for step 3", thirdBody.contains("SCREEN_2"))
        assertTrue(thirdBody.contains("[旧屏幕已省略]"))
      }
    } finally {
      PhoneControlBridge.control = null
    }
  }

  @Test fun `accessibility disabled surfaces as tool error not crash`() = runBlocking {
    PhoneControlBridge.control = null
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
      server.enqueue(response("""{"protocol":"anylink","version":"3.0"}"""))
      server.enqueue(response("""{"device_id":"$testDevice","memories":[],"boundaries":[],"episodes":[],"summary_text":""}"""))
      server.enqueue(stream(sse(call = """{"name":"phone_screen","arguments":"{}"}""")))
      server.enqueue(stream(sse("需要先开启无障碍服务")))
      server.enqueue(response("""{"episode_id":"ep-acc","status":"pending"}"""))
      val ledger = MemoryLedger()
      val connection = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val agent = DeviceAgent(connection, CloudClient(connection), ledger, { JsonObject(emptyMap()) })
      agent.send("看看屏幕")
      val run = ledger.runs().first()
      assertEquals("completed", run.text("state"))
      val failed = ledger.operations.values.map { it["result"] as? JsonObject }.firstOrNull { it?.get("error") != null }
      assertEquals("ACCESSIBILITY_DISABLED", (failed?.get("error") as? JsonObject)?.text("code"))
    }
  }
}
