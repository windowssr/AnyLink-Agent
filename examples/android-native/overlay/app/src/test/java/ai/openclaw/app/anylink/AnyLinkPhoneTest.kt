package ai.openclaw.app.anylink

import ai.openclaw.app.ui.AvatarLoadMonitor
import ai.openclaw.app.ui.parseAvatarSignal
import ai.openclaw.app.ui.avatarResourceResponse
import ai.openclaw.app.ui.isRequiredAvatarResource
import android.content.ComponentName
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.ResolveInfo
import android.content.pm.ServiceInfo
import android.net.Uri
import android.provider.Settings
import android.os.Bundle
import android.os.Looper
import android.speech.SpeechRecognizer
import android.speech.RecognitionService
import android.media.AudioAttributes
import android.media.MediaPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.mockwebserver.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowSpeechRecognizer
import org.robolectric.shadows.ShadowMediaPlayer
import java.time.Duration

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

  @Test fun `automatic favicon requests get an empty response and cannot fail the avatar`() {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    for (path in listOf("/favicon.ico", "/assets/anylink/favicon.ico?version=1")) {
      val uri = Uri.parse("https://appassets.androidplatform.net$path")
      val response = avatarResourceResponse(app, uri)
      assertEquals(204, response?.statusCode)
      assertEquals(-1, response?.data?.read())
      assertFalse(isRequiredAvatarResource(uri, false))
    }
    val icon = avatarResourceResponse(app, Uri.parse("https://appassets.androidplatform.net/assets/anylink/favicon.svg"))
    assertEquals(200, icon?.statusCode); assertEquals("image/svg+xml", icon?.mimeType)
  }

  @Test fun `only page engine and required model errors are fatal to the avatar`() {
    val root = "https://appassets.androidplatform.net/assets/anylink/"
    for (path in listOf("portrait.html", "avatar-loader.js", "avatar.js", "live2dcubismcore.min.js", "pixi.min.js", "cubism4-colors.min.js", "model/entry.model3.json", "model/dafeiyu.moc3", "model/textures/texture_00.png")) {
      assertTrue(path, isRequiredAvatarResource(Uri.parse(root + path), false))
    }
    for (path in listOf("favicon.svg", "favicon.ico", "model/Animation/wave.motion3.json", "model/Exp3/smile.exp3.json")) {
      assertFalse(path, isRequiredAvatarResource(Uri.parse(root + path), false))
    }
    assertTrue(isRequiredAvatarResource(Uri.parse(root + "portrait.html"), true))
  }

  @Test fun `ignoring optional avatar errors never opens external network or unsafe asset paths`() {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    for (url in listOf("https://example.invalid/favicon.ico", "https://example.invalid/assets/anylink/avatar.js", "https://appassets.androidplatform.net:8443/favicon.ico", "https://appassets.androidplatform.net/assets/anylink/%2e%2e/private.txt")) {
      assertEquals(url, 403, avatarResourceResponse(app, Uri.parse(url))?.statusCode)
    }
    assertNull(avatarResourceResponse(app, Uri.parse("blob:https://appassets.androidplatform.net/test")))
  }

  @Test fun `registered non-exported recognition services remain discoverable through the system proxy`() {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    val component = ComponentName("com.hihonor.magicvoice", "com.hihonor.magicvoice.voiceui.service.MagicVoiceRecognitionService")
    val result = ResolveInfo().apply {
      nonLocalizedLabel = "YOYO"
      serviceInfo = ServiceInfo().apply {
        packageName = component.packageName; name = component.className; enabled = true; exported = false
        applicationInfo = ApplicationInfo().apply { packageName = component.packageName; enabled = true }
      }
    }
    shadowOf(app.packageManager).addOrUpdateService(result.serviceInfo)
    shadowOf(app.packageManager).addIntentFilterForService(component, IntentFilter(RecognitionService.SERVICE_INTERFACE))
    Settings.Secure.putString(app.contentResolver, "voice_recognition_service", component.flattenToShortString())
    ShadowSpeechRecognizer.setIsOnDeviceRecognitionAvailable(false)
    val catalog = AndroidSystemSpeechPlatform(app).catalog()
    assertTrue(catalog.services.any { it.id == component.flattenToString() })
    assertTrue(catalog.discoveryDetails.any { it.contains("exported=false") })
    assertEquals(listOf("default", component.flattenToString()), catalog.attempts("auto").map { it.id })
  }

  @Test fun `stopping the keepalive service preserves foreground voice input but clears background capture`() {
    val runtime = AnyLinkRuntime.get(org.robolectric.RuntimeEnvironment.getApplication())
    runtime.onActivityStarted(); runtime.listening.value = true
    runtime.onServiceStopped()
    assertTrue(runtime.listening.value)
    runtime.onActivityStopped(); runtime.onServiceStopped()
    assertFalse(runtime.listening.value)
  }

  @Test fun `call entry cue finishes before capture continues and uses the communication route`() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val players = mutableListOf<MediaPlayer>()
    ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(300, 0) }
    val cues = CallSoundPlayer(org.robolectric.RuntimeEnvironment.getApplication()) { MediaPlayer().also { players += it } }
    var captureStarted = false
    try {
      scope.launch { cues.play(CallCue.Start); captureStarted = true }
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
      assertFalse(captureStarted)
      val player = shadowOf(players.single())
      assertEquals(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING, player.audioAttributes.usage)
      assertEquals(AudioAttributes.CONTENT_TYPE_SONIFICATION, player.audioAttributes.contentType)
      assertEquals(0.55f, player.leftVolume)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250))
      assertTrue(captureStarted); assertEquals(ShadowMediaPlayer.State.END, player.state)
    } finally { cues.stop(); scope.cancel() }
  }

  @Test fun `cancelled cue and late completion cannot release a newer hangup cue`() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val players = mutableListOf<MediaPlayer>()
    ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(300, 0) }
    val cues = CallSoundPlayer(org.robolectric.RuntimeEnvironment.getApplication()) { MediaPlayer().also { players += it } }
    var finished = false
    try {
      val connecting = scope.launch { cues.play(CallCue.Start) }
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1))
      val old = shadowOf(players.single()); val lateCompletion = old.onCompletionListener
      connecting.cancel()
      scope.launch { cues.play(CallCue.End); finished = true }
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1))
      lateCompletion.onCompletion(players.first())
      assertEquals(ShadowMediaPlayer.State.END, old.state)
      assertEquals(ShadowMediaPlayer.State.STARTED, shadowOf(players.last()).state)
      assertFalse(finished)
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(350)); assertTrue(finished)
    } finally { cues.stop(); scope.cancel() }
  }

  @Test fun `stalled or failed cue releases resources and cannot block the call indefinitely`() {
    for (error in listOf(false, true)) {
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
      val players = mutableListOf<MediaPlayer>()
      ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(300, if (error) 0 else 5000) }
      val cues = CallSoundPlayer(org.robolectric.RuntimeEnvironment.getApplication()) { MediaPlayer().also { players += it } }
      var result: Boolean? = null
      try {
        scope.launch { result = cues.play(CallCue.Start) }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1))
        if (error) shadowOf(players.single()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, 0)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1300))
        assertEquals(false, result)
        assertEquals(ShadowMediaPlayer.State.END, shadowOf(players.single()).state)
      } finally { cues.stop(); scope.cancel() }
    }
  }

  private class SpeechFixture(onDevice: Boolean = false, default: Boolean = true, val preferred: String = "auto",
    defaultService: String = "test/Recognizer", services: List<SystemSpeechTarget> = listOf(SystemSpeechTarget("test.voice/Other", "其他已安装服务")),
  ) : AutoCloseable {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    val created = mutableListOf<Pair<SystemSpeechTarget, SpeechRecognizer>>()
    val states = mutableListOf<String>()
    val statuses = mutableListOf<String>()
    val partials = mutableListOf<String>()
    val finals = mutableListOf<String>()
    val errors = mutableListOf<Pair<String, String>>()
    val activity = mutableListOf<Boolean>()
    val platform = object : SystemSpeechPlatform {
      override fun catalog() = SystemSpeechCatalog(default, onDevice, defaultService, services)
      override fun create(target: SystemSpeechTarget) = SpeechRecognizer.createSpeechRecognizer(app,
        ComponentName("test.voice", target.id.replace('-', '_'))).also { created += target to it }
    }
    val controller = VoiceRecognizerController(app, scope, { null }, { false }, platform, { preferred }, { statuses += it }, { activity += it })
    fun start() = controller.start(VoiceRecognizerController.MODE_SYSTEM, onState = { states += it }, onLevel = {},
      onPartial = { partials += it }, onFinal = { finals += it }, onError = { code, message -> errors += code to message })
    fun pump(ms: Long = 0) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms)) }
    fun recognizer(index: Int = created.lastIndex): ShadowSpeechRecognizer = shadowOf(created[index].second)
    fun result(text: String) = Bundle().apply { putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf(text)) }
    override fun close() { controller.cancel(); scope.cancel(); pump() }
  }

  @Test fun `cancel updates diagnostics and activity instead of leaving a stale starting message`() {
    SpeechFixture().use { f ->
      f.start(); f.pump(); assertTrue(f.activity.last())
      f.controller.cancel("后台保活服务停止，识别已取消"); f.pump(30_000)
      assertFalse(f.activity.last()); assertFalse(f.controller.isActive)
      assertEquals("后台保活服务停止，识别已取消", f.statuses.last())
      assertTrue(f.errors.isEmpty())
    }
  }

  @Test fun `a stalled default service can retry its registered explicit component`() {
    val component = ComponentName("com.hihonor.magicvoice", "com.hihonor.magicvoice.voiceui.service.MagicVoiceRecognitionService")
    SpeechFixture(defaultService = component.flattenToShortString(), services = listOf(SystemSpeechTarget(component.flattenToString(), "YOYO"))).use { f ->
      f.start(); f.pump(12_350)
      assertEquals(listOf("default", component.flattenToString()), f.created.map { it.first.id })
      f.recognizer().triggerOnResults(f.result("新的组件路径")); f.pump()
      assertEquals(listOf("新的组件路径"), f.finals); assertFalse(f.activity.last())
    }
  }

  @Test fun `partial results without ready callback do not trigger a false startup timeout`() {
    SpeechFixture().use { f ->
      f.start(); f.pump()
      f.recognizer().triggerOnPartialResults(f.result("你好")); f.pump()
      f.pump(13_000)
      assertTrue(f.states.contains("listening")); assertTrue(f.errors.isEmpty()); assertEquals(1, f.created.size)
      f.recognizer().triggerOnResults(f.result("你好大肥鱼")); f.pump()
      assertEquals(listOf("你好大肥鱼"), f.finals)
      assertFalse(f.statuses.any { it.contains("你好") })
    }
  }

  @Test fun `RMS callbacks without ready callback establish an active system capture`() {
    SpeechFixture().use { f ->
      f.start(); f.pump(); f.recognizer().triggerOnRmsChanged(2f); f.pump(13_000)
      assertTrue(f.states.contains("listening")); assertTrue(f.errors.isEmpty()); assertEquals(1, f.created.size)
    }
  }

  @Test fun `startup timeout rebuilds once and rejects callbacks from the retired recognizer`() {
    SpeechFixture().use { f ->
      f.start(); f.pump(); val old = f.recognizer()
      f.pump(12_350)
      assertEquals(2, f.created.size); assertTrue(old.isDestroyed); assertTrue(f.errors.isEmpty())
      old.triggerOnReadyForSpeech(Bundle()); old.triggerOnPartialResults(f.result("旧请求")); old.triggerOnResults(f.result("不能发送")); f.pump()
      assertTrue(f.partials.all { it.isEmpty() }); assertTrue(f.finals.isEmpty())
      f.recognizer().triggerOnReadyForSpeech(Bundle()); f.recognizer().triggerOnResults(f.result("新请求")); f.pump()
      assertEquals(listOf("新请求"), f.finals)
    }
  }

  @Test fun `on-device only phones pass preflight and unsupported Chinese falls back to default when available`() {
    SpeechFixture(onDevice = true, default = false).use { f ->
      assertTrue(f.controller.available(VoiceRecognizerController.MODE_SYSTEM))
      f.start(); f.pump(); assertEquals("on-device", f.created.single().first.id)
    }
    SpeechFixture(onDevice = true).use { f ->
      f.start(); f.pump(); assertEquals("on-device", f.created.single().first.id)
      f.recognizer().triggerOnError(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED); f.pump(350)
      assertEquals(listOf("on-device", "default"), f.created.map { it.first.id })
      f.recognizer().triggerOnResults(f.result("普通话识别正常")); f.pump()
      assertEquals(listOf("普通话识别正常"), f.finals); assertTrue(f.errors.isEmpty())
    }
  }

  @Test fun `missing microphone permission is terminal and cannot start another service`() {
    SpeechFixture(onDevice = true).use { f ->
      f.start(); f.pump(); f.recognizer().triggerOnError(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS); f.pump(20_000)
      assertEquals(1, f.created.size); assertEquals("MIC_PERMISSION", f.errors.single().first); assertFalse(f.controller.isActive)
    }
  }

  @Test fun `a new service attempt cannot submit a previous attempt's partial text`() {
    SpeechFixture(onDevice = true).use { f ->
      f.start(); f.pump(); f.recognizer().triggerOnPartialResults(f.result("未完成的旧识别")); f.pump()
      f.recognizer().triggerOnError(SpeechRecognizer.ERROR_NETWORK); f.pump(350)
      assertEquals("", f.partials.last())
      f.recognizer().triggerOnError(SpeechRecognizer.ERROR_NO_MATCH); f.pump()
      assertTrue(f.finals.isEmpty()); assertEquals("NO_SPEECH", f.errors.single().first)
      assertFalse(f.activity.last()); assertTrue(f.statuses.last().contains("NO_SPEECH"))
    }
  }

  @Test fun `unresponsive services have bounded retries and cancel prevents a pending restart`() {
    SpeechFixture().use { f ->
      f.start(); f.pump(25_000)
      assertEquals(2, f.created.size); assertEquals("ASR_START_TIMEOUT", f.errors.single().first); assertFalse(f.controller.isActive)
    }
    SpeechFixture().use { f ->
      f.start(); f.pump(12_000); f.controller.cancel(); f.pump(20_000)
      assertEquals(1, f.created.size); assertTrue(f.errors.isEmpty()); assertFalse(f.controller.isActive)
    }
  }

  @Test fun `finish before a posted startup cannot open the microphone afterwards`() {
    SpeechFixture().use { f ->
      f.start(); f.controller.finishNow(); f.pump(30_000)
      assertTrue(f.created.isEmpty()); assertEquals("NO_SPEECH", f.errors.single().first); assertFalse(f.controller.isActive)
    }
  }

  @Test fun `automatic selection never silently chooses an unrelated installed speech service`() {
    val catalog = SystemSpeechCatalog(false, false, "", listOf(SystemSpeechTarget("other/Recognizer", "输入法语音服务")))
    assertTrue(catalog.candidates("auto").isEmpty())
    assertTrue(catalog.candidates("removed/Recognizer").isEmpty())
    assertEquals("other/Recognizer", catalog.candidates("other/Recognizer").single().id)
    assertEquals("ASR_LANGUAGE_UNAVAILABLE", systemSpeechError(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE).first)
    assertEquals("ASR_SYSTEM_NETWORK", systemSpeechError(SpeechRecognizer.ERROR_NETWORK).first)
  }

  @Test fun `avatar readiness accepts WebView JSON snapshots without console callbacks`() {
    val signal = parseAvatarSignal(JsonPrimitive("""{"state":"ready","message":"Live2D 已就绪"}""").toString())
    assertEquals("ready", signal?.state)
    assertEquals("Live2D 已就绪", signal?.message)
    for (invalid in listOf(null, "null", "undefined", "\"null\"", "{}", JsonPrimitive("""{"state":"unknown"}""").toString())) assertNull(parseAvatarSignal(invalid))
    val failed = parseAvatarSignal(JsonPrimitive("""{"state":"failed","message":"pixi.min.js 加载失败"}""").toString())
    assertEquals("failed", failed?.state)
    assertEquals("pixi.min.js 加载失败", failed?.message)
  }

  @Test fun `first avatar load has a deadline and only one automatic compatible retry`() {
    val monitor = AvatarLoadMonitor()
    monitor.start(100)
    assertFalse(monitor.timedOut(30_099))
    assertTrue(monitor.timedOut(30_100))
    assertTrue(monitor.retry()); assertTrue(monitor.compatible)
    monitor.start(40_000)
    assertFalse(monitor.timedOut(69_999)); assertTrue(monitor.timedOut(70_000))
    assertFalse(monitor.retry())
    // Explicit user retry gets a fresh budget; pause/resume restarts the active deadline.
    monitor.reset(); monitor.start(200_000)
    assertFalse(monitor.compatible); assertFalse(monitor.timedOut(200_000)); assertTrue(monitor.retry())
  }

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

  @Test fun `voice sentence chunker, WAV encoder, and adaptive VAD work cleanly for real-time voice calls`() {
    val chunker = VoiceSentenceChunker()
    chunker.append("哼，主人好呀！")
    assertEquals("哼，主人好呀！", chunker.take())
    chunker.append("```kotlin\nprintln(1)\n```已经帮你搞定啦。")
    assertEquals("已经帮你搞定啦。", chunker.take())
    chunker.append("尾巴还在摇哦")
    assertNull(chunker.take(force = false))
    assertEquals("尾巴还在摇哦", chunker.take(force = true))

    val pcm = ByteArray(3200) { (it % 127).toByte() }
    val wav = WavEncoder.encodePcm16Mono(pcm, 16000)
    assertEquals(44 + pcm.size, wav.size)
    assertEquals("RIFF", String(wav, 0, 4, Charsets.US_ASCII))
    assertEquals("WAVE", String(wav, 8, 4, Charsets.US_ASCII))

    val vad = VoiceVadDetector(speechHoldMs = 100L, silenceEndMs = 800L)
    vad.reset(0L)
    assertEquals(VoiceVadDetector.Decision.CONTINUE, vad.feed(0.005f, 50L))
    assertEquals(VoiceVadDetector.Decision.CONTINUE, vad.feed(0.12f, 100L))
    assertEquals(VoiceVadDetector.Decision.SPEECH_STARTED, vad.feed(0.15f, 220L))
    assertTrue(vad.hasSpeech)
    assertEquals(VoiceVadDetector.Decision.CONTINUE, vad.feed(0.004f, 600L))
    assertEquals(VoiceVadDetector.Decision.SPEECH_ENDED, vad.feed(0.004f, 1100L))
  }

  @Test fun `sendVoiceCallTurn streams spoken sentences immediately on SSE punctuation`() = runBlocking {
    MockWebServer().use { server ->
      server.start()
      server.enqueue(response("""{"device":{"id":"$testDevice","platform":"android"}}"""))
      server.enqueue(response("""{"protocol":"anylink","version":"3.2"}"""))
      server.enqueue(response("""{"device_id":"$testDevice","memories":[],"boundaries":[],"episodes":[],"summary_text":""}"""))
      val multiChunkSse =
        "data: {\"choices\":[{\"delta\":{\"content\":\"主人好呀！\"},\"finish_reason\":null}]}\n\n" +
          "data: {\"choices\":[{\"delta\":{\"content\":\"我随时听你吩咐哦。\"},\"finish_reason\":null}]}\n\n" +
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
          "data: [DONE]\n\n"
      server.enqueue(stream(multiChunkSse))
      server.enqueue(response("""{"episode_id":"ep-call","status":"pending"}"""))
      val conn = CloudConnection(server.url("/").toString().trimEnd('/'), testToken, testDevice)
      val agent = DeviceAgent(conn, CloudClient(conn), MemoryLedger(), { JsonObject(emptyMap()) })
      val sentences = mutableListOf<String>()
      val reply = agent.sendVoiceCallTurn("你在吗", onSentence = { sentences += it })
      assertEquals("主人好呀！我随时听你吩咐哦。", reply)
      assertEquals(listOf("主人好呀！", "我随时听你吩咐哦。"), sentences)
    }
  }
  @Test fun `voice preflight refuses unavailable cloud and preserves system recognition`() {
    assertEquals("system", chooseVoiceEngine("auto", system = true, cloud = false))
    assertNull(chooseVoiceEngine("auto", system = false, cloud = false))
    assertNull(chooseVoiceEngine("cloud", system = true, cloud = false))
    assertEquals("cloud", chooseVoiceEngine("auto", system = false, cloud = true))
    assertEquals("system", chooseVoiceEngine("system", system = true, cloud = true))
  }

  @Test fun `downloaded offline recognition takes priority without changing explicit system or cloud choices`() {
    assertEquals("offline", chooseVoiceEngine("auto", system = true, cloud = true, offline = true))
    assertEquals("offline", chooseVoiceEngine("offline", system = false, cloud = false, offline = true))
    assertNull(chooseVoiceEngine("offline", system = true, cloud = true, offline = false))
    assertEquals("system", chooseVoiceEngine("system", system = true, cloud = true, offline = true))
    assertNull(chooseVoiceEngine("cloud", system = true, cloud = false, offline = true))
  }

  @Test fun `offline model validation refuses truncated and same size corrupted files`() {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    val file = java.io.File.createTempFile("model-check-", ".bin", app.cacheDir)
    val bytes = "validated model".toByteArray()
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    val spec = OfflineModelFile("model.int8.onnx", bytes.size.toLong(), digest)
    try {
      file.writeBytes(bytes); assertTrue(verifyOfflineModelFile(file, spec))
      file.writeBytes(bytes.copyOf(bytes.size - 1)); assertFalse(verifyOfflineModelFile(file, spec))
      file.writeBytes(bytes.copyOf().also { it[0] = 0 }); assertFalse(verifyOfflineModelFile(file, spec))
    } finally { file.delete() }
  }

  @Test fun `offline model manifest requires fixed HTTPS origins revision and expected safe filenames`() {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    val spec = OfflineAsrModelSpec.load(app)
    assertTrue(spec.bytes in 100_000_000..300_000_000)
    assertEquals(4, spec.files.size)
    for (files in listOf(spec.files + spec.files.first(), spec.files.map { it.copy(name = "../model.int8.onnx") })) {
      assertThrows(IllegalArgumentException::class.java) { spec.copy(files = files) }
    }
    assertThrows(IllegalArgumentException::class.java) { spec.copy(origins = listOf("http://example.com")) }
    assertThrows(IllegalArgumentException::class.java) { spec.copy(revision = "main") }
  }

  private fun modelFixture(): Pair<OfflineAsrModelSpec, Map<String, ByteArray>> {
    val content = listOf("encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.onnx", "tokens.txt")
      .mapIndexed { index, name -> name to "fixture model $index".toByteArray() }.toMap()
    val files = content.map { (name, bytes) -> OfflineModelFile(name, bytes.size.toLong(), java.security.MessageDigest.getInstance("SHA-256")
      .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }) }
    return OfflineAsrModelSpec("test-" + java.util.UUID.randomUUID(), "0".repeat(40), "test/model", listOf("https://huggingface.co", "https://hf-mirror.com"), files) to content
  }

  @Test fun `offline model installation publishes only complete verified files and rechecks stored integrity`() = runBlocking {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    val (spec, content) = modelFixture()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    org.robolectric.shadows.ShadowStatFs.registerStats(app.filesDir.absolutePath, 1000000, 1000000, 1000000)
    val http = OkHttpClient.Builder().addInterceptor { chain -> Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
      .code(200).message("OK").body(content.getValue(chain.request().url.pathSegments.last()).toResponseBody()).build() }.build()
    val models = OfflineAsrModels(app, scope, spec, http)
    try {
      models.download()
      assertTrue(models.state.value.ready); assertFalse(models.state.value.downloading)
      assertTrue(spec.files.all { verifyOfflineModelFile(java.io.File(models.directory, it.name), it) })
      assertFalse(java.io.File(models.directory.parentFile, models.directory.name + ".pending").exists())
      java.io.File(models.directory, "tokens.txt").writeText("corrupted")
      models.refresh(); assertFalse(models.state.value.ready)
    } finally { scope.cancel(); models.directory.deleteRecursively() }
  }

  @Test fun `corrupted model download never becomes available or leaves a partial installation`() = runBlocking {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    val (spec, _) = modelFixture()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    org.robolectric.shadows.ShadowStatFs.registerStats(app.filesDir.absolutePath, 1000000, 1000000, 1000000)
    val http = OkHttpClient.Builder().addInterceptor { chain ->
      val file = spec.files.first { it.name == chain.request().url.pathSegments.last() }
      Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(ByteArray(file.bytes.toInt()).toResponseBody()).build()
    }.build()
    val models = OfflineAsrModels(app, scope, spec, http)
    try {
      models.download()
      assertFalse(models.state.value.ready); assertFalse(models.state.value.downloading)
      assertTrue(models.state.value.error.contains("校验")); assertFalse(models.directory.exists())
      assertFalse(java.io.File(models.directory.parentFile, models.directory.name + ".pending").exists())
    } finally { scope.cancel(); models.directory.deleteRecursively() }
  }

  @Test fun `lip envelope closes for silent audio and outside playback bounds`() {
    assertEquals(0f, SpeechEnvelope.normalizedRms(0.0, 320))
    val voiced = SpeechEnvelope.normalizedRms(12.8, 320)
    assertTrue(voiced > 0.5f)
    val envelope = SpeechEnvelope(listOf(0f, voiced, 0f))
    assertEquals(0f, envelope.levelAt(-1)); assertEquals(voiced, envelope.levelAt(25))
    assertEquals(0f, envelope.levelAt(45)); assertEquals(0f, envelope.levelAt(5000))
  }

  @Test fun `local TTS WAV yields a playback clock with silent and voiced frames`() = runBlocking {
    val app = org.robolectric.RuntimeEnvironment.getApplication()
    val pcm = ByteArray(1600 * 2)
    for (i in 320 until 960) { val value = if (i % 2 == 0) 8000 else -8000; pcm[i * 2] = value.toByte(); pcm[i * 2 + 1] = (value shr 8).toByte() }
    val file = java.io.File.createTempFile("tts-clock-", ".wav", app.cacheDir)
    try {
      file.writeBytes(WavEncoder.encodePcm16Mono(pcm))
      val envelope = SpeechEnvelope.decode(file)
      assertEquals(5, envelope.levels.size)
      assertEquals(0f, envelope.levelAt(0)); assertTrue(envelope.levelAt(30) > 0.5f)
      assertEquals(0f, envelope.levelAt(90)); assertEquals(0f, envelope.levelAt(120))
    } finally { file.delete() }
  }

}
