package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.MainViewModel
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

private val AnyLinkInk = Color(0xFF244D67)
private val AnyLinkBlue = Color(0xFF468CAF)

@Composable
internal fun AnyLinkCompanionScreen(
  viewModel: MainViewModel,
  hasPendingQuestion: Boolean,
  onToggleTalk: () -> Unit,
  onOpenChat: () -> Unit,
  onOpenSidebar: () -> Unit,
  onOpenGatewaySettings: () -> Unit,
) {
  val connected by viewModel.isConnected.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val owner by viewModel.chatSessionOwnerAgentId.collectAsState()
  val talk by viewModel.talkModeEnabled.collectAsState()
  val listening by viewModel.talkModeListening.collectAsState()
  val speaking by viewModel.talkModeSpeaking.collectAsState()
  val awaiting by viewModel.talkAwaitingAgent.collectAsState()
  val active by viewModel.chatSelectedActiveRunPresentation.collectAsState()
  val tools by viewModel.chatToolActivities.collectAsState()
  val error by viewModel.chatError.collectAsState()
  val preferredAgent = BuildConfig.ANYLINK_AGENT_ID
  val agentAvailable = agents.any { it.id == preferredAgent }
  val contextReady = connected && owner == preferredAgent
  val phase = anyLinkPhase(listening, speaking, awaiting, active.count, tools.any { !it.isComplete }, !error.isNullOrBlank() || hasPendingQuestion)
  val expression = tools.lastOrNull { it.name == "anylink_companion_expression" && it.isError != true }
  val emotion = expression?.args?.get("emotion")?.jsonPrimitive?.contentOrNull ?: if (phase == AnyLinkPhase.Thinking) "curious" else "neutral"
  val gesture = expression?.args?.get("gesture")?.jsonPrimitive?.contentOrNull
  Box(
    Modifier.fillMaxSize().testTag("anylink.companion")
      .background(Brush.verticalGradient(listOf(Color(0xFFF5FBFE), Color(0xFFD5ECF7), Color(0xFFDBEEF8)))),
  ) {
    AnyLinkPortrait(phase, emotion, gesture, expression?.toolCallId, Modifier.fillMaxSize())
    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(270.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE6EFF8FC), Color(0xFFF0F8FC)))))
    Row(
      Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 22.dp, vertical = 14.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column {
        Text("大肥鱼", color = AnyLinkInk, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Text(if (contextReady) "今天也一起吧。" else "等你带我认识这台手机", color = AnyLinkBlue, fontSize = 12.sp)
      }
      IconButton(onClick = onOpenSidebar, modifier = Modifier.background(Color.White.copy(alpha = 0.65f), CircleShape)) {
        Icon(Icons.Default.Menu, contentDescription = "会话与连接", tint = AnyLinkInk)
      }
    }
    Column(
      Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 24.dp, vertical = 20.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      val caption = when {
        !connected -> "连接 Mac，就能接着聊天和做事。"
        !agentAvailable -> "手机助理上下文尚未配置，请先完成连接设置。"
        !contextReady -> "当前打开了其他设备的会话。"
        else -> phase.caption
      }
      Text(caption, color = AnyLinkInk, fontSize = 13.sp, modifier = Modifier.testTag("anylink.companion.phase"))
      if (active.count > 0) {
        TextButton(onClick = viewModel::abortChat) {
          Icon(Icons.Default.Stop, null, Modifier.size(16.dp))
          Text("停止当前任务")
        }
      }
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onOpenChat, modifier = Modifier.background(Color.White.copy(alpha = 0.7f), CircleShape)) {
          Icon(Icons.Default.ChatBubbleOutline, contentDescription = "文字输入", tint = AnyLinkInk)
        }
        Button(
          onClick = {
            when {
              !connected || !agentAvailable -> onOpenGatewaySettings()
              !contextReady -> viewModel.selectChatAgent(preferredAgent)
              else -> onToggleTalk()
            }
          },
          modifier = Modifier.height(60.dp).widthIn(min = 156.dp).testTag("anylink.companion.talk"),
          shape = RoundedCornerShape(30.dp),
          colors = ButtonDefaults.buttonColors(containerColor = AnyLinkBlue, contentColor = Color.White),
        ) {
          Icon(if (talk) Icons.Default.Stop else Icons.Default.Mic, null, Modifier.size(21.dp))
          Spacer(Modifier.size(8.dp))
          Text(when { !connected || !agentAvailable -> "连接我的 Mac"; !contextReady -> "回到手机上下文"; talk -> "结束语音"; else -> "和我说话" }, fontSize = 16.sp)
        }
        IconButton(onClick = onOpenChat, modifier = Modifier.background(Color.White.copy(alpha = 0.7f), CircleShape)) {
          Icon(Icons.AutoMirrored.Filled.ReceiptLong, contentDescription = "结果与记录", tint = AnyLinkInk)
        }
      }
      Text(if (talk) "语音已开启，聊天和做事都在同一段对话里。" else "聊天，或者交给我一件事。", color = Color(0xFF7E9BAC), fontSize = 11.sp)
    }
  }
}
