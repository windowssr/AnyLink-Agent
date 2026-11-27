package ai.openclaw.app.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal data class AvatarSignal(val state: String, val message: String)

// evaluateJavascript returns a JSON-encoded string, including the outer quotes.
internal fun parseAvatarSignal(value: String?): AvatarSignal? = runCatching {
  val encoded = Json.parseToJsonElement(value ?: return null) as? JsonPrimitive ?: return null
  val payload = encoded.contentOrNull ?: return null
  val json = Json.parseToJsonElement(payload) as? JsonObject ?: return null
  val state = (json["state"] as? JsonPrimitive)?.contentOrNull ?: return null
  if (state !in setOf("loading", "ready", "failed")) return null
  AvatarSignal(state, (json["message"] as? JsonPrimitive)?.contentOrNull.orEmpty().take(240))
}.getOrNull()

internal class AvatarLoadMonitor(private val timeoutMs: Long = 30_000) {
  private var startedAt = 0L
  private var retries = 0
  val compatible: Boolean get() = retries > 0
  fun start(now: Long) { startedAt = now }
  fun reset() { retries = 0 }
  fun timedOut(now: Long): Boolean = now - startedAt >= timeoutMs
  fun retry(): Boolean = if (retries == 0) { retries++; true } else false
}
