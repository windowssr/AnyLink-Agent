package ai.openclaw.app.anylink

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager

/** API 31+ communication routing. UI follows the confirmed device instead of a speculative Boolean. */
internal class CallAudioController(
  context: Context,
  private val onRoute: (Boolean, String) -> Unit,
  private val onError: (String) -> Unit,
  private val onFocusLost: () -> Unit,
) {
  private val audio = context.getSystemService(AudioManager::class.java)
  private var active = false
  private var focusHeld = false
  private var previousMode = AudioManager.MODE_NORMAL
  private val listener = AudioManager.OnCommunicationDeviceChangedListener { update(it) }
  private val executor = context.mainExecutor
  private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
    .setOnAudioFocusChangeListener { if (active && focusHeld && it < 0) { focusHeld = false; onFocusLost() } }.build()
  private fun update(device: AudioDeviceInfo?) {
    onRoute(device?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, when (device?.type) {
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "听筒"
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "外放"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "蓝牙耳机"
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "耳机"
      else -> "系统音频"
    })
  }
  fun start(speaker: Boolean): Boolean {
    if (active) return true
    previousMode = audio.mode
    active = true
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    audio.addOnCommunicationDeviceChangedListener(executor, listener)
    // Respect an already connected headset; otherwise select the requested built-in endpoint.
    val headset = audio.availableCommunicationDevices.firstOrNull { it.type in setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET) }
    if (headset != null) audio.setCommunicationDevice(headset) else route(speaker)
    update(audio.communicationDevice)
    return true
  }
  fun route(speaker: Boolean) {
    val type = if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
    val target = audio.availableCommunicationDevices.firstOrNull { it.type == type }
    if (target == null || !audio.setCommunicationDevice(target)) onError(if (speaker) "无法切换外放，请检查音频设备。" else "当前设备没有可用听筒。")
    update(audio.communicationDevice)
  }
  fun requestPlaybackFocus(): Boolean {
    // OEM/system recognizers may acquire focus while capturing. Request ours only for playback.
    if (focusHeld) return true
    focusHeld = audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    if (!focusHeld) onError("音频正在被其他应用使用，请稍后重试。")
    return focusHeld
  }
  fun releasePlaybackFocus() {
    if (focusHeld) { focusHeld = false; audio.abandonAudioFocusRequest(focus) }
  }
  fun stop() {
    if (!active) return
    active = false
    audio.removeOnCommunicationDeviceChangedListener(listener)
    audio.clearCommunicationDevice()
    audio.mode = previousMode
    releasePlaybackFocus()
  }
}
