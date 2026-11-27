package ai.openclaw.app.anylink

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Process-wide owner of the connection, device agent, Protocol v3.2 WebSocket bus, worker, voice and overlay state. */
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
  val pendingFile = MutableStateFlow<PickedFile?>(null)
  val uploadingFile = MutableStateFlow(false)
  val maxSteps = MutableStateFlow(prefs.getInt("agent_max_steps", DEFAULT_AGENT_MAX_STEPS))
  val acceptsFiles = MutableStateFlow(prefs.getBoolean("file_accepts", true))
  val maxReceiveFileBytes = MutableStateFlow(prefs.getLong("file_max_receive_bytes", AnyLinkFiles.MAX_BYTES))
  val confirmFileOverBytes = MutableStateFlow(prefs.getLong("file_confirm_over_bytes", AnyLinkFiles.DEFAULT_CONFIRM_OVER_BYTES))
  val allowRemoteControl = MutableStateFlow(prefs.getBoolean("allow_remote_control", true))
  val avatarStatus = MutableStateFlow("初始化中…")
  val avatarReloadTick = MutableStateFlow(0)
  val privateCharacterMode: Boolean = runCatching {
    app.assets.open("anylink/character-mode.json").bufferedReader().use {
      linkJson.parseToJsonElement(it.readText()).jsonObject["private_character"]?.jsonPrimitive?.booleanOrNull == true
    }
  }.getOrDefault(false)
  val activityVisible = MutableStateFlow(false)
  val serviceRunning = MutableStateFlow(false)
  val overlayVisible = MutableStateFlow(false)

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val pendingLocalApprovals = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()
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
    agent.value = DeviceAgent(value, chat, SqlAgentLedger(app, value), { infoJson(value) }, PersonaProvider { readPersona() }, { maxSteps.value })
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
        val answer = last.text("answer")
        if (!activityVisible.value) {
          AnyLinkCompanionService.notifyProactive(app, "大肥鱼回复你啦", answer, tag = "reply:${last.text("id")}")
        }
        speechPlayer?.enqueue(answer.take(3500), summarize = true, interrupt = true, forceRewrite = true)
      }
    }
  }

  fun replyToTask(taskId: String, approved: Boolean? = null, choice: String? = null, message: String? = null) {
    if (taskId.startsWith("local-file:")) {
      val realId = taskId.removePrefix("local-file:")
      val accept = approved != false
      pendingLocalApprovals.remove(realId)?.complete(accept)
      agent.value?.markInteractionResolved(taskId, if (accept) "已确认接收" else "已拒收")
      voiceNotice.value = if (accept) "好哒主人，正在开始流式下载这个大文件…" else "好哒主人，已经帮你拒收这个大文件啦，没费一丁点流量！"
      return
    }
    val value = connection.value ?: return
    scope.launch {
      val body = buildJsonObject {
        approved?.let { put("approved", JsonPrimitive(it)) }
        choice?.takeIf { it.isNotBlank() }?.let { put("choice", str(it)) }
        message?.takeIf { it.isNotBlank() }?.let { put("message", str(it)) }
      }
      val ok = runCatching {
        CloudClient(value).request("POST", "/edge/v1/tasks/$taskId/reply", body, "reply:$taskId:${UUID.randomUUID()}")
      }.isSuccess
      if (ok) {
        val summary = when {
          approved == true -> "已批准"
          approved == false -> "已拒绝"
          !choice.isNullOrBlank() -> "已选：$choice"
          else -> "已回复"
        }
        agent.value?.markInteractionResolved(taskId, summary)
        voiceNotice.value = if (approved == false) "好哒主人，我告诉那边先不要做了。" else "收到啦主人，我这就让另一边接着办！"
        refreshTasks()
      } else {
        voiceNotice.value = "唔，回复没送出去，稍后再点一次试试看～"
      }
    }
  }

  fun selectFile(uri: Uri) {
    runCatching { AnyLinkFiles.readPickedFile(app, uri) }
      .onSuccess { picked ->
        error.value = ""
        pendingFile.value = picked
        voiceNotice.value = "已选附件：${picked.filename}（${AnyLinkFiles.formatSize(picked.sizeBytes)}），点发送即可传给电脑或附带指令。"
      }
      .onFailure { e ->
        error.value = e.message ?: "无法读取该文件"
      }
  }

  fun clearPendingFile() { pendingFile.value = null }

  fun sendWithOptionalFile(text: String) {
    val picked = pendingFile.value
    if (picked == null) {
      if (text.isNotBlank()) send(text)
      return
    }
    val value = connection.value ?: return
    val active = agent.value ?: return
    if (uploadingFile.value || active.state.value.busy) return
    pendingFile.value = null
    uploadingFile.value = true
    error.value = ""
    val note = text.trim()
    scope.launch {
      try {
        val uploader = CloudClient(value)
        // Pre-flight 1: negotiate cloud server artifact limit dynamically from /edge/v1/protocol.
        val proto = runCatching { uploader.request("GET", "/edge/v1/protocol") }.getOrNull()
        val serverMax = (proto?.get("limits") as? JsonObject)?.get("artifact_max_bytes")?.jsonPrimitive?.longOrNull ?: AnyLinkFiles.MAX_BYTES
        if (picked.sizeBytes > serverMax) {
          throw LinkFailure("ARTIFACT_TOO_LARGE", "文件《${picked.filename}》（${AnyLinkFiles.formatSize(picked.sizeBytes)}）超过云端单文件上限 ${AnyLinkFiles.formatSize(serverMax)}，未上传。")
        }

        // Pre-flight 2 (for 1-tap direct send): resolve target Mac & validate its file_policy BEFORE uploading any bytes!
        var directTarget: JsonObject? = null
        var directTargetName = "Mac"
        var targetNeedsConfirm = false
        if (note.isEmpty()) {
          val dir = uploader.request("GET", "/edge/v1/directory")
          val items = (dir["items"] as? JsonArray).orEmpty().map { it.jsonObject }
          val peers = items.filter { (it["device"] as? JsonObject)?.text("id") != value.deviceId }
          val macs = peers.filter { (it["device"] as? JsonObject)?.text("platform") == "macos" }
          val chosen = macs.firstOrNull { (it["agents"] as? JsonArray).orEmpty().any { a -> a.jsonObject["ws_online"]?.jsonPrimitive?.booleanOrNull == true } }
            ?: macs.firstOrNull()
            ?: peers.singleOrNull()
          if (chosen == null) throw LinkFailure("TARGET_DEVICE_REQUIRED", "没有找到在线电脑设备，请先确认 Mac 已连接云端。")
          val agents = (chosen["agents"] as? JsonArray).orEmpty().map { it.jsonObject }
          val preferred = agents.firstOrNull { it.text("key") == "mac-openclaw" }
            ?: agents.firstOrNull { it["ws_online"]?.jsonPrimitive?.booleanOrNull == true }
            ?: agents.firstOrNull()
          directTargetName = (chosen["device"] as JsonObject).text("name").ifBlank { "Mac" }
          val targetPolicy = preferred?.get("file_policy") as? JsonObject
          if (targetPolicy != null) {
            if (targetPolicy["accepts_files"]?.jsonPrimitive?.booleanOrNull == false) {
              throw LinkFailure("TARGET_FILE_RECEIVE_DISABLED", "目标设备「$directTargetName」不支持或已关闭接收文件功能，未上传。")
            }
            val targetMax = targetPolicy["max_file_bytes"]?.jsonPrimitive?.longOrNull
            if (targetMax != null && picked.sizeBytes > targetMax) {
              throw LinkFailure("TARGET_FILE_TOO_LARGE", "文件《${picked.filename}》（${AnyLinkFiles.formatSize(picked.sizeBytes)}）超过「$directTargetName」单文件接收上限 ${AnyLinkFiles.formatSize(targetMax)}，未上传。")
            }
            val targetAvail = targetPolicy["available_bytes"]?.jsonPrimitive?.longOrNull
            if (targetAvail != null && picked.sizeBytes > targetAvail) {
              throw LinkFailure("TARGET_INSUFFICIENT_STORAGE", "目标设备「$directTargetName」剩余存储空间不足（剩余 ${AnyLinkFiles.formatSize(targetAvail)}），未上传。")
            }
            val confirmOver = targetPolicy["confirm_over_bytes"]?.jsonPrimitive?.longOrNull
            if (confirmOver != null && confirmOver > 0L && picked.sizeBytes > confirmOver) targetNeedsConfirm = true
          }
          directTarget = if (preferred != null) jsonObject("agent_id" to str(preferred.text("id"))) else jsonObject("device_id" to str((chosen["device"] as JsonObject).text("id")))
        }

        voiceNotice.value = "正在流式上传《${picked.filename}》（${AnyLinkFiles.formatSize(picked.sizeBytes)}）…"
        val uploaded = uploader.uploadArtifactStream(app, picked.uri, picked.filename, picked.mimeType, picked.sizeBytes, serverMax)
        val artifactId = uploaded.text("id")
        val filename = uploaded.text("filename").ifBlank { picked.filename }
        val contentType = uploaded.text("content_type").ifBlank { picked.mimeType }
        val sizeBytes = uploaded["size_bytes"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: picked.sizeBytes
        val sha256 = uploaded.text("sha256")

        if (note.isEmpty() && directTarget != null) {
          // Instant 1-tap file transfer directly to Mac (no LLM latency)
          active.appendFileMessage(
            role = "user",
            text = "发送文件给电脑",
            meta = "我发送的文件",
            fileName = filename,
            fileUri = picked.uri.toString(),
            fileMime = contentType,
            fileSize = sizeBytes,
          )
          uploader.request("POST", "/edge/v1/tasks", buildJsonObject {
            put("target", directTarget)
            put("capability", str("file.deliver"))
            put("instruction", str("接收来自手机的文件《$filename》"))
            put("input", buildJsonObject {
              put("artifact_id", str(artifactId))
              put("filename", str(filename))
              put("content_type", str(contentType))
              put("size_bytes", JsonPrimitive(sizeBytes))
              if (sha256.isNotBlank()) put("sha256", str(sha256))
            })
          }, "file-deliver:$artifactId")
          val suffix = if (targetNeedsConfirm) "（文件较大，对方确认后即可保存）" else "，签收后会通知你哦～"
          active.appendEvent(role = "event", text = "《$filename》（${AnyLinkFiles.formatSize(sizeBytes)}）已上传云端并派发给 $directTargetName$suffix", meta = "跨设备传文件")
          voiceNotice.value = "文件已发给 $directTargetName，等待签收…"
          refreshTasks()
        } else {
          // File + custom instruction: let DeviceAgent send or forward artifact_id with full context
          val enriched = "[用户已随本消息上传本地附件：filename=\"$filename\", content_type=\"$contentType\", size_bytes=$sizeBytes, artifact_id=\"$artifactId\", sha256=\"$sha256\"。若只是保存给电脑请直接调用 file_send；若需要电脑处理该文件请在 task_invoke 的 input 里带上 artifact_id 与 filename。]\n$note"
          voiceNotice.value = "附件《$filename》已上传，正在交给大肥鱼处理…"
          uploadingFile.value = false
          send(enriched)
          return@launch
        }
      } catch (e: Exception) {
        error.value = e.message ?: "上传文件失败，请稍后重试。"
      } finally {
        uploadingFile.value = false
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
          onState = { online ->
            wsOnline.value = online
            if (online) {
              workerWakeup.trySend(Unit)
              scope.launch { runCatching { agent.value?.flushOutbox() } }
            }
          },
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
      "task.awaiting_input", "task.awaiting_approval" -> {
        val task = frame["task"] as? JsonObject ?: return
        val taskId = task.text("id")
        val interaction = (frame["interaction"] as? JsonObject) ?: (task["pending_interaction"] as? JsonObject) ?: return
        val prompt = interaction.text("prompt").ifBlank { "另一边的设备需要主人确认一下才能继续哦。" }
        val choices = (interaction["choices"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
        val risk = interaction.text("risk_level")
        val isApproval = frame.text("type") == "task.awaiting_approval"
        agent.value?.appendInteraction(
          taskId = taskId,
          interactionType = if (isApproval) "awaiting_approval" else "awaiting_input",
          prompt = prompt,
          choices = choices,
          riskLevel = risk,
          meta = if (isApproval) "跨设备高危审批" else "跨设备追问",
        )
        agent.value?.state?.update { it.copy(emotion = "curious", gesture = "point", sequence = UUID.randomUUID().toString()) }
        val spokenHint = if (isApproval) "主人，另一边准备做个重要操作，等你点头批准呢，快看看屏幕确认吧！" else "唔，主人，另一边有件事想先问问你的意见，点一下聊天卡片就能回复哦。"
        voiceNotice.value = prompt.take(120)
        AnyLinkCompanionService.notifyProactive(
          app,
          title = if (isApproval) "大肥鱼等你批准操作" else "大肥鱼有件事想问你",
          body = prompt,
          tag = "interact:$taskId",
          urgent = isApproval,
        )
        speechPlayer?.enqueue(spokenHint, summarize = false, interrupt = false, forceRewrite = false)
        scope.launch { refreshTasks() }
      }
      "task.completed" -> {
        val task = frame["task"] as? JsonObject ?: return
        scope.launch { refreshTasks() }
        announceCompletedOutboundTask(task)
      }
    }
  }

  private fun acknowledgeReceipt(taskId: String) {
    if (taskId.isBlank()) return
    val sentWs = wsClient?.ackReceipt(taskId) == true
    if (!sentWs) {
      val conn = connection.value ?: return
      scope.launch { runCatching { CloudClient(conn).request("POST", "/edge/v1/tasks/$taskId/ack", JsonObject(emptyMap())) } }
    }
  }

  private fun announceCompletedOutboundTask(task: JsonObject) {
    val id = task.text("id")
    if (id.isBlank()) return
    acknowledgeReceipt(id)
    if (!announcedTasks.add(id)) return
    val result = task["result"] as? JsonObject
    val output = result?.get("output") as? JsonObject
    val err = result?.get("error") as? JsonObject
    val state = task.text("state")
    val displayText: String
    val speechInput: String
    val forcePersonaRewrite: Boolean
    when (state) {
      "succeeded" -> {
        val reply = output?.text("reply")?.ifBlank { output.text("text") }.orEmpty()
        displayText = if (reply.isNotBlank()) reply else "另一边已经把事情办妥啦。"
        speechInput = if (reply.isNotBlank()) reply else "主人，另一边交给我的事已经搞定啦！"
        forcePersonaRewrite = reply.isNotBlank()
      }
      "declined" -> {
        val msg = err?.text("message").orEmpty().ifBlank { "当前环境不太支持做这件事" }
        displayText = msg
        speechInput = "唔，主人，另一边刚回来说这件事现在没法办到：$msg"
        forcePersonaRewrite = true
      }
      "failed" -> {
        val msg = err?.text("message").orEmpty().ifBlank { "执行中途出了点小状况" }
        displayText = msg
        speechInput = "唔，主人，另一边执行失败了：$msg"
        forcePersonaRewrite = true
      }
      "expired" -> {
        displayText = "等待超时啦，另一边暂时没来得及接单。"
        speechInput = "唔，主人，刚才那件事排太久超时啦，另一台设备可能没在线哦。"
        forcePersonaRewrite = false
      }
      "unknown" -> {
        displayText = "刚才连接断了一下，我不敢乱猜有没有办完，主人点开任务确认一下最稳妥哦。"
        speechInput = "唔，主人，刚才那边中途断联了，结果还没确认，我不敢瞎重试，你点开任务看一眼吧。"
        forcePersonaRewrite = false
      }
      else -> return
    }
    voiceNotice.value = displayText.take(200)
    agent.value?.appendEvent(
      role = "event",
      text = displayText,
      meta = when (state) {
        "succeeded" -> "跨设备回执 · 已完成"
        "declined" -> "跨设备回执 · 暂不支持"
        "expired" -> "跨设备回执 · 已超时"
        "unknown" -> "跨设备回执 · 结果待确认"
        else -> "跨设备回执 · 未完成"
      },
    )
    agent.value?.state?.update { it.copy(emotion = if (state == "succeeded") "happy" else "apologetic", gesture = "wave", sequence = UUID.randomUUID().toString()) }
    val notifTitle = when (state) {
      "succeeded" -> "大肥鱼：跨设备任务办妥啦"
      "declined" -> "大肥鱼：另一边暂时办不到"
      "expired" -> "大肥鱼：任务等待超时啦"
      "unknown" -> "大肥鱼：任务结果待确认"
      else -> "大肥鱼：跨设备任务没完成"
    }
    AnyLinkCompanionService.notifyProactive(app, notifTitle, displayText, tag = "task:$id")
    speechPlayer?.enqueue(speechInput.take(3500), summarize = true, interrupt = false, forceRewrite = true)
  }

  private suspend fun syncRemoteCapabilityProfile(transport: CloudClient) {
    runCatching {
      val summary = if (allowRemoteControl.value) {
        "手机本地大肥鱼：支持跨设备远程操控手机（打开 App、看屏、点击、输入、滚动）、收发文件、查状态与语音播报"
      } else {
        "手机本地大肥鱼：支持语音陪伴、收发文件、查状态与播报提醒（主人暂已关闭远程控屏）"
      }
      transport.request("PATCH", "/edge/v1/agent/profile", jsonObject("summary" to str(summary), "file_policy" to buildFilePolicyJson()))
    }
    if (!allowRemoteControl.value) return
    // Auto-heal stale PHONE_REMOTE_SCOPE_LIMITED boundary memories recorded before bidirectional phone control was wired.
    runCatching {
      val res = transport.request("POST", "/edge/v1/memories/search", jsonObject("kind" to str("boundary"), "limit" to JsonPrimitive(50)))
      val staleRegex = Regex("PHONE_REMOTE_SCOPE_LIMITED|暂不支持远程操控其他手机|不支持远程操控手机", RegexOption.IGNORE_CASE)
      for (el in (res["items"] as? JsonArray).orEmpty()) {
        val mem = el as? JsonObject ?: continue
        val text = mem.text("title") + "\n" + mem.text("content")
        val id = mem.text("id")
        val rev = mem["revision"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: continue
        if (id.isNotBlank() && staleRegex.containsMatchIn(text)) {
          runCatching { transport.request("DELETE", "/edge/v1/memories/$id", revision = rev) }
        }
      }
    }
  }

  private suspend fun executeRemoteAgentInvoke(
    transport: CloudClient,
    taskId: String,
    leaseToken: String,
    instruction: String,
    sourceName: String,
  ): JsonObject {
    if (!allowRemoteControl.value) {
      val msg = "手机端主人已关闭「允许远程操控本机」开关（可在手机 App「保活」设置中重新开启）"
      agent.value?.appendEvent(role = "event", text = "已拦截来自 $sourceName 的远程指令：$msg", meta = "远程控屏已关闭")
      throw FileDeclined("REMOTE_CONTROL_DISABLED", msg, learnBoundary = false)
    }
    val active = agent.value ?: throw LinkFailure("AGENT_UNAVAILABLE", "手机大肥鱼尚未初始化")
    val outcome = active.runRemoteTask(taskId, instruction, sourceName) { step, msg ->
      runCatching {
        val body = buildJsonObject {
          put("stage", str("running"))
          put("message", str(msg))
          put("step", JsonPrimitive(step))
          if (leaseToken.isNotBlank()) put("lease_token", str(leaseToken))
        }
        transport.request("POST", "/edge/v1/tasks/$taskId/progress", body)
      }
    }
    return when (outcome) {
      is RemoteTaskOutcome.Succeeded -> {
        voiceNotice.value = outcome.reply.take(160)
        AnyLinkCompanionService.notifyProactive(app, "大肥鱼已替 $sourceName 办妥啦", outcome.reply, tag = "remote:$taskId")
        speechPlayer?.enqueue("刚刚替${sourceName}在手机上办完了一件事：${outcome.reply}".take(3500), summarize = true, interrupt = false, forceRewrite = true)
        jsonObject(
          "state" to str("succeeded"),
          "output" to jsonObject(
            "reply" to str(outcome.reply),
            "steps" to JsonPrimitive(outcome.steps),
          ),
        )
      }
      is RemoteTaskOutcome.Declined -> {
        voiceNotice.value = outcome.message.take(160)
        AnyLinkCompanionService.notifyProactive(app, "大肥鱼暂未执行来自 $sourceName 的指令", outcome.message, tag = "remote:$taskId")
        throw FileDeclined(outcome.code, outcome.message, learnBoundary = outcome.learnBoundary)
      }
      is RemoteTaskOutcome.Failed -> {
        throw LinkFailure(outcome.code, outcome.message, outcome.unknown)
      }
    }
  }

  private suspend fun workerLoop(transport: CloudClient, value: CloudConnection) {
    val ledger = SqlAgentLedger(app, value)
    scope.launch { syncRemoteCapabilityProfile(transport) }
    linkWorkerLoop(
      transport = transport,
      ledger = ledger,
      info = { infoJson(value) },
      say = { text, source -> companionSay(text, source) },
      receiveFile = { taskId, leaseToken, artifactId, input, source -> receiveDeliveredFile(transport, taskId, leaseToken, artifactId, input, source) },
      filePolicy = { buildFilePolicyJson() },
      invokeAgent = { taskId, leaseToken, instruction, source -> executeRemoteAgentInvoke(transport, taskId, leaseToken, instruction, source) },
      wakeup = workerWakeup,
      isWsOnline = { wsOnline.value },
    )
  }

  private suspend fun receiveDeliveredFile(
    transport: LinkTransport,
    taskId: String,
    leaseToken: String,
    artifactId: String,
    input: JsonObject,
    source: String,
  ): Pair<SavedFile, String> {
    val preferredName = input.text("filename").ifBlank { "attachment.bin" }
    val preferredMime = input.text("content_type")
    val expectedSha = input.text("sha256")
    val note = input.text("note")

    // 1. Check whether this phone currently accepts incoming files.
    if (!acceptsFiles.value) {
      val msg = "手机端当前已关闭接收文件功能（可在「保活」设置中重新开启）"
      agent.value?.appendEvent(role = "event", text = "已拦截来自 $source 的文件《$preferredName》：$msg", meta = "已关闭收文件")
      throw FileDeclined("TARGET_FILE_RECEIVE_DISABLED", msg, learnBoundary = false)
    }

    // 2. Inspect declared size (or query /meta) BEFORE downloading a single byte.
    val meta = if (input["size_bytes"] == null || input.text("filename").isBlank()) {
      runCatching { transport.request("GET", "/edge/v1/artifacts/${java.net.URLEncoder.encode(artifactId.trim(), "UTF-8")}/meta") }.getOrNull()
    } else null
    val displayName = input.text("filename").ifBlank { meta?.text("filename").orEmpty() }.ifBlank { "attachment.bin" }
    val expectedSize = input["size_bytes"]?.jsonPrimitive?.longOrNull
      ?: meta?.get("size_bytes")?.jsonPrimitive?.longOrNull
      ?: -1L

    val maxAllowed = maxReceiveFileBytes.value
    if (expectedSize > 0L && expectedSize > maxAllowed) {
      val msg = "文件《$displayName》（${AnyLinkFiles.formatSize(expectedSize)}）超过手机单文件接收上限 ${AnyLinkFiles.formatSize(maxAllowed)}，已拒收"
      agent.value?.appendEvent(role = "event", text = "来自 $source 的$msg", meta = "文件过大已拒收")
      AnyLinkCompanionService.notifyProactive(app, "大肥鱼已拒收超大文件", "来自 $source 的《$displayName》（${AnyLinkFiles.formatSize(expectedSize)}）超过手机上限 ${AnyLinkFiles.formatSize(maxAllowed)}", tag = "file-reject:$taskId")
      throw FileDeclined("TARGET_FILE_TOO_LARGE", msg, learnBoundary = false)
    }

    // 3. Verify free phone storage headroom before starting transfer.
    val avail = AnyLinkFiles.availableStorageBytes(app)
    if (avail >= 0L && expectedSize > 0L && expectedSize + AnyLinkFiles.STORAGE_HEADROOM_BYTES > avail) {
      val msg = "手机剩余存储空间不足（剩余 ${AnyLinkFiles.formatSize(avail)}，文件 ${AnyLinkFiles.formatSize(expectedSize)}），无法接收《$displayName》"
      agent.value?.appendEvent(role = "event", text = msg, meta = "存储空间不足")
      AnyLinkCompanionService.notifyProactive(app, "手机存储空间不足", msg, tag = "file-space:$taskId", urgent = true)
      throw LinkFailure("INSUFFICIENT_STORAGE", msg)
    }

    // 4. Large-file owner confirmation gate: ask before downloading on phone!
    val confirmThreshold = confirmFileOverBytes.value
    if (confirmThreshold > 0L && expectedSize > confirmThreshold) {
      val sizeLabel = AnyLinkFiles.formatSize(expectedSize)
      val threshLabel = AnyLinkFiles.formatSize(confirmThreshold)
      runCatching {
        val progressBody = buildJsonObject {
          put("stage", str("awaiting_local_confirmation"))
          put("message", str("文件较大（$sizeLabel），正在等待手机端主人点击确认接收…"))
          if (leaseToken.isNotBlank()) put("lease_token", str(leaseToken))
        }
        transport.request("POST", "/edge/v1/tasks/$taskId/progress", progressBody)
      }
      val prompt = "$source 想发来大文件《$displayName》（$sizeLabel），超过手机设定的 $threshLabel 确认阈值。确认下载并保存到「下载/AnyLink」吗？"
      val localKey = "local-file:$taskId"
      val deferred = CompletableDeferred<Boolean>()
      pendingLocalApprovals[taskId] = deferred
      agent.value?.appendInteraction(
        taskId = localKey,
        interactionType = "awaiting_approval",
        prompt = prompt,
        riskLevel = "medium",
        meta = "大文件接收确认 · $sizeLabel",
      )
      agent.value?.state?.update { it.copy(emotion = "curious", gesture = "point", sequence = UUID.randomUUID().toString()) }
      voiceNotice.value = "收到来自 $source 的大文件《$displayName》（$sizeLabel），等你确认接收哦～"
      AnyLinkCompanionService.notifyProactive(
        app,
        title = "大肥鱼收到大文件，等你确认接收",
        body = prompt,
        tag = "file-confirm:$taskId",
        urgent = true,
      )
      speechPlayer?.enqueue("主人！${source}想给你传一个大文件叫${displayName}，有${sizeLabel}，点开屏幕确认一下我就帮你下载哦！", summarize = false, interrupt = false, forceRewrite = false)

      val decision = try {
        withTimeoutOrNull(300_000L) { deferred.await() }
      } finally {
        pendingLocalApprovals.remove(taskId)
      }
      if (decision == null) {
        agent.value?.markInteractionResolved(localKey, "已超时未下载")
        throw FileDeclined("FILE_CONFIRM_TIMEOUT", "等待手机端确认接收大文件《$displayName》（$sizeLabel）超时，未下载", learnBoundary = false)
      }
      if (!decision) {
        throw FileDeclined("FILE_REJECTED_BY_OWNER", "主人已拒绝接收大文件《$displayName》（$sizeLabel）", learnBoundary = false)
      }
    }

    val (saved, actualSha) = transport.downloadArtifactToStorage(app, artifactId, displayName, preferredMime, expectedSha, maxAllowed)
    val text = if (note.isNotBlank()) "来自 $source 的文件《${saved.filename}》：$note" else "已收到来自 $source 的文件《${saved.filename}》"
    voiceNotice.value = "已保存文件：${saved.filename}（${saved.displayPath}）"
    agent.value?.appendFileMessage(
      role = "event",
      text = text,
      meta = "收到来自 $source 的文件",
      fileName = saved.filename,
      fileUri = saved.uri?.toString().orEmpty(),
      fileMime = saved.contentType,
      fileSize = saved.sizeBytes,
      fileLocation = saved.displayPath,
    )
    agent.value?.state?.update { it.copy(emotion = "happy", gesture = "wave", sequence = UUID.randomUUID().toString()) }
    AnyLinkCompanionService.notifyProactive(
      app,
      title = "大肥鱼收到来自 $source 的文件",
      body = "《${saved.filename}》（${AnyLinkFiles.formatSize(saved.sizeBytes)}）已保存到手机「${saved.displayPath}」",
      tag = "file:${actualSha.take(12)}",
    )
    speechPlayer?.enqueue("主人！${source}刚给你传过来一个文件叫${saved.filename}，我已经帮你存进下载里的 AnyLink 文件夹啦！", summarize = false, interrupt = false, forceRewrite = false)
    return saved to actualSha
  }

  private fun companionSay(text: String, source: String) {
    voiceNotice.value = "来自 $source：$text"
    agent.value?.appendEvent(role = "event", text = text, meta = "来自 $source")
    agent.value?.state?.update { it.copy(emotion = "happy", gesture = "wave", sequence = UUID.randomUUID().toString()) }
    AnyLinkCompanionService.notifyProactive(
      app,
      title = if (source.isNotBlank()) "大肥鱼 · 来自 $source" else "大肥鱼给你发来消息",
      body = text,
      tag = "say:${System.currentTimeMillis()}",
    )
    speechPlayer?.enqueue(text, summarize = false, interrupt = false, forceRewrite = false)
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
      if (speechReady) {
        speech?.language = Locale.SIMPLIFIED_CHINESE
        // Prefer a clear Chinese female voice when falling back to local Android TTS.
        runCatching {
          val voices = speech?.voices.orEmpty()
          val zhFemale = voices.firstOrNull { v ->
            v.locale?.language == "zh" && !v.isNetworkConnectionRequired &&
              Regex("female|xiaoxiao|xiaoyi|yue|ting|zh-cn-x-fis|zh-cn-x-zhe", RegexOption.IGNORE_CASE).containsMatchIn(v.name)
          } ?: voices.firstOrNull { v -> v.locale?.language == "zh" && !v.isNetworkConnectionRequired }
          if (zhFemale != null) speech?.voice = zhFemale
        }
        speech?.setSpeechRate(1.06f)
        speech?.setPitch(1.18f)
      }
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
    if (connection.value == null) { voiceNotice.value = "先连接服务器再和我说话哦。"; return }
    if (!micGranted()) { voiceNotice.value = "需要麦克风权限，点我打开应用授权。"; openApp(); return }
    if (!SpeechRecognizer.isRecognitionAvailable(app)) { voiceNotice.value = "系统没有语音识别服务，可以直接打字和我聊哦。"; return }
    recognizer?.destroy()
    recognizer = if (SpeechRecognizer.isOnDeviceRecognitionAvailable(app)) SpeechRecognizer.createOnDeviceSpeechRecognizer(app) else SpeechRecognizer.createSpeechRecognizer(app)
    recognizer?.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) { listening.value = true; voiceNotice.value = "我在听呢，主人请说～" }
      override fun onBeginningOfSpeech() = Unit
      override fun onRmsChanged(rmsdB: Float) = Unit
      override fun onBufferReceived(buffer: ByteArray?) = Unit
      override fun onEndOfSpeech() { listening.value = false }
      override fun onError(error: Int) { listening.value = false; voiceNotice.value = "唔，没听清（$error），再说一次或者打字也行哦。" }
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
  fun setMaxSteps(value: Int) {
    val clean = if (value <= 0) 0 else value.coerceIn(10, UNLIMITED_AGENT_STEPS_CAP)
    prefs.edit().putInt("agent_max_steps", clean).apply()
    maxSteps.value = clean
  }

  fun buildFilePolicyJson(): JsonObject = buildJsonObject {
    put("accepts_files", JsonPrimitive(acceptsFiles.value))
    put("max_file_bytes", JsonPrimitive(maxReceiveFileBytes.value))
    put("confirm_over_bytes", JsonPrimitive(confirmFileOverBytes.value))
    val avail = AnyLinkFiles.availableStorageBytes(app)
    if (avail >= 0L) put("available_bytes", JsonPrimitive(maxOf(0L, avail - AnyLinkFiles.STORAGE_HEADROOM_BYTES)))
  }

  private fun syncFilePolicyToCloud() {
    val value = connection.value ?: return
    val policy = buildFilePolicyJson()
    scope.launch {
      runCatching { CloudClient(value).request("PATCH", "/edge/v1/agent/profile", jsonObject("file_policy" to policy)) }
    }
  }

  fun setAcceptsFiles(enabled: Boolean) {
    prefs.edit().putBoolean("file_accepts", enabled).apply()
    acceptsFiles.value = enabled
    syncFilePolicyToCloud()
  }

  fun setMaxReceiveFileBytes(bytes: Long) {
    val clean = bytes.coerceIn(1024L * 1024L, AnyLinkFiles.HARD_MAX_BYTES)
    prefs.edit().putLong("file_max_receive_bytes", clean).apply()
    maxReceiveFileBytes.value = clean
    syncFilePolicyToCloud()
  }

  fun setConfirmFileOverBytes(bytes: Long) {
    val clean = if (bytes <= 0L) 0L else bytes.coerceIn(1024L * 1024L, AnyLinkFiles.HARD_MAX_BYTES)
    prefs.edit().putLong("file_confirm_over_bytes", clean).apply()
    confirmFileOverBytes.value = clean
    syncFilePolicyToCloud()
  }

  fun setAllowRemoteControl(enabled: Boolean) {
    prefs.edit().putBoolean("allow_remote_control", enabled).apply()
    allowRemoteControl.value = enabled
    val client = workerCloud ?: return
    scope.launch { syncRemoteCapabilityProfile(client) }
  }

  fun updateAvatarStatus(status: String) {
    if (status.isNotBlank()) avatarStatus.value = status
  }

  fun reloadAvatar() {
    avatarStatus.value = "正在重新加载形象…"
    avatarReloadTick.update { it + 1 }
  }
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
