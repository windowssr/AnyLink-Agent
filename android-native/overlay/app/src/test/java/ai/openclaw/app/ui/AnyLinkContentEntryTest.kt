package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AssistantLaunchRequest
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AnyLinkContentEntryTest {
  @get:Rule val compose = createComposeRule()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var viewModel: MainViewModel
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null
  private val store = ViewModelStore()

  @Before fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    NativeStringResources.install(app)
    app.chatShareDraftQueue.clear()
    val prefs = SecurePrefs(app, app.getSharedPreferences("anylink-entry-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    // Chat's upstream screenshot fixture intentionally contains an unanswered
    // question. Use the no-question fixture to test explicit entry from a closed
    // sheet; actual questions correctly open the sheet in the product.
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Browser)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    originalRuntime = app.peekRuntime()
    bindNodeRuntimeTestFixture(app, runtime)
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    viewModel = MainViewModel(app, prefs, SavedStateHandle())
    store.put("anylink-content-entry", viewModel)
    viewModel.enterScreenshotFixtureMode(AndroidScreenshotScene.Browser)
    compose.setContent {
      ClawDesignTheme {
        UnifiedChatShellScreen(viewModel, true, {}, {}, {}, {})
      }
    }
  }

  @After fun tearDown() {
    store.clear()
    bindNodeRuntimeTestFixture(app, originalRuntime)
    closeNodeRuntimeTestFixture(runtime)
    app.chatShareDraftQueue.clear()
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
  }

  @Test fun `assistant prompt opens the original composer from a portrait`() {
    compose.onNodeWithText("回到大肥鱼身边").assertDoesNotExist()
    compose.runOnIdle {
      viewModel.handleAssistantLaunch(AssistantLaunchRequest("app_action", "Review this assistant prompt", false))
    }
    assertComposerText("Review this assistant prompt")
  }

  @Test fun `Android share opens the sheet and imports text without sending it`() {
    compose.onNodeWithText("回到大肥鱼身边").assertDoesNotExist()
    compose.runOnIdle {
      viewModel.handleShareLaunchIntent(
        Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Review this shared text"),
      )
    }
    assertComposerText("Review this shared text")
  }

  private fun assertComposerText(expected: String) {
    compose.waitUntil(timeoutMillis = 5_000) {
      compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isNotEmpty()
    }
    compose.onNodeWithText("回到大肥鱼身边").assertExists()
    compose.waitUntil(timeoutMillis = 5_000) {
      viewModel.chatDraft.value == null && viewModel.chatShareDrafts.value.isEmpty()
    }
    compose.onNode(hasSetTextAction()).assertTextEquals(expected)
  }
}
