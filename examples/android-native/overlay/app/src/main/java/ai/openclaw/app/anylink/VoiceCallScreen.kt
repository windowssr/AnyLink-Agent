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
    callState == "buffering" -> "正在准备声音"
    callState == "speaking" -> "正在说话 · 点人物可插话"
    callState == "reconnecting" -> "正在恢复监听"
    else -> "正在连接"
  }
  Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
      Surface(color = colors.surface.copy(alpha = 0.72f), shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
          Text("大肥鱼", fontSize = 21.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurface)
          Text("语音通话", fontSize = 11.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(top = 3.dp))
        }
      }
      Surface(color = colors.surface.copy(alpha = 0.72f), shape = RoundedCornerShape(16.dp)) {
        Text(if (durationSec > 0 || callState == "listening" || callState == "speaking" || callState == "thinking") "%02d:%02d".format(durationSec / 60, durationSec % 60) else "连接中", fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = colors.primary, modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp))
      }
    }
    Box(Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = if (callState == "error") "重试语音通话" else "打断播报" }.clickable(onClick = onBargeIn))
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Surface(color = colors.surface.copy(alpha = 0.82f), shape = RoundedCornerShape(18.dp)) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(if (callState == "error") colors.error else colors.primary))
            Text(status, fontSize = 12.sp, color = if (callState == "error") colors.error else colors.primary)
          }
          if (userCaption.isNotBlank()) Text("你：$userCaption", fontSize = 12.sp, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
          if (assistantCaption.isNotBlank()) Text(assistantCaption, fontSize = 14.sp, lineHeight = 20.sp, color = colors.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
      }
      Row(Modifier.fillMaxWidth().padding(top = 8.dp).onGloballyPositioned { onPanelTop(it.positionInRoot().y.toInt()) }, horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
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
