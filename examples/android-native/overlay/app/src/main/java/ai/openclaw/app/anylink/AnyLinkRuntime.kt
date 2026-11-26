package ai.openclaw.app.anylink

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/** Process-wide owner of the connection, device agent, WebSocket bus, worker, voice and overlay state. */
internal class AnyLinkRuntime private constructor(private val app: Application) {
  companion object {
    @Volatile private var instance: AnyLinkRuntime? = null
    fun get(application: Application): AnyLinkRuntime =
      instance ?: synchronized(this) { instance ?: AnyLinkRuntime(application).also { instance = it } }
  }

  private val prefs = app.getSharedPreferences("anylink-companion", Context.MODE_PRIVATE)
  val profiles = ConnectionStore(app)
  val agent = MutableStateFlow<DeviceAgent?>(null)
  val connection = MutableStateFlow<CloudConnection?>(null)
  val error = MutableStateFlow("")
  val connecting = MutableStateFlow(false)
  val tasks = MutableStateFlow<List<JsonObject>>(emptyList())
  val wsOnline = MutableStateFlow(false)
  val listening = MutableStateFlow(false)
  val speaking = MutableStateFlow(false)
  val voiceNotice = MutableStateFlow("")
  val activityVisible = MutableStateFlow(false)
  val serviceRunning = MutableStateFlow(false)
  val overlayVisible = MutableStateFlow(false)

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  // Separate CloudClient instances for chat vs background worker prevent concurrent cancel clobbering.
  private var chatCloud: CloudClient? = null
  private var workerCloud: CloudClient? = null
  private var wsClient: AnyLinkWebSocket? = null
  private val workerWakeup = Channel<Unit>(Channel.CONFLATED)
  private var turn: Job? = null
  private var workerJob: Job? = null
  private var recognizer: SpeechRecognizer? = null
  private var speech: TextToSpeech? = null
  private var speechReady = false
  private var speechPlayer: SpeechPlayer? = null
  private var lastSpokenRun = ""
  private val announcedTasks = mutableSetOf<String>()

  init {
    try { profiles.load()?.let(::activate) } catch (_: Exception) { error.value = "无法解密原设备凭据，请重新连接；原会话和便笺保留。" }
    speechPlayer = SpeechPlayer(app, scope, { connection.value },
      { text, flush -> speakSystem(text, flush) },
      { speaking.value = it })
  }

  // ---- connection / agent -------------------------------------------------

  private fun activate(value: CloudConnection) {
    wsClient?.close(); wsClient = null; wsOnline.value = false
    workerJob?.cancel(); workerJob = null
    connection.value = value
    val chat = CloudClient(value); chatCloud = chat
    workerCloud = CloudClient(value)
    agent.value = DeviceAgent(value, chat, SqlAgentLedger(app, value), { infoJson(value) }, PersonaProvider { readPersona() })
    refreshOverlay()
    syncWorker()
  }

  private fun readPersona(): Pair<String, String> {
    fun read(name: String) = runCatching { app.assets.open("anylink/$name").bufferedReader().use { it.readText() } }.getOrDefault("")
    return read("persona-shared.md") to read("persona-android.md")
  }

  private fun infoJson(value: CloudConnection) = jsonObject(
    "platform" to str("android"),
    "manufacturer" to str(Build.MANUFACTURER),
    "model" to str(Build.MODEL),
    "android_version" to str(Build.VERSION.RELEASE),
    "device_id" to str(value.deviceId),
    "device_slug" to str(value.deviceSlug),
    "runtime" to str("on-device-agent"),
    "mac_required" to JsonPrimitive(false),
  )

  fun connectJoin(server: String, joinKey: String, deviceName: String, deviceSlug: String = "", finished: () -> Unit) {
    if (connecting.value || agent.value?.state?.value?.busy == true) return
    connecting.value = true; error.value = ""
    scope.launch {
      try {
        val install = profiles.installId()?.takeIf { Regex("android-[0-9a-fA-F-]{36}").matches(it) } ?: "android-${UUID.randomUUID()}"
        val legacy = try { profiles.load() } catch (_: Exception) { null }
        if (legacy != null && legacy.installId.isBlank() && legacy.server == server.trim().trimEnd('/')) {
          val adopted = CloudConnection.adoptInstallId(CloudClient(legacy), install)
          if (!adopted) error.value = "旧设备凭据已失效，已按新设备接入；原设备记忆保留在服务器上。"
        }
        val value = CloudConnection.join(server, joinKey, install, deviceName, deviceSlug)
        val candidate = DeviceAgent(value, CloudClient(value), SqlAgentLedger(app, value), { JsonObject(emptyMap()) })
        candidate.verify(); profiles.save(value); activate(value); tasks.value = emptyList(); finished()
      } catch (failure: Exception) { error.value = (failure as? LinkFailure)?.message ?: "连接失败。请检查服务器地址、登录密码或短别名。" }
      finally { connecting.value = false }
    }
  }

  fun connect(server: String, credential: String, finished: () -> Unit) {
    if (connecting.value || agent.value?.state?.value?.busy == true) return
    connecting.value = true; error.value = ""
    scope.launch {
      try {
        val value = CloudConnection.parse(server, credential)
        val candidate = DeviceAgent(value, CloudClient(value), SqlAgentLedger(app, value), { JsonObject(emptyMap()) })
        candidate.verify(); profiles.save(value); activate(value); tasks.value = emptyList(); finished()
      } catch (failure: Exception) { error.value = (failure as? LinkFailure)?.message ?: "连接未通过。检查 HTTPS 地址及手机自己的设备凭据 JSON。" }
      finally { connecting.value = false }
    }
  }

  fun send(text: String) {
    val active = agent.value ?: return
    if (active.state.value.busy || text.isBlank()) return
    error.value = ""
    turn = scope.launch {
      try { active.send(text.trim()) } catch (_: Exception) { error.value = "请输入1到8000字。" }
      val last = active.state.value.runs.firstOrNull()
      if (last?.text("state") == "completed" && last.text("id") != lastSpokenRun && last.text("answer").isNotBlank()) {
        lastSpokenRun = last.text("id")
        speechPlayer?.enqueue(last.text("answer").take(3500), summarize = true, interrupt = true)
      }
    }
  }

  fun stop() { agent.value?.stop(); turn?.cancel() }

  suspend fun refreshTasks() {
    val value = connection.value ?: return
    try {
      val reader = CloudClient(value)
      val merged = mutableListOf<JsonObject>()
      for (role in listOf("source", "target")) {
        val items = reader.request("GET", "/edge/v1/tasks?role=$role")["items"]!!.jsonArray.map { it.jsonObject }
        merged += items.map { JsonObject(it + mapOf("_role" to str(role))) }
      }
      if (connection.value == value) tasks.value = merged
    } catch (_: Exception) { }
  }

  // ---- real-time WebSocket & foreground worker ----------------------------

  private fun workerWanted() = activityVisible.value || serviceRunning.value

  private fun syncWorker() {
    if (workerWanted()) {
      val value = connection.value ?: return
      val transport = workerCloud ?: return
      if (wsClient == null) {
        val socket = AnyLinkWebSocket(
          connection = value,
          onState = { online -> wsOnline.value = online; if (online) workerWakeup.trySend(Unit) },
          onFrame = { frame -> handleWsFrame(frame) },
        )
        wsClient = socket
        socket.connect()
      }
      if (workerJob?.isActive == true) return
      workerJob = scope.launch { workerLoop(transport, value) }
    } else {
      workerJob?.cancel(); workerJob = null
      wsClient?.close(); wsClient = null; wsOnline.value = false
    }
  }

  private fun handleWsFrame(frame: JsonObject) {
    when (frame.text("type")) {
      "task.available" -> workerWakeup.trySend(Unit)
      "task.progress" -> {
        val progress = frame["progress"] as? JsonObject ?: return
        val msg = progress.text("message")
        if (msg.isNotBlank()) voiceNotice.value = msg
        scope.launch { refreshTasks() }
      }
      "task.completed" -> {
        val task = frame["task"] as? JsonObject ?: return
        scope.launch { refreshTasks() }
        announceCompletedOutboundTask(task)
      }
    }
  }

  private fun announceCompletedOutboundTask(task: JsonObject) {
    val id = task.text("id")
    if (id.isBlank() || !announcedTasks.add(id)) return
    val result = task["result"] as? JsonObject
    val output = result?.get("output") as? JsonObject
    val err = result?.get("error") as? JsonObject
    val spoken = when (task.text("state")) {
      "succeeded" -> {
        val reply = output?.text("reply")?.ifBlank { output.text("text") }.orEmpty()
        if (reply.isNotBlank()) "跨设备任务完成啦：$reply" else "跨设备任务已经完成啦。"
      }
      "declined" -> "对方设备暂时做不到：${err?.text("message").orEmpty().ifBlank { "超出对方环境范围" }}"
      "failed" -> "跨设备任务未完成：${err?.text("message").orEmpty().ifBlank { "执行失败" }}"
      "unknown" -> "跨设备任务结果未确认，请查看任务面板。"
      else -> return
    }
    voiceNotice.value = spoken.take(240)
    agent.value?.appendEvent(
      role = "event",
      text = spoken,
      meta = if (task.text("state") == "succeeded") "跨设备回执 · 已完成" else "跨设备回执 · ${task.text("state")}",
    )
    agent.value?.state?.update { it.copy(emotion = if (task.text("state") == "succeeded") "happy" else "apologetic", gesture = "wave", sequence = UUID.randomUUID().toString()) }
    speechPlayer?.enqueue(spoken.take(3500), summarize = spoken.length > 80, interrupt = false)
  }

  private suspend fun workerLoop(transport: CloudClient, value: CloudConnection) {
    val ledger = SqlAgentLedger(app, value)
    linkWorkerLoop(
      transport = transport,
      ledger = ledger,
      info = { infoJson(value) },
      say = { text, source -> companionSay(text, source) },
      wakeup = workerWakeup,
      isWsOnline = { wsOnline.value },
    )
  }

  private fun companionSay(text: String, source: String) {
    voiceNotice.value = "来自 $source：$text"
    agent.value?.appendEvent(role = "event", text = text, meta = "来自 $source")
    agent.value?.state?.update { it.copy(emotion = "happy", gesture = "wave", sequence = UUID.randomUUID().toString()) }
    speechPlayer?.enqueue(text, summarize = false, interrupt = false)
  }

  fun onActivityStarted() { activityVisible.value = true; prefs.edit().putBoolean("overlay_dismissed", false).apply(); syncWorker(); refreshOverlay() }
  fun onActivityStopped() { activityVisible.value = false; syncWorker(); refreshOverlay() }
  fun onServiceStarted() { serviceRunning.value = true; syncWorker(); refreshOverlay() }
  fun onServiceStopped() { serviceRunning.value = false; recognizer?.cancel(); listening.value = false; syncWorker(); refreshOverlay() }

  // ---- voice ---------------------------------------------------------------

  private fun ensureSpeech() {
    if (speech != null) return
    speech = TextToSpeech(app) { status ->
      speechReady = status == TextToSpeech.SUCCESS
      if (speechReady) { speech?.language = Locale.SIMPLIFIED_CHINESE; speech?.setSpeechRate(1.08f); speech?.setPitch(1.12f) }
    }
    speech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) { speaking.value = true }
      override fun onDone(utteranceId: String?) { speaking.value = false }
      @Deprecated("Required platform callback") override fun onError(utteranceId: String?) { speaking.value = false; voiceNotice.value = "播报失败，请查看文字结果。" }
    })
  }
  private fun speakSystem(text: String, flush: Boolean) {
    ensureSpeech()
    if (speechReady) speech?.speak(text, if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "tts-${UUID.randomUUID()}")
  }
  fun micGranted() = androidx.core.content.ContextCompat.checkSelfPermission(app, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
  fun startListening() {
    if (listening.value) { recognizer?.cancel(); listening.value = false; return }
    if (speaking.value || agent.value?.state?.value?.busy == true) { interruptAll(); return }
    if (connection.value == null) { voiceNotice.value = "先连接服务器再和我说话。"; return }
    if (!micGranted()) { voiceNotice.value = "需要麦克风权限，点我打开应用授权。"; openApp(); return }
    if (!SpeechRecognizer.isRecognitionAvailable(app)) { voiceNotice.value = "系统没有语音识别服务，请使用文字输入。"; return }
    recognizer?.destroy()
    recognizer = if (SpeechRecognizer.isOnDeviceRecognitionAvailable(app)) SpeechRecognizer.createOnDeviceSpeechRecognizer(app) else SpeechRecognizer.createSpeechRecognizer(app)
    recognizer?.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) { listening.value = true; voiceNotice.value = "我在听。点击停止可随时打断。" }
      override fun onBeginningOfSpeech() = Unit
      override fun onRmsChanged(rmsdB: Float) = Unit
      override fun onBufferReceived(buffer: ByteArray?) = Unit
      override fun onEndOfSpeech() { listening.value = false }
      override fun onError(error: Int) { listening.value = false; voiceNotice.value = "没有收到完整语音（$error），可以重说或输入文字。" }
      override fun onResults(results: Bundle?) {
        listening.value = false
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { voiceNotice.value = it; send(it) }
      }
      override fun onPartialResults(partialResults: Bundle?) { partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { voiceNotice.value = it } }
      override fun onEvent(eventType: Int, params: Bundle?) = Unit
    })
    recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN").putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true).putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true))
  }
  fun interruptVoice() {
    speechPlayer?.interrupt(); speech?.stop(); recognizer?.cancel()
    listening.value = false; speaking.value = false
  }
  fun interruptAll() { stop(); interruptVoice() }

  fun openApp() {
    app.packageManager.getLaunchIntentForPackage(app.packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      runCatching { app.startActivity(it) }
    }
  }

  // ---- floating companion ---------------------------------------------------

  fun overlayPermitted() = android.provider.Settings.canDrawOverlays(app)
  fun overlayEnabled() = prefs.getBoolean("overlay_enabled", true)
  fun setOverlayEnabled(value: Boolean) { prefs.edit().putBoolean("overlay_enabled", value).apply(); refreshOverlay() }
  fun overlayDismissed() = prefs.getBoolean("overlay_dismissed", false)
  fun dismissOverlay() { prefs.edit().putBoolean("overlay_dismissed", true).apply(); refreshOverlay() }
  fun overlayPosition(): Pair<Int, Int>? {
    if (!prefs.contains("overlay_x")) return null
    return prefs.getInt("overlay_x", 0) to prefs.getInt("overlay_y", 0)
  }
  fun setOverlayPosition(x: Int, y: Int) { prefs.edit().putInt("overlay_x", x).putInt("overlay_y", y).apply() }

  fun refreshOverlay() {
    val show = serviceRunning.value && overlayEnabled() && !overlayDismissed() && overlayPermitted() && connection.value != null && !activityVisible.value
    if (show == overlayVisible.value) return
    val ok = if (show) CompanionOverlay.show(app) else { CompanionOverlay.hide(); true }
    overlayVisible.value = show && ok
  }
}
