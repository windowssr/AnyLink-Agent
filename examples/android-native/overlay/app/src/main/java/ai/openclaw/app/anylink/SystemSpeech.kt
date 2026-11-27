package ai.openclaw.app.anylink

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

internal data class SystemSpeechTarget(val id: String, val label: String)
internal data class SystemSpeechCatalog(
  val defaultAvailable: Boolean,
  val onDeviceAvailable: Boolean,
  val defaultService: String,
  val services: List<SystemSpeechTarget>,
  val discoveryDetails: List<String> = emptyList(),
) {
  val options: List<SystemSpeechTarget> get() = buildList {
    add(SystemSpeechTarget("auto", "自动选择系统服务"))
    if (defaultAvailable) add(SystemSpeechTarget("default", "系统默认服务"))
    if (onDeviceAvailable) add(SystemSpeechTarget("on-device", "设备内识别"))
    addAll(services)
  }
  fun candidates(preferred: String): List<SystemSpeechTarget> = when (preferred) {
    "auto" -> buildList {
      if (onDeviceAvailable) add(SystemSpeechTarget("on-device", "设备内识别"))
      if (defaultAvailable) add(SystemSpeechTarget("default", "系统默认服务"))
    }
    "default" -> if (defaultAvailable) listOf(SystemSpeechTarget("default", "系统默认服务")) else emptyList()
    "on-device" -> if (onDeviceAvailable) listOf(SystemSpeechTarget("on-device", "设备内识别")) else emptyList()
    else -> services.filter { it.id == preferred }
  }
  fun attempts(preferred: String): List<SystemSpeechTarget> {
    val choices = candidates(preferred)
    if (choices.size != 1) return choices.take(2)
    val first = choices.single()
    val defaultId = ComponentName.unflattenFromString(defaultService)?.flattenToString()
    val explicitDefault = if (first.id == "default") services.firstOrNull { it.id == defaultId } else null
    return listOf(first, explicitDefault?.copy(label = explicitDefault.label + "（默认组件）") ?: first)
  }
}

internal interface SystemSpeechPlatform {
  fun catalog(): SystemSpeechCatalog
  fun create(target: SystemSpeechTarget): SpeechRecognizer
}

internal class AndroidSystemSpeechPlatform(private val context: Context) : SystemSpeechPlatform {
  override fun catalog(): SystemSpeechCatalog {
    val details = mutableListOf<String>()
    val registered = runCatching {
      context.packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), PackageManager.GET_META_DATA)
    }.getOrElse { details += "查询系统服务失败：${it.javaClass.simpleName}"; emptyList() }
    details += "系统查询返回：${registered.size} 项"
    val services = registered.mapNotNull { result ->
      val info = result.serviceInfo ?: return@mapNotNull null
      val component = ComponentName(info.packageName, info.name)
      val enabled = info.enabled && info.applicationInfo?.enabled != false
      details += "${component.flattenToShortString()}：enabled=$enabled，exported=${info.exported}"
      if (!enabled) return@mapNotNull null
      // RecognitionService is connected by Android's recognition manager, not by an app bindService().
      // A non-exported declaration alone does not establish whether the system proxy can use it.
      val label = runCatching { result.loadLabel(context.packageManager).toString() }.getOrDefault(component.shortClassName)
      SystemSpeechTarget(component.flattenToString(), label)
    }.distinctBy { it.id }.sortedBy { it.label }
    return SystemSpeechCatalog(
      runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false),
      runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(context) }.getOrDefault(false),
      runCatching { Settings.Secure.getString(context.contentResolver, "voice_recognition_service") }.getOrNull().orEmpty(),
      services,
      details,
    )
  }
  override fun create(target: SystemSpeechTarget): SpeechRecognizer = when (target.id) {
    "default" -> SpeechRecognizer.createSpeechRecognizer(context)
    "on-device" -> SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
    else -> SpeechRecognizer.createSpeechRecognizer(context, requireNotNull(ComponentName.unflattenFromString(target.id)))
  }
}

internal fun systemSpeechError(error: Int): Pair<String, String> = when (error) {
  SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "MIC_PERMISSION" to "请授予麦克风权限，并检查系统是否关闭了麦克风访问。"
  SpeechRecognizer.ERROR_AUDIO -> "MIC_UNAVAILABLE" to "麦克风无法录音，请检查是否被其他应用占用。"
  SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "ASR_LANGUAGE_UNSUPPORTED" to "当前系统识别服务不支持普通话，请在「保活」中选择其他系统服务。"
  SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "ASR_LANGUAGE_UNAVAILABLE" to "系统识别服务缺少中文语音模型，请在系统语音设置中下载，或选择其他系统服务。"
  SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "ASR_SYSTEM_NETWORK" to "手机系统语音服务连接失败，请检查该服务的联网权限，或选择设备内识别。"
  SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "ASR_SYSTEM_BUSY" to "系统语音服务正忙，请关闭其他录音或语音应用后重试。"
  else -> "ASR_ERROR_$error" to "系统语音服务没有完成识别（错误 $error），请在「保活」中查看语音识别诊断。"
}
