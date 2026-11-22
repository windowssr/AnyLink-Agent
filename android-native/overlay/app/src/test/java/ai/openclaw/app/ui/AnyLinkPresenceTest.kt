package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class AnyLinkPresenceTest {
  @Test fun `speaking follows native playback while work takes priority over microphone readiness`() {
    assertEquals(AnyLinkPhase.Speaking, anyLinkPhase(true, true, false, 1, true, false))
    assertEquals(AnyLinkPhase.Working, anyLinkPhase(true, false, true, 1, true, false))
    assertEquals(AnyLinkPhase.Thinking, anyLinkPhase(true, false, true, 1, false, false))
    assertEquals(AnyLinkPhase.Listening, anyLinkPhase(true, false, false, 0, false, false))
  }

  @Test fun `completed tool history never keeps companion busy and a real question requires attention`() {
    assertEquals(AnyLinkPhase.Idle, anyLinkPhase(false, false, false, 0, true, false))
    assertEquals(AnyLinkPhase.Attention, anyLinkPhase(false, false, false, 0, false, true))
    assertEquals(AnyLinkPhase.Idle, anyLinkPhase(false, false, false, 0, false, false))
  }
}
