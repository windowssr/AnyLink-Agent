package ai.openclaw.app.anylink

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun VoiceCallOverlay(
  callState: String, muted: Boolean, speakerOn: Boolean, durationSec: Int, voiceLevel: Float,
  userCaption: String, assistantCaption: String, onToggleMute: () -> Unit, onToggleSpeaker: () -> Unit,
  onBargeIn: () -> Unit, onEndCall: () -> Unit, onPanelTop: (Int) -> Unit = {}, audioRoute: String = if (speakerOn) "外放" else "听筒",
) {
  val colors = MaterialTheme.colorScheme
  val status = when {
    callState == "error" -> "通话暂不可用 · 点人物重试"
    muted -> "麦克风已静音"
    callState == "listening" -> "正在听你说"
    callState == "transcribing" -> "正在识别"
    callState == "thinking" -> "正在准备回复"
    callState == "speaking" -> "正在说话 · 点人物可插话"
    callState == "reconnecting" -> "正在恢复监听"
    else -> "正在连接"
  }
  Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Text("大肥鱼", fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurface)
    Text("语音通话", fontSize = 12.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(top = 5.dp))
    Text(if (durationSec > 0 || callState == "listening" || callState == "speaking" || callState == "thinking") "%02d:%02d".format(durationSec / 60, durationSec % 60) else "连接中", fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = colors.primary, modifier = Modifier.padding(top = 10.dp))
    Box(Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = if (callState == "error") "重试语音通话" else "打断播报" }.clickable(onClick = onBargeIn))
    Surface(color = colors.surface.copy(alpha = 0.94f), shape = RoundedCornerShape(24.dp), modifier = Modifier.onGloballyPositioned { onPanelTop(it.positionInRoot().y.toInt()) }) {
      Column(Modifier.fillMaxWidth().padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
          Box(Modifier.size(6.dp).clip(CircleShape).background(if (callState == "error") colors.error else colors.primary))
          Text(status, fontSize = 12.sp, color = if (callState == "error") colors.error else colors.primary)
        }
        if (userCaption.isNotBlank()) Text("你：$userCaption", fontSize = 12.sp, color = colors.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (assistantCaption.isNotBlank()) Text(assistantCaption, fontSize = 15.sp, lineHeight = 22.sp, color = colors.onSurface, maxLines = 3, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
          CallAction(AppIcon.MicOff.takeIf { muted } ?: AppIcon.Mic, if (muted) "取消静音" else "静音", muted, onToggleMute)
          Column(modifier = Modifier.clickable(onClick = onEndCall), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(onClick = onEndCall, shape = CircleShape, color = Color(0xFFD94A4A), contentColor = Color.White, modifier = Modifier.size(76.dp)) {
              Box(contentAlignment = Alignment.Center) { AppIcon(AppIcon.HangUp, "挂断通话", Modifier.size(30.dp)) }
            }
            Text("挂断", fontSize = 12.sp, color = colors.onSurfaceVariant)
          }
          CallAction(if (speakerOn) AppIcon.Speaker else AppIcon.Earpiece, audioRoute, speakerOn, onToggleSpeaker)
        }
      }
    }
  }
}
@Composable
private fun CallAction(icon: AppIcon, label: String, selected: Boolean, action: () -> Unit) {
  val c = MaterialTheme.colorScheme
  Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.widthIn(min = 68.dp).clickable(onClick = action)) {
    Surface(onClick = action, shape = CircleShape, color = if (selected) c.primaryContainer else c.surfaceVariant, modifier = Modifier.size(54.dp)) {
      Box(contentAlignment = Alignment.Center) { AppIcon(icon, label, Modifier.size(22.dp), c.onSurface) }
    }
    Text(label, fontSize = 12.sp, color = c.onSurfaceVariant)
  }
}
