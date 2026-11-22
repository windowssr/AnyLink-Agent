package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.chat.rememberChatRealtimeTalkLauncher
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.window.layout.DisplayFeature

/** The original Chat/Talk owners stay intact; the character is their main surface. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun UnifiedChatShellScreen(
  viewModel: MainViewModel,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onOpenDashboard: (String) -> Unit,
  onOpenGatewaySettings: () -> Unit,
  onOpenProvidersModels: () -> Unit,
  tabletopPanes: TabletopPaneBounds? = null,
  features: List<DisplayFeature> = emptyList(),
) {
  var records by rememberSaveable { mutableStateOf(false) }
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val draft by viewModel.chatDraft.collectAsState()
  val shares by viewModel.chatShareDrafts.collectAsState()
  val assistantRequest by viewModel.pendingAssistantAutoSend.collectAsState()
  // These explicit entry points need the original composer to stage content for
  // review. ChatScreen retains ownership of importing, consuming and sending it.
  LaunchedEffect(draft, shares, assistantRequest) {
    if (draft != null || shares.isNotEmpty() || assistantRequest != null) records = true
  }
  // Our Gateway uses stt-tts: Android speech recognition + the same DeepSeek
  // agent + Gateway speech. It does not need a realtime speech-model account.
  val startTalk = rememberChatRealtimeTalkLauncher(viewModel, nativeSpeech = true)
  val toggleTalk = { if (talkModeEnabled) viewModel.setTalkModeEnabled(false) else startTalk() }
  LaunchedEffect(viewModel) { viewModel.refreshTalkSetupReadiness() }
  AnyLinkCompanionScreen(viewModel, toggleTalk, { records = true }, onOpenSidebar, onOpenGatewaySettings)
  if (records) {
    AppModalBottomSheet(
      onDismissRequest = { records = false },
      sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
      containerColor = MaterialTheme.colorScheme.surface,
      contentColor = MaterialTheme.colorScheme.onSurface,
      modifier = Modifier.fillMaxHeight(0.94f),
    ) {
      TextButton(onClick = { records = false }) { Text("回到大肥鱼身边") }
      Box(Modifier.weight(1f)) {
        ChatScreen(
          viewModel = viewModel,
          talkActive = talkModeEnabled,
          showSidebarButton = showSidebarButton,
          onOpenSidebar = onOpenSidebar,
          onToggleTalk = toggleTalk,
          onOpenDashboard = onOpenDashboard,
          onOpenGatewaySettings = onOpenGatewaySettings,
          onOpenProvidersModels = onOpenProvidersModels,
          tabletopPanes = tabletopPanes,
          features = features,
        )
      }
    }
  }
}
