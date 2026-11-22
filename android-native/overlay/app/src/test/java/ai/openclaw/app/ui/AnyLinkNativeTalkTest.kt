package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.chat.ChatRealtimeTalkLaunch
import ai.openclaw.app.ui.chat.resolveChatRealtimeTalkLaunch
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AnyLinkNativeTalkTest {
  @Test fun `native split speech needs no realtime account but still requires microphone consent`() {
    assertEquals(ChatRealtimeTalkLaunch.StartTalk, resolveChatRealtimeTalkLaunch(true, true, nativeSpeech = true))
    assertEquals(ChatRealtimeTalkLaunch.RequestPermission, resolveChatRealtimeTalkLaunch(false, true, nativeSpeech = true))
    assertEquals(ChatRealtimeTalkLaunch.ShowSetupMessage, resolveChatRealtimeTalkLaunch(true, true))
  }

  @Test fun `a granted request rebinds visible chat and Talk from another agent to Android node main`() = withRuntime { runtime ->
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    runtime.selectChatAgent("main")
    val previousTalkSession = runtime.mainSessionKey.value
    // The sidebar can reopen Android history without updating Talk's agent.
    runtime.switchChatSession("agent:${BuildConfig.ANYLINK_AGENT_ID}:another-conversation")
    assertEquals(BuildConfig.ANYLINK_AGENT_ID, runtime.chat.sessionOwnerAgentId.value)
    assertEquals(previousTalkSession, runtime.mainSessionKey.value)
    // This is the same runtime operation used after Android's asynchronous grant.
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    assertTrue(runtime.startAnyLinkTalk())
    val target = runtime.mainSessionKey.value
    assertTrue(target.startsWith("agent:${BuildConfig.ANYLINK_AGENT_ID}:node-"))
    assertEquals(target, runtime.chat.sessionKey.value)
    val talk = ReflectionHelpers.getField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
    assertEquals(target, ReflectionHelpers.getField<String>(talk, "mainSessionKey"))
  }

  @Test fun `a denied permission or unavailable Android agent cannot rebind or start Talk`() = withRuntime { runtime ->
    val app = RuntimeEnvironment.getApplication()
    runtime.selectChatAgent("main")
    val original = runtime.mainSessionKey.value
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    assertFalse(runtime.startAnyLinkTalk())
    assertEquals(original, runtime.mainSessionKey.value)
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    ReflectionHelpers.getField<MutableStateFlow<List<GatewayAgentSummary>>>(runtime, "_gatewayAgents").value = emptyList()
    assertFalse(runtime.startAnyLinkTalk())
    assertEquals(original, runtime.mainSessionKey.value)
    assertFalse(runtime.talkModeEnabled.value)
  }

  @Test fun `granting microphone permission after a disconnect does not start or retarget Talk`() = withRuntime { runtime ->
    val app = RuntimeEnvironment.getApplication()
    runtime.selectChatAgent("main")
    val original = runtime.mainSessionKey.value
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    // The permission sheet was opened while connected, but its result arrives later.
    ReflectionHelpers.setField(runtime, "operatorConnected", false)
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    assertFalse(runtime.startAnyLinkTalk())
    assertEquals(original, runtime.mainSessionKey.value)
    assertFalse(runtime.talkModeEnabled.value)
  }

  private fun withRuntime(block: (NodeRuntime) -> Unit) {
    val app = RuntimeEnvironment.getApplication()
    val prefs = SecurePrefs(app, app.getSharedPreferences("anylink-talk-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs)
    try {
      ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
      ReflectionHelpers.setField(runtime, "operatorConnected", true)
      ReflectionHelpers.getField<MutableStateFlow<List<GatewayAgentSummary>>>(runtime, "_gatewayAgents").value =
        listOf("main", BuildConfig.ANYLINK_AGENT_ID).map { GatewayAgentSummary(it, null, null) }
      block(runtime)
    } finally {
      closeNodeRuntimeTestFixture(runtime)
      shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    }
  }
}
