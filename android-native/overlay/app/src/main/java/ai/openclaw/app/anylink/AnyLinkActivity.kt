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
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

/** Foreground claim loop. Journals `started` before executing; a started entry without a result reports unknown instead of re-executing; results re-send with the stable `result:<taskId>` key. */
internal suspend fun linkWorkerLoop(transport: LinkTransport, ledger: AgentLedger, info: () -> JsonObject, say: suspend (String, String) -> Unit) {
  suspend fun sendResult(taskId: String) {
    val pending = ledger.workerTask(taskId)
    if (pending?.text("state") == "resulted" && pending["sent"]?.jsonPrimitive?.booleanOrNull != true) {
      try { transport.request("POST", "/edge/v1/link/tasks/$taskId/result", pending["result"]!!.jsonObject, "result:$taskId"); ledger.workerTask(taskId, JsonObject(pending + mapOf("sent" to JsonPrimitive(true)))) } catch (_: Exception) { }
    }
  }
  fun interrupted(taskId: String) = jsonObject("task_id" to str(taskId), "state" to str("resulted"), "result" to jsonObject("state" to str("unknown"), "error" to jsonObject("code" to str("EXECUTION_INTERRUPTED"), "message" to str("上次执行被中断，结果未知，没有自动重跑"))), "sent" to JsonPrimitive(false))
  val capabilities = jsonObject("capabilities" to JsonArray(listOf(
    jsonObject("name" to str("phone.status"), "description" to str("读取这台手机的基础状态：型号、系统版本、电量等")),
    jsonObject("name" to str("companion.say"), "description" to str("让手机上的大肥鱼用语音说一句话并显示在屏幕上，text 不超过 500 字")))))
  try { transport.request("POST", "/edge/v1/link/capabilities", capabilities, "caps:${UUID.randomUUID()}") } catch (_: Exception) { }
  var names: Map<String, String>? = null
  suspend fun deviceName(id: String): String {
    if (names == null) names = runCatching {
      transport.request("GET", "/edge/v1/link/directory")["items"]!!.jsonArray.flatMap { (it.jsonObject["device"] as? JsonObject)?.let { d -> listOf(d.text("id") to d.text("name")) } ?: emptyList() }.toMap()
    }.getOrNull()
    return names?.get(id)?.takeIf { it.isNotBlank() } ?: run { names = null; "其他设备" }
  }
  while (true) {
    try {
      // Resend journaled results whose POST never confirmed; stable key makes replay safe.
      for (record in ledger.workerTasks()) {
        val taskId = record.text("task_id")
        if (record.text("state") == "started") ledger.workerTask(taskId, interrupted(taskId))
        sendResult(taskId)
      }
      val claim = transport.request("POST", "/edge/v1/link/tasks/claim", JsonObject(emptyMap()), "claim:${UUID.randomUUID()}")
      val task = claim["task"] as? JsonObject
      if (task != null) {
        val taskId = task.text("id")
        val existing = ledger.workerTask(taskId)
        if (existing?.text("state") == "started") { ledger.workerTask(taskId, interrupted(taskId)); sendResult(taskId) }
        else if (existing != null) sendResult(taskId)
        else {
          ledger.workerTask(taskId, jsonObject("task_id" to str(taskId), "state" to str("started")))
          val result = try { executeWorkerTask(task, info, say, ::deviceName) } catch (failure: Exception) {
            jsonObject("state" to str("failed"), "error" to jsonObject("code" to str((failure as? LinkFailure)?.code ?: "EXECUTION_FAILED"), "message" to str(failure.message.orEmpty().take(500))))
          }
          ledger.workerTask(taskId, jsonObject("task_id" to str(taskId), "state" to str("resulted"), "result" to result, "sent" to JsonPrimitive(false)))
          sendResult(taskId)
        }
      }
    } catch (error: CancellationException) { throw error } catch (_: Exception) { }
    delay(3000)
  }
}
private suspend fun executeWorkerTask(task: JsonObject, info: () -> JsonObject, say: suspend (String, String) -> Unit, deviceName: suspend (String) -> String): JsonObject {
  val input = task["input"]?.jsonObject ?: JsonObject(emptyMap())
  return when (task.text("capability")) {
    "phone.status" -> jsonObject("state" to str("succeeded"), "output" to info())
    "companion.say" -> {
      val text = input.text("text")
      if (text.isBlank() || text.length > 500) throw LinkFailure("BAD_TOOL_INPUT", "companion.say 需要 1 到 500 字的 text")
      val source = task["source_device_id"]?.jsonPrimitive?.contentOrNull
      say(text, if (source.isNullOrBlank()) "其他设备" else deviceName(source))
      jsonObject("state" to str("succeeded"), "output" to jsonObject("spoken" to JsonPrimitive(true), "note" to str("已排队到手机语音播报与屏幕展示")))
    }
    else -> jsonObject("state" to str("failed"), "error" to jsonObject("code" to str("CAPABILITY_UNAVAILABLE"), "message" to str("这台手机没有能力 ${task.text("capability")}")))
  }
}

/** Product launcher deliberately never creates NodeRuntime or a Gateway connection. The
 * process-wide AnyLinkRuntime owns connection, agent, worker, speech and overlay state. */
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
    lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { runtime.refreshTasks(); delay(4000) } } }
    setContent {
      MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF468CAF), background = Color(0xFFF0F8FC))) {
        val agent by runtime.agent.collectAsState()
        val local = agent?.state?.collectAsState()?.value ?: LocalAgentState()
        val profile by runtime.connection.collectAsState()
        val error by runtime.error.collectAsState()
        val connecting by runtime.connecting.collectAsState()
        val tasks by runtime.tasks.collectAsState()
        val listening by runtime.listening.collectAsState()
        val speaking by runtime.speaking.collectAsState()
        val notice by runtime.voiceNotice.collectAsState()
        var configuration by remember { mutableStateOf(false) }
        var floating by remember { mutableStateOf(false) }
        permissionTick.intValue // recompose permission chips after returning from system settings
        LaunchedEffect(profile) { if (profile != null) maybeStartCompanion() }
        CloudCompanionScreen(local, profile?.server, error, notice, connecting, listening, speaking, tasks,
          showConfiguration = configuration || profile == null,
          openConfiguration = { configuration = true },
          closeConfiguration = { configuration = false },
          connect = { server, joinKey, credential, deviceName -> if (joinKey.isNotBlank()) runtime.connectJoin(server, joinKey, deviceName) { configuration = false } else runtime.connect(server, credential) { configuration = false } },
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

/** 「悬浮与操作手机」 settings sheet: permission chips plus the float toggle. */
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
  state: LocalAgentState, server: String?, error: String, voiceNotice: String, connecting: Boolean,
  listening: Boolean, speaking: Boolean, tasks: List<JsonObject>, showConfiguration: Boolean,
  openConfiguration: () -> Unit, closeConfiguration: () -> Unit, connect: (String, String, String, String) -> Unit,
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
      Text(if (server == null) "连接你的服务器，让我住进这台手机" else "手机本地 Agent · 统一记忆与模型", style = MaterialTheme.typography.bodySmall)
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
      Text("填写服务器地址与主人签发的加入密钥即可接入；也可以导入旧版设备凭据 JSON。本机 Agent 不依赖 Mac 或 OpenClaw Gateway。")
      OutlinedTextField(address, { address = it }, label = { Text("HTTPS 服务器地址") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
      OutlinedTextField(joinKey, { joinKey = it }, label = { Text("加入密钥") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
      OutlinedTextField(deviceName, { deviceName = it }, label = { Text("设备名称（可选，默认手机型号）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
      TextButton(onClick = { legacyImport = !legacyImport }) { Text(if (legacyImport) "收起旧版凭据导入" else "导入旧版设备凭据 JSON") }
      if (legacyImport) OutlinedTextField(credential, { credential = it }, label = { Text("设备凭据 JSON") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), maxLines = 4)
      if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
      Button(onClick = { if (legacyImport) connect(address, "", credential, deviceName) else connect(address, joinKey, "", deviceName); joinKey = ""; credential = "" }, enabled = !connecting && (if (legacyImport) credential.isNotBlank() else joinKey.isNotBlank())) { Text(if (connecting) "验证身份中…" else "验证并连接") }
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
        Text((if (task.text("_role") == "target") "发给这台手机的任务 · " else "我发出的任务 · ") + (when (task.text("capability")) { "files.search" -> "搜索电脑文件"; "phone.status" -> "读取手机状态"; "companion.say" -> "让大肥鱼说话"; else -> "跨设备任务" }) + " · " + statusLabel(task.text("state")), style = MaterialTheme.typography.titleMedium)
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
  "task_create" -> "安排跨设备任务"
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
  val error = result?.get("error") as? JsonObject
  val partial = output?.get("partial")?.jsonPrimitive?.booleanOrNull == true
  when {
    files != null -> {
      if (files.isEmpty()) Text("开放范围内没有匹配的文件。")
      for (file in files) { val entry = file.jsonObject; Text(entry.text("name"), style = MaterialTheme.typography.titleSmall); Text(entry.text("path"), style = MaterialTheme.typography.bodySmall) }
      if (partial) Text("搜索覆盖有限，未遍历全部文件。", style = MaterialTheme.typography.labelSmall)
    }
    error != null -> Text(error.text("message"))
    task.text("state") == "queued" -> Text("目标设备领取后会返回结果，手机可以继续聊天。")
    task.text("state") == "unknown" -> Text("执行结果未确认，请先检查目标设备，系统不会自动重跑。")
    else -> Text(statusLabel(task.text("state")))
  }
}
