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
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*

private val DeepInk = Color(0xFF0B2A40)
private val SeaSlate = Color(0xFF426A82)
private val SoftMist = Color(0xFF6B90A6)
private val OceanPrimary = Color(0xFF1368A0)
private val OceanBright = Color(0xFF2D95CF)
private val MintLive = Color(0xFF14B88A)
private val AmberWarn = Color(0xFFF59E0B)
private val CoralStop = Color(0xFFD94A4A)

internal val DeepSeaColorScheme = lightColorScheme(
  primary = OceanPrimary,
  onPrimary = Color.White,
  secondary = OceanBright,
  onSecondary = Color.White,
  primaryContainer = Color(0xFFD6EEF9),
  onPrimaryContainer = DeepInk,
  background = Color(0xFFEAF6FD),
  surface = Color(0xFFF6FBFE),
  onSurface = DeepInk,
  outline = Color(0xFF8CB4CC),
)

/** Explicit non-boundary or boundary decline thrown by worker file handlers (e.g. file too large or owner rejected). */
internal class FileDeclined(val code: String, message: String, val learnBoundary: Boolean = false) : Exception(message)

/** Protocol v3.2 worker loop: instant WS wakeup, periodic fencing lease heartbeats, abort on 409 LEASE_FENCED,
 * explicit `declined` boundary reporting, file_policy negotiation, and crash-safe execution journal. */
internal suspend fun linkWorkerLoop(
  transport: LinkTransport,
  ledger: AgentLedger,
  info: () -> JsonObject,
  say: suspend (String, String) -> Unit,
  receiveFile: (suspend (String, String, String, JsonObject, String) -> Pair<SavedFile, String>)? = null,
  filePolicy: (() -> JsonObject)? = null,
  invokeAgent: (suspend (String, String, String, String) -> JsonObject)? = null,
  wakeup: Channel<Unit>? = null,
  isWsOnline: () -> Boolean = { false },
) {
  suspend fun sendResult(taskId: String) {
    val pending = ledger.workerTask(taskId)
    if (pending?.text("state") == "resulted" && pending["sent"]?.jsonPrimitive?.booleanOrNull != true) {
      try {
        val rawResult = pending["result"]!!.jsonObject
        val leaseToken = pending.text("lease_token")
        val payload = if (leaseToken.isNotBlank()) JsonObject(rawResult + mapOf("lease_token" to str(leaseToken))) else rawResult
        transport.request("POST", "/edge/v1/tasks/$taskId/result", payload, "result:$taskId")
        ledger.workerTask(taskId, JsonObject(pending + mapOf("sent" to JsonPrimitive(true))))
      } catch (err: LinkFailure) {
        if (err.code in setOf("LEASE_FENCED", "TASK_TERMINAL", "TASK_NOT_ACTIVE")) {
          ledger.workerTask(taskId, JsonObject(pending + mapOf("sent" to JsonPrimitive(true))))
        }
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
    jsonObject("name" to str("agent.invoke"), "description" to str("把自然语言指令交给手机上的大肥鱼自主执行：支持通过无障碍服务打开 App、查看屏幕、点击、输入、滚动、查状态与处理本地任务")),
    jsonObject("name" to str("phone.status"), "description" to str("读取这台手机的基础状态：型号、系统版本、电量等")),
    jsonObject("name" to str("companion.say"), "description" to str("让手机上的大肥鱼用语音说一句话并显示在屏幕上，text 不超过 500 字")),
    jsonObject("name" to str("file.deliver"), "description" to str("接收其他设备通过 /edge/v1/artifacts 上传的文件（artifact_id），自动校验并保存到手机「下载/AnyLink」且弹窗提醒")),
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
          val capPayload = buildJsonObject {
            put("capabilities", capabilities["capabilities"]!!)
            filePolicy?.invoke()?.let { put("file_policy", it) }
          }
          transport.request("POST", "/edge/v1/link/capabilities", capPayload, "caps:${UUID.randomUUID()}")
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
        val leaseToken = task.text("lease_token")
        val leaseSeconds = task["lease_seconds"]?.jsonPrimitive?.intOrNull ?: 120
        val existing = ledger.workerTask(taskId)
        if (existing?.text("state") == "started") {
          ledger.workerTask(taskId, interrupted(taskId)); sendResult(taskId)
        } else if (existing != null) {
          sendResult(taskId)
        } else {
          ledger.workerTask(taskId, jsonObject("task_id" to str(taskId), "state" to str("started"), "lease_token" to str(leaseToken)))
          val result = try {
            coroutineScope {
              val hbJob = launch {
                val intervalMs = maxOf(5_000L, (leaseSeconds * 1000L) / 3L)
                while (isActive) {
                  delay(intervalMs)
                  try {
                    val hbBody = if (leaseToken.isNotBlank()) jsonObject("lease_token" to str(leaseToken)) else JsonObject(emptyMap())
                    val hb = transport.request("POST", "/edge/v1/tasks/$taskId/heartbeat", hbBody)
                    if (hb["cancel_requested"]?.jsonPrimitive?.booleanOrNull == true) break
                  } catch (e: LinkFailure) {
                    if (e.code in setOf("TASK_NOT_ACTIVE", "LEASE_FENCED")) break
                  } catch (_: Exception) { }
                }
              }
              try {
                executeWorkerTask(task, leaseToken, transport, info, say, receiveFile, invokeAgent, ::deviceName)
              } finally {
                hbJob.cancel()
              }
            }
          } catch (declined: FileDeclined) {
            jsonObject(
              "state" to str("declined"),
              "error" to jsonObject(
                "code" to str(declined.code),
                "message" to str(declined.message.orEmpty().take(500)),
                "learn_boundary" to JsonPrimitive(declined.learnBoundary),
              ),
            )
          } catch (failure: LinkFailure) {
            if (failure.unknown) {
              jsonObject("state" to str("unknown"), "error" to jsonObject("code" to str(failure.code), "message" to str(failure.message.orEmpty().take(500))))
            } else {
              jsonObject("state" to str("failed"), "error" to jsonObject("code" to str(failure.code), "message" to str(failure.message.orEmpty().take(500))))
            }
          } catch (_: Exception) {
            jsonObject("state" to str("unknown"), "error" to jsonObject("code" to str("HANDLER_OUTCOME_UNKNOWN"), "message" to str("手机端执行异常，结果未确认，没有自动重跑")))
          }
          ledger.workerTask(taskId, jsonObject("task_id" to str(taskId), "state" to str("resulted"), "lease_token" to str(leaseToken), "result" to result, "sent" to JsonPrimitive(false)))
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
  leaseToken: String,
  transport: LinkTransport,
  info: () -> JsonObject,
  say: suspend (String, String) -> Unit,
  receiveFile: (suspend (String, String, String, JsonObject, String) -> Pair<SavedFile, String>)?,
  invokeAgent: (suspend (String, String, String, String) -> JsonObject)?,
  deviceName: suspend (String) -> String,
): JsonObject {
  val taskId = task.text("id")
  val input = task["input"]?.jsonObject ?: JsonObject(emptyMap())
  val capability = task.text("capability")
  suspend fun handleArtifactDelivery(): JsonObject {
    val artifactId = input.text("artifact_id")
    if (artifactId.isBlank()) throw LinkFailure("BAD_TOOL_INPUT", "file.deliver 需要 artifact_id")
    val receiver = receiveFile ?: throw LinkFailure("FILE_RECEIVER_UNAVAILABLE", "当前环境无法保存附件")
    val source = task["source_device_id"]?.jsonPrimitive?.contentOrNull
    val sourceName = if (source.isNullOrBlank()) "其他设备" else deviceName(source)
    val (saved, actualSha) = receiver(taskId, leaseToken, artifactId, input, sourceName)
    return jsonObject(
      "state" to str("succeeded"),
      "output" to jsonObject(
        "saved_location" to str(saved.displayPath),
        "filename" to str(saved.filename),
        "content_type" to str(saved.contentType),
        "size_bytes" to JsonPrimitive(saved.sizeBytes),
        "sha256" to str(actualSha),
        "reply" to str("手机已收到并保存文件《${saved.filename}》到 ${saved.displayPath}"),
      ),
    )
  }
  return when (capability) {
    "phone.status" -> jsonObject("state" to str("succeeded"), "output" to info())
    "companion.say" -> {
      val text = input.text("text")
      if (text.isBlank() || text.length > 500) throw LinkFailure("BAD_TOOL_INPUT", "companion.say 需要 1 到 500 字的 text")
      val source = task["source_device_id"]?.jsonPrimitive?.contentOrNull
      say(text, if (source.isNullOrBlank()) "其他设备" else deviceName(source))
      jsonObject("state" to str("succeeded"), "output" to jsonObject("spoken" to JsonPrimitive(true), "reply" to str("已播报：$text")))
    }
    "file.deliver" -> handleArtifactDelivery()
    "agent.invoke", "agent.ask" -> {
      val instruction = task.text("instruction").ifBlank { input.text("instruction") }
      val source = task["source_device_id"]?.jsonPrimitive?.contentOrNull
      val sourceName = if (source.isNullOrBlank()) "其他设备" else deviceName(source)
      when {
        input.text("artifact_id").isNotBlank() && instruction.isBlank() -> handleArtifactDelivery()
        instruction.isBlank() -> throw LinkFailure("BAD_TOOL_INPUT", "instruction 不能为空")
        invokeAgent != null -> {
          val enriched = if (input.text("artifact_id").isNotBlank()) {
            "$instruction\n[附带云端附件 artifact_id=${input.text("artifact_id")}, filename=${input.text("filename")}]"
          } else instruction
          invokeAgent(taskId, leaseToken, enriched, sourceName)
        }
        Regex("状态|电量|型号|版本|信息|status", RegexOption.IGNORE_CASE).containsMatchIn(instruction) ->
          jsonObject("state" to str("succeeded"), "output" to JsonObject(info() + mapOf("reply" to str("手机当前状态已读取"))))
        else -> jsonObject(
          "state" to str("declined"),
          "error" to jsonObject(
            "code" to str("PHONE_REMOTE_SCOPE_LIMITED"),
            "message" to str("手机端跨设备 Agent 执行器未就绪，暂无法处理该远程指令"),
            "learn_boundary" to JsonPrimitive(true),
          ),
        )
      }
    }
    else -> jsonObject(
      "state" to str("declined"),
      "error" to jsonObject(
        "code" to str("CAPABILITY_UNAVAILABLE"),
        "message" to str("这台手机不支持 $capability，仅支持 agent.invoke、phone.status、companion.say 与 file.deliver"),
        "learn_boundary" to JsonPrimitive(true),
      ),
    )
  }
}

/** Product launcher deliberately never creates NodeRuntime or a Gateway connection. */
class AnyLinkActivity : ComponentActivity() {
  private lateinit var runtime: AnyLinkRuntime
  private var pendingVoiceAction: String = "listen"
  private val requestMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
    if (allowed) {
      maybeStartCompanion()
      if (pendingVoiceAction == "call") runtime.startVoiceCall() else runtime.startListening()
    } else {
      runtime.voiceNotice.value = "需要麦克风权限，也可以直接打字和我聊哦。"
    }
  }
  private val requestNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
  private val pickDocument = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (uri != null) { runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }; runtime.selectFile(uri) }
  }
  private var permissionTick = mutableIntStateOf(0)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    runtime = AnyLinkRuntime.get(application)
    lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { runtime.refreshTasks(); delay(if (runtime.wsOnline.value) 15000 else 4000) } } }
    setContent {
      MaterialTheme(colorScheme = DeepSeaColorScheme) {
        val agent by runtime.agent.collectAsState()
        val local = agent?.state?.collectAsState()?.value ?: LocalAgentState()
        val profile by runtime.connection.collectAsState()
        val wsOnline by runtime.wsOnline.collectAsState()
        val error by runtime.error.collectAsState()
        val connecting by runtime.connecting.collectAsState()
        val tasks by runtime.tasks.collectAsState()
        val listening by runtime.listening.collectAsState()
        val speaking by runtime.speaking.collectAsState()
        val speechPresentationActive by runtime.speechPresentationActive.collectAsState()
        val chatPlaybackText by runtime.chatPlaybackText.collectAsState()
        val notice by runtime.voiceNotice.collectAsState()
        val pendingFile by runtime.pendingFile.collectAsState()
        val uploadingFile by runtime.uploadingFile.collectAsState()
        val avatarReloadTick by runtime.avatarReloadTick.collectAsState()
        val voiceLevel by runtime.voiceLevel.collectAsState()
        val playbackLevel by runtime.playbackLevel.collectAsState()
        val callAudioRoute by runtime.callAudioRoute.collectAsState()
        val partialTranscript by runtime.partialTranscript.collectAsState()
        val callActive by runtime.callActive.collectAsState()
        val callAutoBargeInActive by runtime.callAutoBargeInActive.collectAsState()
        val callEchoCancellation by runtime.callEchoCancellation.collectAsState()
        val callState by runtime.callState.collectAsState()
        val callMuted by runtime.callMuted.collectAsState()
        val callSpeakerOn by runtime.callSpeakerOn.collectAsState()
        val callDurationSec by runtime.callDurationSec.collectAsState()
        val callUserCaption by runtime.callUserCaption.collectAsState()
        val callAssistantCaption by runtime.callAssistantCaption.collectAsState()
        var configuration by remember { mutableStateOf(false) }
        var floating by remember { mutableStateOf(false) }
        permissionTick.intValue
        LaunchedEffect(profile) { if (profile != null) maybeStartCompanion() }
        CloudCompanionScreen(
          state = local,
          speechPresentationActive = speechPresentationActive,
          chatPlaybackText = chatPlaybackText,
          server = profile?.server,
          deviceSlug = profile?.deviceSlug.orEmpty(),
          wsOnline = wsOnline,
          error = error,
          voiceNotice = notice,
          connecting = connecting,
          listening = listening,
          speaking = speaking,
          tasks = tasks,
          showConfiguration = configuration || profile == null,
          openConfiguration = { configuration = true },
          closeConfiguration = { configuration = false },
          connect = { server, joinKey, credential, deviceName, deviceSlug ->
            if (joinKey.isNotBlank()) runtime.connectJoin(server, joinKey, deviceName, deviceSlug) { configuration = false }
            else runtime.connect(server, credential) { configuration = false }
          },
          send = { text -> runtime.interruptAll(); runtime.sendWithOptionalFile(text) },
          stop = { runtime.interruptAll() },
          listen = {
            if (listening) {
              runtime.finishListeningNow()
            } else {
              pendingVoiceAction = "listen"
              if (runtime.micGranted()) runtime.startListening() else requestMic.launch(Manifest.permission.RECORD_AUDIO)
            }
          },
          newConversation = { agent?.newConversation() },
          openFloating = { floating = true },
          replyTask = { taskId, approved, choice, msg -> runtime.replyToTask(taskId, approved, choice, msg) },
          pendingFile = pendingFile,
          uploadingFile = uploadingFile,
          pickFile = { runCatching { pickDocument.launch(arrayOf("*/*")) } },
          clearPendingFile = { runtime.clearPendingFile() },
          avatarReloadTrigger = avatarReloadTick,
          onAvatarStatus = { runtime.updateAvatarStatus(it) },
          voiceLevel = voiceLevel,
          playbackLevel = playbackLevel,
          callAudioRoute = callAudioRoute,
          partialTranscript = partialTranscript,
          finishListening = { runtime.finishListeningNow() },
          cancelListening = { runtime.cancelListening() },
          callActive = callActive,
          autoBargeIn = callAutoBargeInActive && (!callSpeakerOn || callEchoCancellation),
          callState = callState,
          callMuted = callMuted,
          callSpeakerOn = callSpeakerOn,
          callDurationSec = callDurationSec,
          callUserCaption = callUserCaption,
          callAssistantCaption = callAssistantCaption,
          startCall = {
            pendingVoiceAction = "call"
            if (runtime.micGranted()) runtime.startVoiceCall() else requestMic.launch(Manifest.permission.RECORD_AUDIO)
          },
          endCall = { runtime.endVoiceCall() },
          toggleCallMute = { runtime.toggleCallMute() },
          toggleCallSpeaker = { runtime.toggleCallSpeaker() },
          bargeInCall = { runtime.bargeInCall() },
        )
        if (floating) FloatingSettingsSheet(runtime, onDismiss = { floating = false; permissionTick.intValue++ })
      }
    }
  }

  private fun maybeStartCompanion() {
    if (runtime.connection.value == null) return
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
  val overlayOpacity by runtime.overlayOpacity.collectAsState()
  val maxSteps by runtime.maxSteps.collectAsState()
  val acceptsFiles by runtime.acceptsFiles.collectAsState()
  val maxReceiveBytes by runtime.maxReceiveFileBytes.collectAsState()
  val confirmOverBytes by runtime.confirmFileOverBytes.collectAsState()
  val allowRemoteControl by runtime.allowRemoteControl.collectAsState()
  val avatarStatus by runtime.avatarStatus.collectAsState()
  val voiceEngineMode by runtime.voiceEngineMode.collectAsState()
  val cloudAsrEnabled by runtime.cloudAsrEnabled.collectAsState()
  val speechVoiceStatus by runtime.speechVoiceStatus.collectAsState()
  val speechDiagnostic by runtime.speechDiagnostic.collectAsState()
  val speechBusy by runtime.speechPreviewActive.collectAsState()
  val inVoiceCall by runtime.callActive.collectAsState()
  val offlineModel by runtime.offlineModelState.collectAsState()
  val autoBargeIn by runtime.autoBargeInEnabled.collectAsState()
  val callVadState by runtime.callVadState.collectAsState()
  val callBargeInStatus by runtime.callBargeInStatus.collectAsState()
  val systemVoiceService by runtime.systemVoiceService.collectAsState()
  val systemVoiceOptions by runtime.systemVoiceOptions.collectAsState()
  val systemVoiceDiagnostic by runtime.systemVoiceDiagnostic.collectAsState()
  val systemVoiceStatus by runtime.systemVoiceStatus.collectAsState()
  val voiceCaptureActive by runtime.voiceCaptureActive.collectAsState()
  val systemVoiceTestActive by runtime.systemVoiceTestActive.collectAsState()
  val systemVoiceTestResult by runtime.systemVoiceTestResult.collectAsState()
  val voiceTestMode by runtime.systemVoiceTestMode.collectAsState()
  var requestedTestMode by remember { mutableStateOf(VoiceRecognizerController.MODE_SYSTEM) }
  val testMicrophone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) runtime.testSystemVoice(requestedTestMode) else runtime.systemVoiceTestResult.value = "未获得麦克风权限，测试未开始。"
  }
  LaunchedEffect(Unit) { runtime.refreshSystemVoiceServices() }
  DisposableEffect(runtime) { onDispose { runtime.cancelSystemVoiceTest() } }
  val freeBytes = remember { AnyLinkFiles.availableStorageBytes(context) }
  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Color(0xFFF6FBFE), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("后台保活、悬浮窗与控屏", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DeepInk)
      Text("连接服务器后，退到后台会自动通过常驻前台服务维持 Protocol v3.2 WebSocket 长连接；开启悬浮权限后还会在桌面显示轻量化大肥鱼悬浮球（点按说话、长按返回、拖动换位）。", style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = { context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:${context.packageName}"))) }, label = { Text(if (overlay) "悬浮权限已开启" else "悬浮权限：去开启") })
        AssistChip(onClick = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }, label = { Text(if (accessibility) "无障碍已开启" else "无障碍：去开启") })
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }, label = { Text(if (notifications) "通知权限已开启" else "通知权限：去开启") })
        AssistChip(onClick = { runCatching { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } }, label = { Text("电池优化：设为无限制") })
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(
          onClick = {
            val ok = AnyLinkCompanionService.notifyProactive(context, "大肥鱼给你发来消息", "主人！通知弹窗正常生效啦，以后跨设备办完事或主动找你都会这样提醒你哦～", tag = "test-notify")
            runtime.voiceNotice.value = if (ok) "已发送测试弹窗通知，请查看顶部横幅。" else "还没有通知权限哦，请先点上方「通知权限」开启。"
          },
          label = { Text("测试弹窗通知") },
        )
      }
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("退到后台时显示悬浮球", Modifier.weight(1f), color = DeepInk)
        Switch(checked = floatEnabled, onCheckedChange = { runtime.setOverlayEnabled(it); floatEnabled = it })
      }
      OverlayTransparencyControl(overlayOpacity, runtime::setOverlayOpacity)
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text("允许 Mac 等设备远程操控本机", color = DeepInk)
          Text("开启后，Mac 下发的指令会交给手机大肥鱼实际执行（需同时开启无障碍权限）", style = MaterialTheme.typography.labelSmall, color = SoftMist)
        }
        Switch(checked = allowRemoteControl, onCheckedChange = { runtime.setAllowRemoteControl(it) })
      }
      HorizontalDivider(color = Color(0xFFDCEEF8))
      Text("大肥鱼形象引擎状态", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = DeepInk)
      val webViewVersion = remember {
        runCatching { android.webkit.WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull() ?: "不可用"
      }
      Text(
        "安装包模式：${if (runtime.privateCharacterMode) "私有 Live2D 版（含大肥鱼模型）" else "开源占位版（不含私有 Live2D 模型）"}\n当前状态：$avatarStatus\n系统 WebView：$webViewVersion",
        style = MaterialTheme.typography.bodySmall,
        color = SeaSlate,
      )
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = { runtime.reloadAvatar() }, label = { Text("重新加载大肥鱼") })
      }
      HorizontalDivider(color = Color(0xFFDCEEF8))
      Text("大肥鱼的声音", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = DeepInk)
      Text(speechVoiceStatus, style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      Text("优先使用阿里云 Momo，无法合成时切回原来的微软语音，再由手机系统语音兜底。", style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      AssistChip(enabled = !inVoiceCall, onClick = { if (speechBusy) runtime.stopSpeechPreview() else runtime.testSpeechVoice() }, label = { Text(if (speechBusy) "停止试听" else "试听当前声音") })
      HorizontalDivider(color = Color(0xFFDCEEF8))
      AssistChip(onClick = {
        val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("播报诊断", speechDiagnostic.ifBlank { "暂无播报记录" }))
      }, label = { Text("复制播报诊断") })
      Text("诊断只记录播报来源、实际声音、耗时及降级原因，不含正文或密钥。", style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      Text("语音输入与实时通话识别引擎", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = DeepInk)
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Switch(checked = autoBargeIn, enabled = !inVoiceCall, onCheckedChange = { runtime.setAutoBargeIn(it) })
        Text("通话中语音自动打断", style = MaterialTheme.typography.bodyMedium, color = DeepInk)
      }
      Text("$callVadState\n$callBargeInStatus", style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      Text("需要本地识别模型。只在通话中收音，静音或挂断即停止；外放时会过滤自身播报，旁人的说话声仍可能触发。", style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      if (autoBargeIn) AssistChip(enabled = !inVoiceCall, onClick = { runtime.prepareCallVad() }, label = { Text("准备自动打断模型") })
      LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val voiceModes = listOf(
          VoiceRecognizerController.MODE_AUTO to "自动（推荐）",
          VoiceRecognizerController.MODE_OFFLINE to "本地离线识别",
          VoiceRecognizerController.MODE_SYSTEM to "系统识别",
          VoiceRecognizerController.MODE_CLOUD to "云端识别",
        )
        items(voiceModes) { (mode, label) ->
          FilterChip(
            selected = voiceEngineMode == mode,
            enabled = mode != VoiceRecognizerController.MODE_CLOUD || cloudAsrEnabled,
            onClick = { runtime.setVoiceEngineMode(mode) },
            label = { Text(label, fontSize = 12.sp) },
          )
        }
      }
      Text(
        if (cloudAsrEnabled) "云端语音识别已配置，可用于语音输入和通话。"
        else "自动模式优先使用已下载的本地模型；没有模型时尝试系统识别。当前未启用云端识别。",
        style = MaterialTheme.typography.bodySmall,
        color = SoftMist,
      )
      Text("本地离线语音识别", style = MaterialTheme.typography.titleSmall, color = DeepInk)
      Text(
        when {
          offlineModel.ready -> "中文模型已就绪 · 语音输入和通话均可使用"
          offlineModel.downloading -> "正在下载识别模型：${offlineModel.receivedBytes / 1048576} / ${offlineModel.totalBytes / 1048576} MB"
          else -> "首次下载约 ${offlineModel.totalBytes / 1048576} MB，支持中文和英语，之后在手机本地转文字，无需云端密钥。识别后的文字会按现有聊天流程发送。"
        }, style = MaterialTheme.typography.bodySmall, color = SeaSlate,
      )
      if (offlineModel.downloading) LinearProgressIndicator(progress = { (offlineModel.receivedBytes.toFloat() / offlineModel.totalBytes.coerceAtLeast(1)).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
      if (offlineModel.error.isNotBlank()) Text(offlineModel.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!offlineModel.ready) AssistChip(onClick = {
          if (offlineModel.downloading) runtime.cancelOfflineModelDownload() else runtime.downloadOfflineModel()
        }, label = { Text(if (offlineModel.downloading) "取消下载" else "下载中文模型") })
        if (offlineModel.ready) AssistChip(onClick = {
          if (systemVoiceTestActive) runtime.cancelSystemVoiceTest()
          else if (runtime.micGranted()) runtime.testSystemVoice(VoiceRecognizerController.MODE_OFFLINE)
          else { requestedTestMode = VoiceRecognizerController.MODE_OFFLINE; testMicrophone.launch(Manifest.permission.RECORD_AUDIO) }
        }, label = { Text(if (systemVoiceTestActive && voiceTestMode == VoiceRecognizerController.MODE_OFFLINE) "停止测试" else "测试本地识别") })
      }
      if (voiceTestMode == VoiceRecognizerController.MODE_OFFLINE && systemVoiceTestResult.isNotBlank()) Text(systemVoiceTestResult, style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      Text("系统识别服务", style = MaterialTheme.typography.titleSmall, color = DeepInk)
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        systemVoiceOptions.forEach { service ->
          FilterChip(
            selected = systemVoiceService == service.id,
            onClick = { runtime.setSystemVoiceService(service.id) },
            label = { Text(service.label) },
          )
        }
      }
      val captureStatus = if (voiceCaptureActive) "进行中" else "未运行"
      Text("语音识别诊断\n$systemVoiceDiagnostic\n识别会话：$captureStatus\n最近状态：$systemVoiceStatus", style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      AssistChip(onClick = {
        if (systemVoiceTestActive) runtime.cancelSystemVoiceTest()
        else if (runtime.micGranted()) runtime.testSystemVoice()
        else { requestedTestMode = VoiceRecognizerController.MODE_SYSTEM; testMicrophone.launch(Manifest.permission.RECORD_AUDIO) }
      }, label = { Text(if (systemVoiceTestActive) "停止测试" else "测试系统识别") })
      if (voiceTestMode == VoiceRecognizerController.MODE_SYSTEM) Text(systemVoiceTestResult.ifBlank { "可先说一句「你好，大肥鱼」测试；测试结果只显示在这里，不会发送聊天消息。" }, style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = { runtime.refreshSystemVoiceServices() }, label = { Text("重新检测") })
        AssistChip(onClick = {
          val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
          clipboard.setPrimaryClip(android.content.ClipData.newPlainText("语音识别诊断", "$systemVoiceDiagnostic\n识别会话：$captureStatus\n最近状态：$systemVoiceStatus\n所选服务：$systemVoiceService"))
        }, label = { Text("复制诊断") })
      }
      AssistChip(onClick = {
        val opened = listOf(Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_INPUT_METHOD_SETTINGS).any { action ->
          runCatching { context.startActivity(Intent(action)); true }.getOrDefault(false)
        }
        if (!opened) runtime.voiceNotice.value = "当前系统没有提供此设置入口，可到系统设置中查找语音输入。"
      }, label = { Text("系统语音设置") })
      HorizontalDivider(color = Color(0xFFDCEEF8))
      Text("手机 Agent 单轮执行步数上限", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = DeepInk)
      LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val options = listOf(50 to "50 步", 100 to "100 步（默认）", 200 to "200 步", 0 to "不限")
        items(options) { (value, label) ->
          FilterChip(
            selected = maxSteps == value,
            onClick = { runtime.setMaxSteps(value) },
            label = { Text(label, fontSize = 12.sp) },
          )
        }
      }
      Text("控屏多步任务会自动裁剪旧屏幕，避免上下文爆掉；选「不限」时放开至 500 步防死循环兜底，且随时可点「停止」。", style = MaterialTheme.typography.bodySmall, color = SoftMist)
      HorizontalDivider(color = Color(0xFFDCEEF8))
      Text("跨设备接收文件策略（Protocol v3.2 协商）", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = DeepInk)
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("允许接收其他设备发来的文件", Modifier.weight(1f), color = DeepInk)
        Switch(checked = acceptsFiles, onCheckedChange = { runtime.setAcceptsFiles(it) })
      }
      if (acceptsFiles) {
        Text("单文件最大接收上限", style = MaterialTheme.typography.labelMedium, color = SeaSlate)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          val maxOptions = listOf(
            50L * 1024L * 1024L to "50 MB",
            200L * 1024L * 1024L to "200 MB（默认）",
            500L * 1024L * 1024L to "500 MB",
            1024L * 1024L * 1024L to "1 GB",
          )
          items(maxOptions) { (bytes, label) ->
            FilterChip(selected = maxReceiveBytes == bytes, onClick = { runtime.setMaxReceiveFileBytes(bytes) }, label = { Text(label, fontSize = 12.sp) })
          }
        }
        Text("大文件下载前弹窗确认阈值", style = MaterialTheme.typography.labelMedium, color = SeaSlate)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          val confirmOptions = listOf(
            0L to "不弹窗",
            20L * 1024L * 1024L to "20 MB",
            50L * 1024L * 1024L to "50 MB（默认）",
            100L * 1024L * 1024L to "100 MB",
          )
          items(confirmOptions) { (bytes, label) ->
            FilterChip(selected = confirmOverBytes == bytes, onClick = { runtime.setConfirmFileOverBytes(bytes) }, label = { Text(label, fontSize = 12.sp) })
          }
        }
        if (freeBytes >= 0L) {
          Text("手机当前可用存储空间：${AnyLinkFiles.formatSize(freeBytes)}；策略会自动同步到云端，对方发送前即会校验，避免白白上传。", style = MaterialTheme.typography.bodySmall, color = SoftMist)
        }
      } else {
        Text("关闭后，其他设备尝试向本机发文件时会在上传前即收到明确提示并拦截。", style = MaterialTheme.typography.bodySmall, color = SoftMist)
      }
      Text("提示：大肥鱼主动消息会通过高优先级渠道「大肥鱼主动消息」弹出顶部横幅；若国产 ROM 默认折叠横幅，请在通知设置中开启「横幅通知」，并在「电池优化」中设为「无限制」。", style = MaterialTheme.typography.bodySmall, color = SoftMist)
      Spacer(Modifier.height(16.dp))
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
  replyTask: (String, Boolean?, String?, String?) -> Unit = { _, _, _, _ -> },
  pendingFile: PickedFile? = null,
  uploadingFile: Boolean = false,
  pickFile: () -> Unit = {},
  clearPendingFile: () -> Unit = {},
  avatarReloadTrigger: Int = 0,
  onAvatarStatus: (String) -> Unit = {},
  voiceLevel: Float = 0f,
  partialTranscript: String = "",
  finishListening: () -> Unit = {},
  cancelListening: () -> Unit = {},
  callActive: Boolean = false,
  autoBargeIn: Boolean = false,
  callState: String = "idle",
  callMuted: Boolean = false,
  callSpeakerOn: Boolean = true,
  callDurationSec: Int = 0,
  callUserCaption: String = "",
  callAssistantCaption: String = "",
  startCall: () -> Unit = {},
  endCall: () -> Unit = {},
  toggleCallMute: () -> Unit = {},
  toggleCallSpeaker: () -> Unit = {},
  bargeInCall: () -> Unit = {},
  playbackLevel: Float = 0f,
  callAudioRoute: String = if (callSpeakerOn) "外放" else "听筒",
  speechPresentationActive: Boolean = false,
  chatPlaybackText: String = "",
) {
  val context = LocalContext.current
  var showLicenses by remember { mutableStateOf(false) }
  var licenses by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
  LaunchedEffect(showLicenses) {
    if (showLicenses) licenses = withContext(Dispatchers.IO) {
      listOf(
        "AnyLink" to context.assets.open("anylink/AnyLink-LICENSE.txt").bufferedReader().use { it.readText() },
        "OpenClaw" to context.assets.open("anylink/OpenClaw-MIT.txt").bufferedReader().use { it.readText() },
      ) + loadAndroidLicenseNotices(context.assets).map { it.title to it.text }
    }
  }
  var draft by remember { mutableStateOf("") }
  var records by remember { mutableStateOf(false) }
  var readingExpanded by remember { mutableStateOf(false) }
  var address by remember(server) { mutableStateOf(server ?: "") }
  var joinKey by remember { mutableStateOf("") }
  var deviceName by remember { mutableStateOf("") }
  var slugInput by remember(deviceSlug) { mutableStateOf(deviceSlug) }
  var credential by remember { mutableStateOf("") }
  var showAdvanced by remember { mutableStateOf(false) }
  var legacyImport by remember { mutableStateOf(false) }

  val phase = when {
    speaking -> AnyLinkPhase.Speaking
    listening -> AnyLinkPhase.Listening
    state.phase == "working" -> AnyLinkPhase.Working
    state.busy -> AnyLinkPhase.Thinking
    state.notice.isNotEmpty() -> AnyLinkPhase.Attention
    else -> AnyLinkPhase.Idle
  }
  val density = LocalDensity.current
  val statusTopPx = WindowInsets.statusBars.getTop(density)
  val imeVisible = WindowInsets.ime.getBottom(density) > 0
  val compactStage = readingExpanded || imeVisible
  val stageWeight by animateFloatAsState(
    targetValue = if (compactStage) 0.16f else 0.44f,
    animationSpec = tween(280, easing = FastOutSlowInEasing),
    label = "stageWeight",
  )
  var viewportHeight by remember { mutableIntStateOf(0) }
  var stageBottom by remember { mutableIntStateOf(0) }
  val listState = rememberLazyListState()
  LaunchedEffect(state.chat.size, state.answer.length) {
    if (state.chat.isNotEmpty()) listState.animateScrollToItem(state.chat.lastIndex)
  }

  val pulse = rememberInfiniteTransition(label = "voicePulse")
  val orbGlow by pulse.animateFloat(
    initialValue = 0.25f,
    targetValue = 0.72f,
    animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
    label = "glow",
  )

  Box(
    Modifier
      .fillMaxSize()
      .onSizeChanged { viewportHeight = it.height }
      .background(Brush.verticalGradient(listOf(Color(0xFFF7FDFF), Color(0xFFE0F3FC), Color(0xFFBFE4F7)))),
  ) {
    // Layer 0: Subtle deep-sea light orbs behind the character
    Canvas(Modifier.fillMaxSize()) {
      drawCircle(
        brush = Brush.radialGradient(listOf(Color(0x5282D8FC), Color.Transparent), center = Offset(size.width * 0.85f, size.height * 0.10f), radius = size.width * 0.52f),
        center = Offset(size.width * 0.85f, size.height * 0.10f),
        radius = size.width * 0.52f,
      )
      drawCircle(
        brush = Brush.radialGradient(listOf(Color(0x40A6E3FF), Color.Transparent), center = Offset(size.width * 0.12f, size.height * 0.34f), radius = size.width * 0.45f),
        center = Offset(size.width * 0.12f, size.height * 0.34f),
        radius = size.width * 0.45f,
      )
    }

    // Layer 1: Full-bleed unobstructed Live2D Character Stage (NEVER clipped by RoundedCornerShape!)
    AnyLinkPortrait(
      phase = phase,
      emotion = state.emotion,
      gesture = state.gesture,
      sequence = state.sequence,
      audioLevel = playbackLevel,
      safeTopPx = statusTopPx + with(density) { (if (callActive) 100.dp else 76.dp).roundToPx() },
      safeBottomPx = if (stageBottom > 0) (viewportHeight - stageBottom).coerceAtLeast(0) else 0,
      call = callActive,
      mini = compactStage && !callActive,
      reloadTrigger = avatarReloadTrigger,
      onStatusChange = onAvatarStatus,
      modifier = Modifier.fillMaxSize(),
    )

    // Layer 2: Foreground Floating Glass UI (hidden while full-screen real-time call is active)
    if (!callActive) Column(
      Modifier
        .fillMaxSize()
        .statusBarsPadding()
        .navigationBarsPadding()
        .imePadding(),
    ) {
      // 2a. Floating Translucent Glass Header (2-line layout so status badge never truncates on 360dp screens)
      Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Row(
          Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.SpaceBetween,
        ) {
          Text(
            "大肥鱼",
            fontSize = 22.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = 1.5.sp,
            color = DeepInk,
          )
          Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            GlassChipButton(
              text = "通话",
              icon = AppIcon.Phone,
              enabled = server != null && !callActive,
              onClick = startCall,
            )
            GlassChipButton(
              text = if (tasks.isEmpty()) "任务" else "任务(${tasks.size})",
              onClick = { records = true },
            )
            GlassChipButton(
              text = "保活",
              enabled = server != null,
              onClick = openFloating,
            )
            GlassChipButton(
              text = "连接",
              enabled = !state.busy && !callActive,
              onClick = openConfiguration,
            )
          }
        }
        Surface(
          color = Color(0xC8FFFFFF),
          shape = RoundedCornerShape(999.dp),
          border = BorderStroke(1.dp, Color(0xE6FFFFFF)),
        ) {
          Row(
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
          ) {
            Box(
              Modifier.size(7.dp).clip(CircleShape).background(
                when {
                  server == null -> Color(0xFF94A3B8)
                  wsOnline -> MintLive
                  else -> AmberWarn
                },
              ),
            )
            val subtitle = if (server == null) "未连接服务器" else buildString {
              append("Protocol v3.2")
              if (deviceSlug.isNotBlank()) append(" · @$deviceSlug")
              append(if (wsOnline) " · WS 实时在线" else " · 云端共享记忆")
            }
            Text(subtitle, fontSize = 11.sp, color = SeaSlate, maxLines = 1, overflow = TextOverflow.Ellipsis)
          }
        }
      }

      // 2b. Breathing Character Window (unobstructed view of 大肥鱼)
      Box(
        Modifier
          .fillMaxWidth()
          .weight(stageWeight)
          .padding(horizontal = 16.dp, vertical = 6.dp),
        contentAlignment = Alignment.BottomStart,
      ) {
        Surface(
          color = Color(0xD4FFFFFF),
          shape = RoundedCornerShape(999.dp),
          border = BorderStroke(1.dp, Color(0xEEFFFFFF)),
          shadowElevation = 2.dp,
        ) {
          Row(
            Modifier.padding(horizontal = 11.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
          ) {
            Box(
              Modifier.size(6.dp).clip(CircleShape).background(
                when (phase) {
                  AnyLinkPhase.Listening, AnyLinkPhase.Speaking -> MintLive
                  AnyLinkPhase.Thinking, AnyLinkPhase.Working -> OceanBright
                  AnyLinkPhase.Attention -> AmberWarn
                  else -> Color(0xFF4CA4D6)
                },
              ),
            )
            Text(
              text = when {
                state.tool.isNotBlank() && state.step > 0 -> "第 ${state.step} 步 · 正在${toolLabel(state.tool)}…"
                state.tool.isNotBlank() -> "正在${toolLabel(state.tool)}…"
                state.busy && state.step > 1 -> "第 ${state.step} 步 · ${phase.caption}"
                else -> phase.caption
              },
              fontSize = 11.5.sp,
              fontWeight = FontWeight.Medium,
              color = Color(0xFF135076),
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
      }

      // 2c. Frosted conversation sheet; reading mode always exposes the full response.
      Surface(
        modifier = Modifier
          .fillMaxWidth()
          .weight(1f - stageWeight)
          .onGloballyPositioned { stageBottom = it.positionInRoot().y.toInt() }
          .shadow(14.dp, RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp), ambientColor = Color(0x280E4A72), spotColor = Color(0x280E4A72)),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        color = Color(0xE0F5FBFE),
        border = BorderStroke(1.dp, Color(0xF0FFFFFF)),
      ) {
        Column(Modifier.fillMaxSize()) {
          // Sheet drag handle & mode toggle bar
          Column(
            Modifier.fillMaxWidth().padding(top = 8.dp, start = 16.dp, end = 16.dp, bottom = 4.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
          ) {
            Box(
              Modifier
                .width(38.dp)
                .height(4.dp)
                .clip(RoundedCornerShape(99.dp))
                .background(Color(0x474A7E9E))
                .clickable { readingExpanded = !readingExpanded },
            )
            Spacer(Modifier.height(6.dp))
            Row(
              Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Surface(
                onClick = { readingExpanded = !readingExpanded },
                color = Color(0x181368A0),
                shape = RoundedCornerShape(999.dp),
              ) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                  Text(if (readingExpanded) "陪伴视图" else "展开阅读", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = OceanPrimary)
                  AppIcon(AppIcon.Chevron, modifier = Modifier.size(12.dp), tint = OceanPrimary)
                }
              }
              if (!state.busy && state.chat.isNotEmpty()) {
                Text(
                  "开启新对话",
                  fontSize = 11.sp,
                  fontWeight = FontWeight.Medium,
                  color = SeaSlate,
                  modifier = Modifier.clickable { newConversation() }.padding(horizontal = 6.dp, vertical = 4.dp),
                )
              } else {
                Text("云端共享记忆 · 不依赖 Mac 在线", fontSize = 10.5.sp, color = SoftMist)
              }
            }
          }

          // Scrollable Full-Output Chat Feed (never truncated!)
          LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(top = 4.dp, bottom = 10.dp),
          ) {
            if (state.chat.isEmpty()) {
              item {
                Surface(
                  color = Color(0xEBFFFFFF),
                  shape = RoundedCornerShape(20.dp),
                  border = BorderStroke(1.dp, Color(0x709FD5F0)),
                  modifier = Modifier.fillMaxWidth(),
                ) {
                  Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("主人好呀，我是手机上的大肥鱼", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = DeepInk)
                    Text(
                      if (server == null) "点一下右上角「连接」，填好服务器地址和预设登录密码，本鲸鱼娘就能连上云端记忆并和电脑实时联动啦！"
                      else "所有回复都会完整显示在这张玻璃纸上，共同记忆和电脑端自动同步。直接开口说话、打字，或者先试试这些：",
                      style = MaterialTheme.typography.bodySmall,
                      color = SeaSlate,
                      lineHeight = 19.sp,
                    )
                    if (server != null) {
                      LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        item { QuickPromptPill("查看在线设备") { send("现在有哪些在线设备？") } }
                        item { QuickPromptPill("看看电脑桌面") { send("帮我看看电脑桌面上有哪些文件") } }
                        item { QuickPromptPill("看看共同记忆") { send("你还记得关于我的哪些事情？") } }
                      }
                    }
                  }
                }
              }
            } else {
              items(state.chat, key = { it.id }) { msg ->
                val synced = if (speechPresentationActive && !readingExpanded && msg.role == "assistant" && msg.id == state.chat.lastOrNull { it.role == "assistant" }?.id && state.chat.indexOf(msg) > state.chat.indexOfLast { it.role == "user" })
                  msg.copy(text = chatPlaybackText.ifBlank { "正在准备语音…" }) else msg
                ChatBubble(synced, onReplyTask = replyTask)
              }
            }
          }

          // Subtle Error / Voice Notice Strip (with one-tap Continue when step limit is reached)
          val bannerError = error.ifBlank { state.notice }
          if (bannerError.isNotBlank()) {
            Surface(
              color = if (state.canContinue) Color(0xFFE7F5FD) else Color(0xFFFEECEC),
              shape = RoundedCornerShape(12.dp),
              border = BorderStroke(1.dp, if (state.canContinue) Color(0xFF8CC8EA) else Color(0x40D94A4A)),
              modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 3.dp),
            ) {
              Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
              ) {
                Text(
                  bannerError,
                  color = if (state.canContinue) DeepInk else Color(0xFFB3261E),
                  fontSize = 12.sp,
                  modifier = Modifier.weight(1f),
                )
                if (state.canContinue && !state.busy && server != null) {
                  Button(
                    onClick = { send("请接着上一步继续完成剩余任务") },
                    shape = RoundedCornerShape(10.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                  ) { Text("继续执行", fontSize = 12.sp) }
                }
              }
            }
          }
          if (voiceNotice.isNotBlank()) {
            Text(
              voiceNotice,
              maxLines = 2,
              overflow = TextOverflow.Ellipsis,
              fontSize = 11.sp,
              color = SeaSlate,
              modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 2.dp),
            )
          }

          // Composer with vector attachment picker and preview strip
          Surface(
            color = Color(0xD8FFFFFF),
            border = BorderStroke(1.dp, Color(0x66A9D7F0)),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Column(Modifier.fillMaxWidth()) {
              if (listening && !callActive) {
                Row(
                  Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFE3F5FF))
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                  VoiceWaveformBars(level = voiceLevel, active = true)
                  Text(
                    partialTranscript.ifBlank { "正在听你说…" },
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = DeepInk,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                  )
                  Surface(
                    onClick = finishListening,
                    color = OceanPrimary,
                    shape = RoundedCornerShape(999.dp),
                  ) {
                    Text("说完了", fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, color = Color.White, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
                  }
                  Text(
                    "取消",
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = SeaSlate,
                    modifier = Modifier.clickable { cancelListening() }.padding(horizontal = 4.dp, vertical = 4.dp),
                  )
                }
              }
              if (pendingFile != null) {
                Row(
                  Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFE5F5FD))
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                  Text(
                    "${pendingFile.filename}（${AnyLinkFiles.formatSize(pendingFile.sizeBytes)}）",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = OceanPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                  )
                  Text(
                    "取消",
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = SeaSlate,
                    modifier = Modifier.clickable { clearPendingFile() }.padding(horizontal = 8.dp, vertical = 2.dp),
                  )
                }
              }
              Row(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
              ) {
                Surface(
                  onClick = pickFile,
                  enabled = server != null && !state.busy && !uploadingFile,
                  color = Color(0xFFEAF6FD),
                  shape = CircleShape,
                  border = BorderStroke(1.dp, Color(0x99B6DDF2)),
                  modifier = Modifier.size(38.dp),
                ) {
                  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AppIcon(AppIcon.Attachment, "选择附件", Modifier.size(18.dp), OceanPrimary)
                  }
                }
                Surface(
                  onClick = listen,
                  enabled = server != null && !uploadingFile,
                  color = if (listening) CoralStop else Color(0xFFEAF6FD),
                  shape = CircleShape,
                  border = BorderStroke(1.dp, if (listening) CoralStop else Color(0x99B6DDF2)),
                  modifier = Modifier.size(38.dp),
                ) {
                  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AppIcon(if (listening) AppIcon.Stop else AppIcon.Mic, if (listening) "结束录音" else "语音输入", Modifier.size(18.dp), if (listening) Color.White else OceanPrimary)
                  }
                }
                Box(
                  Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(22.dp))
                    .background(Color(0xFFF1F9FE))
                    .border(1.dp, Color(0x99B6DDF2), RoundedCornerShape(22.dp))
                    .padding(horizontal = 14.dp, vertical = 11.dp),
                ) {
                  if (draft.isEmpty()) {
                    Text(
                      if (pendingFile != null) "附言（留空则直接把文件发给电脑）…" else "和我聊聊，或安排跨设备任务…",
                      fontSize = 13.5.sp,
                      color = SoftMist,
                      maxLines = 1,
                      overflow = TextOverflow.Ellipsis,
                    )
                  }
                  BasicTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    enabled = server != null && !state.busy && !uploadingFile,
                    maxLines = 4,
                    textStyle = TextStyle(fontSize = 14.sp, color = DeepInk),
                    cursorBrush = SolidColor(OceanPrimary),
                    modifier = Modifier.fillMaxWidth(),
                  )
                }

                if (uploadingFile) {
                  Box(
                    Modifier
                      .clip(RoundedCornerShape(999.dp))
                      .background(Color(0xFF96B0C0))
                      .padding(horizontal = 14.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                  ) {
                    Text("上传中…", color = Color.White, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                  }
                } else if (state.busy || listening || speaking) {
                  Box(
                    Modifier
                      .clip(RoundedCornerShape(999.dp))
                      .background(Brush.linearGradient(listOf(CoralStop, Color(0xFFB83232))))
                      .clickable { stop() }
                      .padding(horizontal = 16.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                  ) {
                    Text(if (listening) "停听" else "停止", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                  }
                } else if (draft.isNotBlank() || pendingFile != null) {
                  Box(
                    Modifier
                      .clip(RoundedCornerShape(999.dp))
                      .background(Brush.linearGradient(listOf(OceanBright, OceanPrimary)))
                      .clickable(enabled = server != null) { val text = draft; draft = ""; send(text) }
                      .padding(horizontal = 15.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                  ) {
                    Text(if (pendingFile != null && draft.isBlank()) "发文件" else "发送", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                  }
                } else {
                  Box(
                    Modifier
                      .clip(RoundedCornerShape(999.dp))
                      .background(
                        Brush.linearGradient(
                          if (server != null) listOf(OceanBright, OceanPrimary) else listOf(Color(0xFFB4C8D4), Color(0xFF96B0C0)),
                        ),
                      )
                      .border(1.5.dp, Color.White.copy(alpha = if (server != null) orbGlow else 0.3f), RoundedCornerShape(999.dp))
                      .clickable(enabled = server != null) { listen() }
                      .padding(horizontal = 18.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                  ) {
                    Text("说话", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                  }
                }
              }
            }
          }
        }
      }
    }

    // Layer 3: Full-screen Live2D Real-Time Voice Call HUD (leaves upper character stage completely unobstructed!)
    if (callActive) {
      VoiceCallOverlay(
        callState = callState,
        autoBargeIn = autoBargeIn,
        muted = callMuted,
        speakerOn = callSpeakerOn,
        durationSec = callDurationSec,
        voiceLevel = voiceLevel,
        userCaption = callUserCaption,
        assistantCaption = callAssistantCaption,
        onToggleMute = toggleCallMute,
        onToggleSpeaker = toggleCallSpeaker,
        onBargeIn = bargeInCall,
        onEndCall = endCall,
        audioRoute = callAudioRoute,
        onPanelTop = { stageBottom = it },
      )
    }
  }

  // Connection Sheet (Quick Password Login + Optional Advanced)
  if (showConfiguration) ModalBottomSheet(onDismissRequest = closeConfiguration, containerColor = Color(0xFFF6FBFE), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("连接 AnyLink 服务器", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DeepInk)
      Text("只需输入服务器地址和预设登录密码（或加入密钥）即可一键连接；密码仅用于本次验证，不会保存在手机上。", style = MaterialTheme.typography.bodySmall, color = SeaSlate)
      OutlinedTextField(address, { address = it }, label = { Text("HTTPS 服务器地址") }, placeholder = { Text("例如 https://anylink.example.com") }, modifier = Modifier.fillMaxWidth(), singleLine = true, shape = RoundedCornerShape(14.dp))
      OutlinedTextField(joinKey, { joinKey = it }, label = { Text("登录密码 / 加入密钥") }, placeholder = { Text("输入服务器预设登录密码或加入密钥") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true, shape = RoundedCornerShape(14.dp))
      TextButton(onClick = { showAdvanced = !showAdvanced }, contentPadding = PaddingValues(0.dp)) {
        Text(if (showAdvanced) "收起高级选项" else "高级选项（设备名称、短别名、导入旧凭据）")
      }
      if (showAdvanced) {
        OutlinedTextField(deviceName, { deviceName = it }, label = { Text("设备名称（可选，默认手机型号）") }, modifier = Modifier.fillMaxWidth(), singleLine = true, shape = RoundedCornerShape(14.dp))
        OutlinedTextField(slugInput, { slugInput = it }, label = { Text("设备短别名（可选，如 my-phone）") }, modifier = Modifier.fillMaxWidth(), singleLine = true, shape = RoundedCornerShape(14.dp))
        TextButton(onClick = { legacyImport = !legacyImport }, contentPadding = PaddingValues(0.dp)) { Text(if (legacyImport) "收起旧版凭据导入" else "导入旧版设备凭据 JSON") }
        if (legacyImport) OutlinedTextField(credential, { credential = it }, label = { Text("设备凭据 JSON") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), maxLines = 4, shape = RoundedCornerShape(14.dp))
      }
      if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
      Button(
        onClick = {
          if (legacyImport) connect(address, "", credential, deviceName, "") else connect(address, joinKey, "", deviceName, slugInput)
          joinKey = ""; credential = ""
        },
        modifier = Modifier.fillMaxWidth().height(48.dp),
        shape = RoundedCornerShape(16.dp),
        enabled = !connecting && address.isNotBlank() && (if (legacyImport) credential.isNotBlank() else joinKey.isNotBlank()),
      ) {
        Text(if (connecting) "验证身份中…" else "验证并连接", fontWeight = FontWeight.SemiBold)
      }
      Text("连接后会自动获取并加密保存专属设备令牌（Android Keystore AES-GCM），不包含大模型 API Key。", style = MaterialTheme.typography.labelSmall, color = SoftMist)
      TextButton(onClick = { showLicenses = true }, contentPadding = PaddingValues(0.dp)) { Text("开源许可") }
      Spacer(Modifier.height(16.dp))
    }
  }

  // Task & Run History Sheet
  if (records) ModalBottomSheet(onDismissRequest = { records = false }, containerColor = Color(0xFFF6FBFE), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("跨设备任务与执行记录", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DeepInk)
      TextButton(onClick = { newConversation(); records = false }, enabled = !state.busy) { Text("开启新对话，共同记忆保留") }
      if (tasks.isEmpty() && state.runs.isEmpty()) {
        Text("还没有任务记录。", style = MaterialTheme.typography.bodySmall, color = SoftMist)
      }
      for (task in tasks) {
        val label = when (task.text("capability")) {
          "files.search" -> "搜索电脑文件"
          "phone.status" -> "读取手机状态"
          "companion.say" -> "让大肥鱼说话"
          "file.deliver" -> "跨设备传文件"
          "agent.ask", "agent.invoke" -> task.text("instruction").take(28).ifBlank { "跨设备协作" }
          else -> "跨设备任务"
        }
        Surface(color = Color.White, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Color(0xFFD5ECF8)), modifier = Modifier.fillMaxWidth()) {
          Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text((if (task.text("_role") == "target") "发给手机 · " else "我发出的 · ") + label + " · " + statusLabel(task.text("state")), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = DeepInk)
            Text(task.text("id"), style = MaterialTheme.typography.labelSmall, color = SoftMist)
            TaskReceipt(task)
          }
        }
      }
      for (run in state.runs) {
        Text(run.text("text"), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = DeepInk)
        Text(statusLabel(run.text("state")) + " · " + run.text("answer").ifBlank { run.text("notice") }, style = MaterialTheme.typography.bodySmall, color = SeaSlate)
        if (run["last_result"] != null) Text("已保存${toolLabel(run.text("last_tool"))}的执行回执", style = MaterialTheme.typography.labelSmall, color = SoftMist)
        HorizontalDivider(color = Color(0xFFDCEEF8))
      }
      Spacer(Modifier.height(24.dp))
    }
  }

  if (showLicenses) ModalBottomSheet(onDismissRequest = { showLicenses = false }, containerColor = Color(0xFFF6FBFE), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("开源许可与致谢", style = MaterialTheme.typography.titleLarge, color = DeepInk)
      for ((title, text) in licenses) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = DeepInk)
        Text(text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = SeaSlate)
        HorizontalDivider()
      }
    }
  }
}

@Composable
private fun VoiceWaveformBars(level: Float, active: Boolean) {
  val clamped = if (active) level.coerceIn(0.12f, 1f) else 0.12f
  val multipliers = listOf(0.55f, 0.9f, 1.0f, 0.8f, 0.5f)
  Row(horizontalArrangement = Arrangement.spacedBy(2.5.dp), verticalAlignment = Alignment.CenterVertically) {
    for (m in multipliers) {
      val h = (6f + 16f * clamped * m).dp
      Box(
        Modifier
          .width(3.dp)
          .height(h)
          .clip(RoundedCornerShape(99.dp))
          .background(if (active) OceanBright else Color(0xFF9BB8C9)),
      )
    }
  }
}

@Composable
private fun GlassChipButton(text: String, enabled: Boolean = true, icon: AppIcon? = null, onClick: () -> Unit) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    color = Color(if (enabled) 0xCCFFFFFF else 0x80FFFFFF),
    shape = RoundedCornerShape(999.dp),
    border = BorderStroke(1.dp, Color(0xEBFFFFFF)),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      if (icon != null) AppIcon(icon, modifier = Modifier.size(14.dp), tint = OceanPrimary)
      Text(
      text = text,
      fontSize = 11.5.sp,
      fontWeight = FontWeight.SemiBold,
      color = if (enabled) Color(0xFF11517A) else Color(0xFF8AA4B5),
      modifier = Modifier.padding(horizontal = 11.dp, vertical = 6.dp),
    )
    }
  }
}

@Composable
private fun QuickPromptPill(label: String, onClick: () -> Unit) {
  Surface(
    onClick = onClick,
    color = Color(0xFFE7F5FD),
    shape = RoundedCornerShape(999.dp),
    border = BorderStroke(1.dp, Color(0xFFAAD8F0)),
  ) {
    Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = OceanPrimary, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp))
  }
}

@Composable
private fun ChatBubble(msg: ChatMessage, onReplyTask: (String, Boolean?, String?, String?) -> Unit) {
  val context = LocalContext.current
  val isUser = msg.role == "user"
  val isEvent = msg.role == "event"
  val isInteraction = msg.role == "interaction"

  if (isInteraction) {
    Surface(
      color = Color(0xF2E5F6FF),
      shape = RoundedCornerShape(20.dp),
      border = BorderStroke(1.2.dp, Color(0xFF5FAEE0)),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(msg.meta.ifBlank { "跨设备交互确认" }, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = OceanPrimary)
          if (msg.riskLevel.isNotBlank()) {
            Surface(color = if (msg.riskLevel == "high") Color(0xFFFFE4E4) else Color(0xFFD6EFFC), shape = RoundedCornerShape(6.dp)) {
              Text(msg.riskLevel.uppercase(), fontSize = 9.5.sp, fontWeight = FontWeight.Bold, color = if (msg.riskLevel == "high") Color(0xFFB3261E) else OceanPrimary, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
            }
          }
        }
        MarkdownText(msg.text, color = DeepInk)
        if (!msg.resolved && msg.taskId.isNotBlank()) {
          if (msg.interactionType == "awaiting_approval") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              Button(
                onClick = { onReplyTask(msg.taskId, true, null, "批准") },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.weight(1f),
              ) { Text("批准执行", fontSize = 12.5.sp) }
              OutlinedButton(
                onClick = { onReplyTask(msg.taskId, false, null, "拒绝") },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.weight(1f),
              ) { Text("先不要", fontSize = 12.5.sp) }
            }
          } else if (msg.choices.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              items(msg.choices) { option ->
                QuickPromptPill(option) { onReplyTask(msg.taskId, null, option, option) }
              }
            }
          }
        }
      }
    }
    return
  }

  Row(
    Modifier.fillMaxWidth(),
    horizontalArrangement = when {
      isUser -> Arrangement.End
      isEvent -> Arrangement.Center
      else -> Arrangement.Start
    },
  ) {
    if (isUser) {
      Box(
        Modifier
          .widthIn(max = 296.dp)
          .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 6.dp))
          .background(Brush.linearGradient(listOf(Color(0xFF1D7AB6), Color(0xFF0E5587))))
          .padding(horizontal = 14.dp, vertical = 10.dp),
      ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          if (msg.fileName.isNotBlank()) AttachmentCard(msg)
          SelectionContainer {
            Text(msg.text, style = MaterialTheme.typography.bodyMedium, color = Color.White, lineHeight = 20.sp)
          }
        }
      }
    } else {
      Surface(
        color = if (isEvent) Color(0xEBE4F5FE) else Color(0xF5FFFFFF),
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 6.dp, bottomEnd = 20.dp),
        border = BorderStroke(1.dp, if (isEvent) Color(0xFF9CD4F2) else Color(0x88AEDBF2)),
        shadowElevation = 1.dp,
        modifier = Modifier.widthIn(max = if (isEvent) 336.dp else 306.dp),
      ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(
            text = msg.meta.ifBlank { if (isEvent) "跨设备动态" else if (msg.streaming) "大肥鱼 · 回复中…" else "大肥鱼" },
            fontSize = 10.5.sp,
            color = if (isEvent) OceanPrimary else SeaSlate,
            fontWeight = FontWeight.SemiBold,
          )
          SelectionContainer {
            MarkdownText(
              text = msg.text,
              color = DeepInk,
            )
          }
          if (msg.fileName.isNotBlank()) AttachmentCard(msg)
        }
      }
    }
  }
}

private fun statusLabel(state: String): String = when (state) {
  "queued" -> "等待目标设备"
  "running" -> "正在处理"
  "awaiting_input" -> "等待你回复"
  "awaiting_approval" -> "等待主人审批"
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
  "task_reply" -> "回复跨设备任务"
  "file_send" -> "跨设备发送文件"
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
      if (files.isEmpty()) Text("开放范围内没有匹配的文件。", color = SeaSlate)
      for (file in files) { val entry = file.jsonObject; Text(entry.text("name"), style = MaterialTheme.typography.titleSmall, color = DeepInk); Text(entry.text("path"), style = MaterialTheme.typography.bodySmall, color = SeaSlate) }
      if (partial) Text("搜索覆盖有限，未遍历全部文件。", style = MaterialTheme.typography.labelSmall, color = SoftMist)
    }
    reply.isNotBlank() -> MarkdownText(reply, color = DeepInk)
    error != null -> Text(error.text("message"), color = SeaSlate)
    task.text("state") == "running" && progress?.text("message")?.isNotBlank() == true -> Text(progress.text("message"), color = SeaSlate)
    task.text("state") == "queued" -> Text("目标设备领取后会通过 WebSocket 实时推回结果，手机可以继续聊天。", color = SeaSlate)
    task.text("state") == "unknown" -> Text("执行结果未确认，请先检查目标设备，系统不会自动重跑。", color = SeaSlate)
    else -> Text(statusLabel(task.text("state")), color = SeaSlate)
  }
}
