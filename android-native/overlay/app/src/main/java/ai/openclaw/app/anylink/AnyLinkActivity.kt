package ai.openclaw.app.anylink

import ai.openclaw.app.loadAndroidLicenseNotices
import ai.openclaw.app.ui.AnyLinkPhase
import ai.openclaw.app.ui.AnyLinkPortrait
import android.Manifest
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal class AnyLinkViewModel(application: Application) : AndroidViewModel(application) {
  private val profiles = ConnectionStore(application)
  val agent = MutableStateFlow<DeviceAgent?>(null)
  val connection = MutableStateFlow<CloudConnection?>(null)
  val error = MutableStateFlow("")
  val connecting = MutableStateFlow(false)
  val tasks = MutableStateFlow<List<JsonObject>>(emptyList())
  private var cloud: CloudClient? = null
  private var turn: Job? = null
  init {
    try { profiles.load()?.let(::activate) } catch (_: Exception) { error.value = "无法解密原设备凭据，请重新导入；原会话和便笺保留。" }
  }
  private fun activate(value: CloudConnection) {
    connection.value = value
    val transport = CloudClient(value); cloud = transport
    agent.value = DeviceAgent(value, transport, SqlAgentLedger(getApplication(), value)) {
      jsonObject("platform" to str("android"), "manufacturer" to str(Build.MANUFACTURER), "model" to str(Build.MODEL), "android_version" to str(Build.VERSION.RELEASE), "device_id" to str(value.deviceId), "runtime" to str("on-device-agent"), "mac_required" to JsonPrimitive(false))
    }
  }
  fun connect(server: String, credential: String, finished: () -> Unit) {
    if (connecting.value || agent.value?.state?.value?.busy == true) return
    connecting.value = true; error.value = ""
    viewModelScope.launch {
      try {
        val value = CloudConnection.parse(server, credential)
        val candidate = DeviceAgent(value, CloudClient(value), SqlAgentLedger(getApplication(), value)) { JsonObject(emptyMap()) }
        candidate.verify(); profiles.save(value); activate(value); tasks.value = emptyList(); finished()
      } catch (failure: Exception) { error.value = (failure as? LinkFailure)?.message ?: "连接未通过。检查 HTTPS 地址及手机自己的设备凭据 JSON。" }
      finally { connecting.value = false }
    }
  }
  fun send(text: String) {
    val active = agent.value ?: return
    if (active.state.value.busy || text.isBlank()) return
    error.value = ""
    turn = viewModelScope.launch { try { active.send(text.trim()) } catch (_: Exception) { error.value = "请输入1到8000字。" } }
  }
  fun stop() { agent.value?.stop(); turn?.cancel() }
  suspend fun refreshTasks() {
    if (cloud == null) return
    // A separate read client must not replace the in-flight model cancellation handle.
    val value = connection.value ?: return
    try {
      val result = CloudClient(value).request("GET", "/edge/v1/link/tasks")["items"]!!.jsonArray.map { it.jsonObject }
      if (connection.value == value) tasks.value = result
    } catch (_: Exception) { /* Keep the last confirmed task snapshot. */ }
  }
  override fun onCleared() { stop(); super.onCleared() }
}

/** Product launcher deliberately never creates NodeRuntime or a Gateway connection. */
class AnyLinkActivity : ComponentActivity() {
  private val model: AnyLinkViewModel by viewModels()
  private var recognizer: SpeechRecognizer? = null
  private var speech: TextToSpeech? = null
  private var speechReady = false
  private val listening = mutableStateOf(false)
  private val speaking = mutableStateOf(false)
  private val voiceNotice = mutableStateOf("")
  private val requestMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
    if (allowed) listen() else voiceNotice.value = "需要麦克风权限，也可以继续文字聊天。"
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    speech = TextToSpeech(this) { status ->
      speechReady = status == TextToSpeech.SUCCESS
      if (speechReady) { speech?.language = Locale.SIMPLIFIED_CHINESE; speech?.setSpeechRate(1.08f); speech?.setPitch(1.12f) }
    }
    speech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) { runOnUiThread { speaking.value = true } }
      override fun onDone(utteranceId: String?) { runOnUiThread { speaking.value = false } }
      @Deprecated("Required platform callback") override fun onError(utteranceId: String?) { runOnUiThread { speaking.value = false; voiceNotice.value = "播报失败，请查看文字结果。" } }
    })
    lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { model.refreshTasks(); delay(4000) } } }
    setContent {
      MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF468CAF), background = Color(0xFFF0F8FC))) {
        val agent by model.agent.collectAsState()
        val local = agent?.state?.collectAsState()?.value ?: LocalAgentState()
        val profile by model.connection.collectAsState()
        val error by model.error.collectAsState()
        val connecting by model.connecting.collectAsState()
        val tasks by model.tasks.collectAsState()
        var configuration by remember { mutableStateOf(false) }
        var spoken by remember(agent) { mutableStateOf(local.runs.firstOrNull()?.text("id").orEmpty()) }
        LaunchedEffect(local.runs) {
          val last = local.runs.firstOrNull()
          if (last?.text("state") == "completed" && last.text("id") != spoken) {
            spoken = last.text("id")
            if (speechReady && last.text("answer").isNotBlank()) speech?.speak(last.text("answer").take(3500), TextToSpeech.QUEUE_FLUSH, null, spoken)
          }
        }
        CloudCompanionScreen(local, profile?.server, error, voiceNotice.value, connecting, listening.value, speaking.value, tasks,
          showConfiguration = configuration || profile == null,
          openConfiguration = { configuration = true },
          closeConfiguration = { configuration = false },
          connect = { server, credential -> model.connect(server, credential) { configuration = false } },
          send = { text -> interrupt(); model.send(text) },
          stop = { interrupt() },
          listen = { interrupt(); if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) listen() else requestMic.launch(Manifest.permission.RECORD_AUDIO) },
          newConversation = { agent?.newConversation() },
        )
      }
    }
  }
  private fun interrupt() {
    model.stop(); speech?.stop(); recognizer?.cancel(); listening.value = false; speaking.value = false
  }
  private fun listen() {
    if (!SpeechRecognizer.isRecognitionAvailable(this)) { voiceNotice.value = "系统没有语音识别服务，请使用文字输入。"; return }
    recognizer?.destroy()
    recognizer = if (SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) SpeechRecognizer.createOnDeviceSpeechRecognizer(this) else SpeechRecognizer.createSpeechRecognizer(this)
    recognizer?.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) { listening.value = true; voiceNotice.value = "我在听。点击停止可随时打断。" }
      override fun onBeginningOfSpeech() = Unit
      override fun onRmsChanged(rmsdB: Float) = Unit
      override fun onBufferReceived(buffer: ByteArray?) = Unit
      override fun onEndOfSpeech() { listening.value = false }
      override fun onError(error: Int) { listening.value = false; voiceNotice.value = "没有收到完整语音（$error），可以重说或输入文字。" }
      override fun onResults(results: Bundle?) {
        listening.value = false
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { voiceNotice.value = it; model.send(it) }
      }
      override fun onPartialResults(partialResults: Bundle?) { partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { voiceNotice.value = it } }
      override fun onEvent(eventType: Int, params: Bundle?) = Unit
    })
    recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN").putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true).putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true))
  }
  override fun onStop() { recognizer?.cancel(); listening.value = false; speech?.stop(); speaking.value = false; super.onStop() }
  override fun onDestroy() { recognizer?.destroy(); speech?.shutdown(); super.onDestroy() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CloudCompanionScreen(
  state: LocalAgentState, server: String?, error: String, voiceNotice: String, connecting: Boolean,
  listening: Boolean, speaking: Boolean, tasks: List<JsonObject>, showConfiguration: Boolean,
  openConfiguration: () -> Unit, closeConfiguration: () -> Unit, connect: (String, String) -> Unit,
  send: (String) -> Unit, stop: () -> Unit, listen: () -> Unit, newConversation: () -> Unit,
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
  var credential by remember { mutableStateOf("") }
  val phase = when { speaking -> AnyLinkPhase.Speaking; listening -> AnyLinkPhase.Listening; state.phase == "working" -> AnyLinkPhase.Working; state.busy -> AnyLinkPhase.Thinking; state.notice.isNotEmpty() -> AnyLinkPhase.Attention; else -> AnyLinkPhase.Idle }
  Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFFF5FBFE), Color(0xFFD5ECF7))))) {
    AnyLinkPortrait(phase, state.emotion, state.gesture, state.sequence, Modifier.fillMaxSize())
    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(20.dp)) {
      Text("大肥鱼 · AnyLink", style = MaterialTheme.typography.headlineSmall)
      Text(if (server == null) "连接你的服务器，让我住进这台手机" else "手机本地 Agent · 统一记忆与模型", style = MaterialTheme.typography.bodySmall)
      TextButton(onClick = openConfiguration, enabled = !state.busy) { Text("服务器连接") }
    }
    Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color(0xEAF0F8FC)).navigationBarsPadding().imePadding().padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
      Text("为本手机注册独立的 Android 逻辑设备，导入其一次性凭据。这里不连接 Mac 或 OpenClaw Gateway。")
      OutlinedTextField(address, { address = it }, label = { Text("HTTPS 服务器地址") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
      OutlinedTextField(credential, { credential = it }, label = { Text("设备凭据 JSON") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), maxLines = 4)
      if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
      Button(onClick = { connect(address, credential); credential = "" }, enabled = !connecting && credential.isNotBlank()) { Text(if (connecting) "验证身份中…" else "验证并连接") }
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
        Text((if (task.text("capability") == "files.search") "搜索电脑文件" else "跨设备任务") + " · " + statusLabel(task.text("state")), style = MaterialTheme.typography.titleMedium)
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
private fun toolLabel(name: String): String = when (name) {
  "device_info" -> "查看手机状态"
  "note_save" -> "保存便笺"
  "note_read" -> "读取便笺"
  "memory_search" -> "查找共同记忆"
  "memory_save", "memory_update", "memory_delete" -> "更新共同记忆"
  "link_peers" -> "查找已授权设备"
  "task_create" -> "安排跨设备任务"
  "task_status" -> "查看任务进展"
  "task_cancel" -> "停止任务"
  "companion_expression" -> "回应你"
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
