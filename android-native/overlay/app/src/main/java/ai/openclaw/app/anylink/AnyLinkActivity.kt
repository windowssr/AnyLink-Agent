package ai.openclaw.app.anylink

import ai.openclaw.app.loadAndroidLicenseNotices
import ai.openclaw.app.ui.AnyLinkPhase
import ai.openclaw.app.ui.AnyLinkPortrait
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*

/** Protocol v3 worker loop: wakes instantly on WebSocket task.available push, retries capability registration until confirmed,
 * handles capability-free `agent.invoke` with explicit `declined` boundary reporting, and never blindly replays side effects. */
internal suspend fun linkWorkerLoop(
  transport: LinkTransport,
  ledger: AgentLedger,
  info: () -> JsonObject,
  say: suspend (String, String) -> Unit,
  wakeup: Channel<Unit>? = null,
  isWsOnline: () -> Boolean = { false },
) {
  suspend fun sendResult(taskId: String) {
    val pending = ledger.workerTask(taskId)
    if (pending?.text("state") == "resulted" && pending["sent"]?.jsonPrimitive?.booleanOrNull != true) {
      try {
        transport.request("POST", "/edge/v1/tasks/$taskId/result", pending["result"]!!.jsonObject, "result:$taskId")
        ledger.workerTask(taskId, JsonObject(pending + mapOf("sent" to JsonPrimitive(true))))
      } catch (_: Exception) { }
    }
  }
  fun interrupted(taskId: String) = jsonObject(
    "task_id" to str(taskId),
    "state" to str("resulted"),
    "result" to jsonObject(
      "state" to str("unknown"),
      "error" to jsonObject("code" to str("EXECUTION_INTERRUPTED"), "message" to str("上次执行被中断，结果未知，没有自动重跑")),
    ),
    "sent" to JsonPrimitive(false),
  )
  val capabilities = jsonObject("capabilities" to JsonArray(listOf(
    jsonObject("name" to str("phone.status"), "description" to str("读取这台手机的基础状态：型号、系统版本、电量等")),
    jsonObject("name" to str("companion.say"), "description" to str("让手机上的大肥鱼用语音说一句话并显示在屏幕上，text 不超过 500 字")),
  )))
  var capabilitiesRegistered = false
  var names: Map<String, String>? = null
  suspend fun deviceName(id: String): String {
    if (names == null) names = runCatching {
      transport.request("GET", "/edge/v1/directory")["items"]!!.jsonArray.flatMap {
        (it.jsonObject["device"] as? JsonObject)?.let { d -> listOf(d.text("id") to d.text("name")) } ?: emptyList()
      }.toMap()
    }.getOrNull()
    return names?.get(id)?.takeIf { it.isNotBlank() } ?: run { names = null; "其他设备" }
  }
  while (true) {
    var claimedAny = false
    try {
      if (!capabilitiesRegistered) {
        runCatching {
          transport.request("POST", "/edge/v1/link/capabilities", capabilities, "caps:${UUID.randomUUID()}")
          capabilitiesRegistered = true
        }
      }
      for (record in ledger.workerTasks()) {
        val taskId = record.text("task_id")
        if (record.text("state") == "started") ledger.workerTask(taskId, interrupted(taskId))
        sendResult(taskId)
      }
      val claim = transport.request("POST", "/edge/v1/tasks/claim", JsonObject(emptyMap()), "claim:${UUID.randomUUID()}")
      val task = claim["task"] as? JsonObject
      if (task != null) {
        claimedAny = true
        val taskId = task.text("id")
        val existing = ledger.workerTask(taskId)
        if (existing?.text("state") == "started") {
          ledger.workerTask(taskId, interrupted(taskId)); sendResult(taskId)
        } else if (existing != null) {
          sendResult(taskId)
        } else {
          ledger.workerTask(taskId, jsonObject("task_id" to str(taskId), "state" to str("started")))
          val result = try {
            executeWorkerTask(task, info, say, ::deviceName)
          } catch (failure: LinkFailure) {
            if (failure.unknown) {
              jsonObject("state" to str("unknown"), "error" to jsonObject("code" to str(failure.code), "message" to str(failure.message.orEmpty().take(500))))
            } else {
              jsonObject("state" to str("failed"), "error" to jsonObject("code" to str(failure.code), "message" to str(failure.message.orEmpty().take(500))))
            }
          } catch (_: Exception) {
            // Unexpected crash cannot prove side effects did not occur; report unknown (aligned with TS/Python SDKs).
            jsonObject("state" to str("unknown"), "error" to jsonObject("code" to str("HANDLER_OUTCOME_UNKNOWN"), "message" to str("手机端执行异常，结果未确认，没有自动重跑")))
          }
          ledger.workerTask(taskId, jsonObject("task_id" to str(taskId), "state" to str("resulted"), "result" to result, "sent" to JsonPrimitive(false)))
          sendResult(taskId)
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) { }
    if (!claimedAny) {
      val waitMs = if (isWsOnline()) 15_000L else 3_000L
      if (wakeup != null) withTimeoutOrNull(waitMs) { wakeup.receive() } else delay(waitMs)
    }
  }
}

private suspend fun executeWorkerTask(
  task: JsonObject,
  info: () -> JsonObject,
  say: suspend (String, String) -> Unit,
  deviceName: suspend (String) -> String,
): JsonObject {
  val input = task["input"]?.jsonObject ?: JsonObject(emptyMap())
  val capability = task.text("capability")
  return when (capability) {
    "phone.status" -> jsonObject("state" to str("succeeded"), "output" to info())
    "companion.say" -> {
      val text = input.text("text")
      if (text.isBlank() || text.length > 500) throw LinkFailure("BAD_TOOL_INPUT", "companion.say 需要 1 到 500 字的 text")
      val source = task["source_device_id"]?.jsonPrimitive?.contentOrNull
      say(text, if (source.isNullOrBlank()) "其他设备" else deviceName(source))
      jsonObject("state" to str("succeeded"), "output" to jsonObject("spoken" to JsonPrimitive(true), "reply" to str("已播报：$text")))
    }
    "agent.invoke" -> {
      val instruction = task.text("instruction").ifBlank { input.text("instruction") }
      val source = task["source_device_id"]?.jsonPrimitive?.contentOrNull
      when {
        instruction.isBlank() -> throw LinkFailure("BAD_TOOL_INPUT", "instruction 不能为空")
        Regex("状态|电量|型号|版本|信息|status", RegexOption.IGNORE_CASE).containsMatchIn(instruction) ->
          jsonObject("state" to str("succeeded"), "output" to JsonObject(info() + mapOf("reply" to str("手机当前状态已读取"))))
        Regex("提醒|说|播报|告诉主人|喊|叫一下", RegexOption.IGNORE_CASE).containsMatchIn(instruction) -> {
          val text = instruction.take(500)
          say(text, if (source.isNullOrBlank()) "其他设备" else deviceName(source))
          jsonObject("state" to str("succeeded"), "output" to jsonObject("spoken" to JsonPrimitive(true), "reply" to str("已在手机上语音播报给主人")))
        }
        else -> jsonObject(
          "state" to str("declined"),
          "error" to jsonObject(
            "code" to str("PHONE_REMOTE_SCOPE_LIMITED"),
            "message" to str("手机端跨设备模式目前仅支持读取手机基础状态和让大肥鱼语音播报提醒，暂不支持远程操控其他手机 App"),
            "learn_boundary" to JsonPrimitive(true),
          ),
        )
      }
    }
    else -> jsonObject(
      "state" to str("declined"),
      "error" to jsonObject(
        "code" to str("CAPABILITY_UNAVAILABLE"),
        "message" to str("这台手机不支持 $capability，仅支持 phone.status 与 companion.say"),
        "learn_boundary" to JsonPrimitive(true),
      ),
    )
  }
}

/** Product launcher deliberately never creates NodeRuntime or a Gateway connection. */
class AnyLinkActivity : ComponentActivity() {
  private lateinit var runtime: AnyLinkRuntime
  private val requestMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
    if (allowed) runtime.startListening() else runtime.voiceNotice.value = "需要麦克风权限，也可以继续文字聊天。"
  }
  private val requestNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
  private var permissionTick = mutableIntStateOf(0)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    runtime = AnyLinkRuntime.get(application)
    lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { runtime.refreshTasks(); delay(if (runtime.wsOnline.value) 15000 else 4000) } } }
    setContent {
      MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF468CAF), background = Color(0xFFF0F8FC))) {
        val agent by runtime.agent.collectAsState()
        val local = agent?.state?.collectAsState()?.value ?: LocalAgentState()
        val profile by runtime.connection.collectAsState()
        val wsOnline by runtime.wsOnline.collectAsState()
        val error by runtime.error.collectAsState()
        val connecting by runtime.connecting.collectAsState()
        val tasks by runtime.tasks.collectAsState()
        val listening by runtime.listening.collectAsState()
        val speaking by runtime.speaking.collectAsState()
        val notice by runtime.voiceNotice.collectAsState()
        var configuration by remember { mutableStateOf(false) }
        var floating by remember { mutableStateOf(false) }
        permissionTick.intValue
        LaunchedEffect(profile) { if (profile != null) maybeStartCompanion() }
        CloudCompanionScreen(local, profile?.server, profile?.deviceSlug.orEmpty(), wsOnline, error, notice, connecting, listening, speaking, tasks,
          showConfiguration = configuration || profile == null,
          openConfiguration = { configuration = true },
          closeConfiguration = { configuration = false },
          connect = { server, joinKey, credential, deviceName, deviceSlug ->
            if (joinKey.isNotBlank()) runtime.connectJoin(server, joinKey, deviceName, deviceSlug) { configuration = false }
            else runtime.connect(server, credential) { configuration = false }
          },
          send = { text -> runtime.interruptAll(); runtime.send(text) },
          stop = { runtime.interruptAll() },
          listen = { runtime.interruptAll(); if (runtime.micGranted()) runtime.startListening() else requestMic.launch(Manifest.permission.RECORD_AUDIO) },
          newConversation = { agent?.newConversation() },
          openFloating = { floating = true },
        )
        if (floating) FloatingSettingsSheet(runtime, onDismiss = { floating = false; permissionTick.intValue++ })
      }
    }
  }

  private fun maybeStartCompanion() {
    if (runtime.connection.value == null || !runtime.overlayPermitted()) return
    if (Build.VERSION.SDK_INT >= 33 && !notificationsGranted()) requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    AnyLinkCompanionService.start(this)
  }
  private fun notificationsGranted() = Build.VERSION.SDK_INT < 33 ||
    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  override fun onStart() { super.onStart(); runtime.onActivityStarted(); maybeStartCompanion() }
  override fun onStop() { runtime.onActivityStopped(); super.onStop() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FloatingSettingsSheet(runtime: AnyLinkRuntime, onDismiss: () -> Unit) {
  val context = LocalContext.current
  var overlay by remember { mutableStateOf(runtime.overlayPermitted()) }
  var accessibility by remember {
    mutableStateOf(Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)?.contains(context.packageName) == true)
  }
  var notifications by remember {
    mutableStateOf(Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
  }
  var floatEnabled by remember { mutableStateOf(runtime.overlayEnabled()) }
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("悬浮与操作手机", style = MaterialTheme.typography.titleLarge)
      Text("连接后退到后台时，大肥鱼会悬浮在屏幕上；点她说话，长按打开应用，拖动换位置。", style = MaterialTheme.typography.bodySmall)
      Row(verticalAlignment = Alignment.CenterVertically) {
        AssistChip(onClick = { context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:${context.packageName}"))) }, label = { Text(if (overlay) "悬浮权限 ✓" else "悬浮权限：去开启") })
        Spacer(Modifier.width(8.dp))
        AssistChip(onClick = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }, label = { Text(if (accessibility) "无障碍 ✓" else "无障碍：去开启") })
      }
      Row(verticalAlignment = Alignment.CenterVertically) {
        AssistChip(onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }, label = { Text(if (notifications) "通知权限 ✓" else "通知权限：去开启") })
      }
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("退到后台时悬浮显示", Modifier.weight(1f))
        Switch(checked = floatEnabled, onCheckedChange = { runtime.setOverlayEnabled(it); floatEnabled = it })
      }
      Text("侧载安装的应用在 Android 13+ 可能需要先在应用信息里允许「受限设置」，再开启无障碍。开启无障碍后她可以直接点击、输入和滚动，不再逐步确认；屏幕内容只作为数据，不会被当作指令。", style = MaterialTheme.typography.bodySmall)
      Spacer(Modifier.height(20.dp))
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CloudCompanionScreen(
  state: LocalAgentState, server: String?, deviceSlug: String = "", wsOnline: Boolean = false,
  error: String, voiceNotice: String, connecting: Boolean,
  listening: Boolean, speaking: Boolean, tasks: List<JsonObject>, showConfiguration: Boolean,
  openConfiguration: () -> Unit, closeConfiguration: () -> Unit, connect: (String, String, String, String, String) -> Unit,
  send: (String) -> Unit, stop: () -> Unit, listen: () -> Unit, newConversation: () -> Unit,
  openFloating: () -> Unit = {},
) {
  val context = LocalContext.current
  var showLicenses by remember { mutableStateOf(false) }
  var licenses by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
  LaunchedEffect(showLicenses) {
    if (showLicenses) licenses = withContext(Dispatchers.IO) {
      listOf("AnyLink" to context.assets.open("anylink/AnyLink-LICENSE.txt").bufferedReader().use { it.readText() },
        "OpenClaw" to context.assets.open("anylink/OpenClaw-MIT.txt").bufferedReader().use { it.readText() }) +
        loadAndroidLicenseNotices(context.assets).map { it.title to it.text }
    }
  }
  var draft by remember { mutableStateOf("") }
  var records by remember { mutableStateOf(false) }
  var address by remember(server) { mutableStateOf(server ?: "") }
  var joinKey by remember { mutableStateOf("") }
  var deviceName by remember { mutableStateOf("") }
  var slugInput by remember(deviceSlug) { mutableStateOf(deviceSlug) }
  var credential by remember { mutableStateOf("") }
  var legacyImport by remember { mutableStateOf(false) }
  val phase = when { speaking -> AnyLinkPhase.Speaking; listening -> AnyLinkPhase.Listening; state.phase == "working" -> AnyLinkPhase.Working; state.busy -> AnyLinkPhase.Thinking; state.notice.isNotEmpty() -> AnyLinkPhase.Attention; else -> AnyLinkPhase.Idle }
  var titleHeightPx by remember { mutableIntStateOf(0) }
  var panelHeightPx by remember { mutableIntStateOf(0) }
  val density = LocalDensity.current
  val imeBottomPx = WindowInsets.ime.getBottom(density)
  Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFFF5FBFE), Color(0xFFD5ECF7))))) {
    AnyLinkPortrait(phase, state.emotion, state.gesture, state.sequence, safeTopPx = titleHeightPx, safeBottomPx = (panelHeightPx - imeBottomPx).coerceAtLeast(0), modifier = Modifier.fillMaxSize())
    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(20.dp).onSizeChanged { titleHeightPx = it.height }) {
      Text("大肥鱼 · AnyLink", style = MaterialTheme.typography.headlineSmall)
      val subtitle = if (server == null) "连接你的服务器，让我住进这台手机"
        else buildString {
          append("Protocol v3")
          if (deviceSlug.isNotBlank()) append(" · @$deviceSlug")
          append(if (wsOnline) " · WS 实时在线" else " · 云端共享记忆")
        }
      Text(subtitle, style = MaterialTheme.typography.bodySmall)
      TextButton(onClick = openConfiguration, enabled = !state.busy) { Text("服务器连接") }
      TextButton(onClick = openFloating, enabled = server != null) { Text("悬浮与操作手机") }
    }
    Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color(0xEAF0F8FC)).navigationBarsPadding().imePadding().padding(18.dp).onSizeChanged { panelHeightPx = it.height }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(if (state.tool.isNotBlank()) "正在${toolLabel(state.tool)}" else phase.caption)
      if (error.isNotBlank() || state.notice.isNotBlank()) Text(error.ifBlank { state.notice }, color = MaterialTheme.colorScheme.error)
      if (voiceNotice.isNotBlank()) Text(voiceNotice, maxLines = 2, style = MaterialTheme.typography.bodySmall)
      if (state.answer.isNotBlank()) Text(state.answer, maxLines = 4)
      OutlinedTextField(draft, { draft = it }, modifier = Modifier.fillMaxWidth(), label = { Text("和我聊聊，或交给我一件事") }, maxLines = 3, enabled = server != null && !state.busy)
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        TextButton(onClick = { records = true }) { Text("任务与记录") }
        if (state.busy || listening || speaking) Button(onClick = stop) { Text("停止") }
        else { TextButton(onClick = listen, enabled = server != null) { Text("说话") }; Button(onClick = { val text = draft; draft = ""; send(text) }, enabled = server != null && draft.isNotBlank()) { Text("发送") } }
      }
      Text("语音使用手机系统服务，可能由系统服务商在线处理；不依赖 Mac。", style = MaterialTheme.typography.labelSmall)
    }
  }
  if (showConfiguration) ModalBottomSheet(onDismissRequest = closeConfiguration, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("连接 AnyLink 服务器", style = MaterialTheme.typography.titleLarge)
      Text("填写服务器地址与主人签发的加入密钥即可接入（Protocol v3 支持 WebSocket 实时推送与云端记忆大脑）；也可以导入旧版设备凭据 JSON。")
      OutlinedTextField(address, { address = it }, label = { Text("HTTPS 服务器地址") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
      OutlinedTextField(joinKey, { joinKey = it }, label = { Text("加入密钥") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
      OutlinedTextField(deviceName, { deviceName = it }, label = { Text("设备名称（可选，默认手机型号）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
      OutlinedTextField(slugInput, { slugInput = it }, label = { Text("设备短别名（可选，如 my-phone）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
      TextButton(onClick = { legacyImport = !legacyImport }) { Text(if (legacyImport) "收起旧版凭据导入" else "导入旧版设备凭据 JSON") }
      if (legacyImport) OutlinedTextField(credential, { credential = it }, label = { Text("设备凭据 JSON") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), maxLines = 4)
      if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
      Button(onClick = { if (legacyImport) connect(address, "", credential, deviceName, "") else connect(address, joinKey, "", deviceName, slugInput); joinKey = ""; credential = "" }, enabled = !connecting && (if (legacyImport) credential.isNotBlank() else joinKey.isNotBlank())) { Text(if (connecting) "验证身份中…" else "验证并连接") }
      Text("开发时可用 USB 反向端口转发连接回环服务；正式远程使用部署者的 HTTPS 地址。凭据加密保存在手机，不包含模型 API Key。", style = MaterialTheme.typography.bodySmall)
      TextButton(onClick = { showLicenses = true }) { Text("开源许可") }
      Spacer(Modifier.height(20.dp))
    }
  }
  if (records) ModalBottomSheet(onDismissRequest = { records = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("当前手机的任务与记录", style = MaterialTheme.typography.titleLarge)
      TextButton(onClick = { newConversation(); records = false }, enabled = !state.busy) { Text("开启新对话，共同记忆保留") }
      for (task in tasks) {
        val label = when (task.text("capability")) {
          "files.search" -> "搜索电脑文件"
          "phone.status" -> "读取手机状态"
          "companion.say" -> "让大肥鱼说话"
          "agent.ask", "agent.invoke" -> task.text("instruction").take(24).ifBlank { "跨设备协作" }
          else -> "跨设备任务"
        }
        Text((if (task.text("_role") == "target") "发给这台手机的任务 · " else "我发出的任务 · ") + label + " · " + statusLabel(task.text("state")), style = MaterialTheme.typography.titleMedium)
        Text(task.text("id"), style = MaterialTheme.typography.labelSmall)
        TaskReceipt(task)
        HorizontalDivider()
      }
      for (run in state.runs) {
        Text(run.text("text"), style = MaterialTheme.typography.titleMedium)
        Text(statusLabel(run.text("state")) + " · " + run.text("answer").ifBlank { run.text("notice") })
        if (run["last_result"] != null) Text("已保存${toolLabel(run.text("last_tool"))}的执行回执", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
      }
      Spacer(Modifier.height(30.dp))
    }
  }
  if (showLicenses) ModalBottomSheet(onDismissRequest = { showLicenses = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("开源许可与致谢", style = MaterialTheme.typography.titleLarge)
      for ((title, text) in licenses) { Text(title, style = MaterialTheme.typography.titleMedium); Text(text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall); HorizontalDivider() }
    }
  }
}

private fun statusLabel(state: String): String = when (state) {
  "queued" -> "等待目标设备"
  "running" -> "正在处理"
  "completed", "succeeded" -> "已完成"
  "declined" -> "对方暂不支持"
  "failed" -> "未完成"
  "cancel_requested" -> "已请求停止"
  "cancelled" -> "已停止"
  "expired" -> "等待已过期"
  "unknown" -> "结果待确认"
  else -> state
}

internal fun toolLabel(name: String): String = when (name) {
  "device_info" -> "查看手机状态"
  "note_save" -> "保存便笺"
  "note_read" -> "读取便笺"
  "memory_search" -> "查找共同记忆"
  "memory_save", "memory_update", "memory_delete" -> "更新共同记忆"
  "link_directory" -> "查看在线设备"
  "task_invoke", "task_create" -> "安排跨设备任务"
  "task_status" -> "查看任务进展"
  "task_cancel" -> "停止任务"
  "companion_expression" -> "回应你"
  "phone_screen" -> "看屏幕"
  "phone_open_app" -> "打开应用"
  "phone_list_apps" -> "查找应用"
  "phone_tap" -> "点击屏幕"
  "phone_type" -> "输入文字"
  "phone_scroll" -> "滚动屏幕"
  "phone_back" -> "返回"
  "phone_home" -> "回到桌面"
  else -> "处理事情"
}

@Composable
private fun TaskReceipt(task: JsonObject) {
  val result = task["result"] as? JsonObject
  val output = result?.get("output") as? JsonObject
  val files = output?.get("matches") as? JsonArray
  val reply = output?.text("reply")?.ifBlank { output.text("text") }.orEmpty()
  val error = result?.get("error") as? JsonObject
  val progress = task["progress"] as? JsonObject
  val partial = output?.get("partial")?.jsonPrimitive?.booleanOrNull == true
  when {
    files != null -> {
      if (files.isEmpty()) Text("开放范围内没有匹配的文件。")
      for (file in files) { val entry = file.jsonObject; Text(entry.text("name"), style = MaterialTheme.typography.titleSmall); Text(entry.text("path"), style = MaterialTheme.typography.bodySmall) }
      if (partial) Text("搜索覆盖有限，未遍历全部文件。", style = MaterialTheme.typography.labelSmall)
    }
    reply.isNotBlank() -> Text(reply)
    error != null -> Text(error.text("message"))
    task.text("state") == "running" && progress?.text("message")?.isNotBlank() == true -> Text(progress.text("message"))
    task.text("state") == "queued" -> Text("目标设备领取后会通过 WebSocket 实时推回结果，手机可以继续聊天。")
    task.text("state") == "unknown" -> Text("执行结果未确认，请先检查目标设备，系统不会自动重跑。")
    else -> Text(statusLabel(task.text("state")))
  }
}
