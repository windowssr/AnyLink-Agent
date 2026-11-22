package ai.openclaw.app.ui

/** A projection of the existing chat/Talk owners; this never starts work or capture. */
internal enum class AnyLinkPhase(val wire: String, val caption: String) {
  Idle("idle", "想聊什么，或想让我做点什么？"),
  Listening("listening", "我在听，你说。"),
  Thinking("thinking", "让我想一想…"),
  Working("working", "正在帮你处理…"),
  Speaking("speaking", "正在回复"),
  Attention("attention", "这件事需要你看看"),
}

internal fun anyLinkPhase(
  listening: Boolean,
  speaking: Boolean,
  awaiting: Boolean,
  activeRuns: Int,
  runningTool: Boolean,
  needsAttention: Boolean,
): AnyLinkPhase =
  when {
    speaking -> AnyLinkPhase.Speaking
    needsAttention -> AnyLinkPhase.Attention
    runningTool && activeRuns > 0 -> AnyLinkPhase.Working
    awaiting || activeRuns > 0 -> AnyLinkPhase.Thinking
    listening -> AnyLinkPhase.Listening
    else -> AnyLinkPhase.Idle
  }
