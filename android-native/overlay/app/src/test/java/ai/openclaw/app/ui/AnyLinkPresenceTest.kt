package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionRecord
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

  @Test fun `only a pending question for the selected conversation requests companion attention`() {
    val session = "agent:anylink-android-preview:node-test"
    val prompt = ChatQuestionPrompt(
      QuestionRecord(
        id = "current-question",
        questions = listOf(Question(questionId = "choice", header = "Choice", question = "Continue?", options = emptyList())),
        agentId = "anylink-android-preview",
        sessionKey = session,
        createdAtMs = 1_000,
        expiresAtMs = Long.MAX_VALUE,
        status = "pending",
      ),
    )
    fun phase(question: ChatQuestionPrompt): AnyLinkPhase = anyLinkPhase(
      false, false, false, 0, false,
      anyLinkPendingQuestions(listOf(question), session, session, "anylink-android-preview").isNotEmpty(),
    )
    assertEquals(AnyLinkPhase.Attention, phase(prompt))
    assertEquals(AnyLinkPhase.Idle, phase(prompt.copy(record = prompt.record.copy(sessionKey = "agent:anylink-android-preview:elsewhere"))))
    assertEquals(AnyLinkPhase.Idle, phase(prompt.copy(record = prompt.record.copy(agentId = "main"))))
    assertEquals(AnyLinkPhase.Idle, phase(prompt.copy(record = prompt.record.copy(status = "answered"))))
    assertEquals(AnyLinkPhase.Idle, phase(prompt.copy(record = prompt.record.copy(expiresAtMs = 0))))
    assertEquals(AnyLinkPhase.Idle, phase(prompt.copy(submitting = true)))
  }
}
