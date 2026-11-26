package ai.openclaw.app.ui

internal enum class AnyLinkPhase(val wire: String, val caption: String) {
  Idle("idle", "想聊什么，或想让我做点什么？"),
  Listening("listening", "我在听，你说。"),
  Thinking("thinking", "让我想一想…"),
  Working("working", "正在帮你处理…"),
  Speaking("speaking", "正在回复"),
  Attention("attention", "这件事需要你看看"),
}
