package ai.openclaw.app.anylink

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** One walked accessibility node. Resolver fields (clickId/scrollId) stay
 * out of the wire JSON; the serializer emits only the spec shape. */
internal data class ScreenNode(
  val id: String,
  val text: String,
  val desc: String,
  val cls: String,
  val pkg: String,
  val own: Boolean,
  val visible: Boolean,
  val focused: Boolean,
  val clickable: Boolean,
  val editable: Boolean,
  val scrollable: Boolean,
  val checkable: Boolean,
  val checked: Boolean,
  val bounds: IntArray,
  val depth: Int,
  val clickId: String?,
  val scrollId: String?,
) {
  val centerX get() = (bounds[0] + bounds[2]) / 2f
  val centerY get() = (bounds[1] + bounds[3]) / 2f
  override fun equals(other: Any?) = other is ScreenNode && other.id == id && other.bounds.contentEquals(bounds)
  override fun hashCode() = id.hashCode() * 31 + bounds.contentHashCode()
}

internal object PhoneScreenSerializer {
  const val MAX_NODES = 150
  const val MAX_BYTES = 12 * 1024

  fun serialize(nodes: List<ScreenNode>, ownPackage: String, packageName: String, maxNodes: Int = MAX_NODES, maxBytes: Int = MAX_BYTES): JsonObject {
    val candidates = nodes.filter { it.visible && !it.own && it.pkg != ownPackage }
    fun nodeJson(node: ScreenNode) = buildJsonObject {
      put("id", node.id)
      if (node.text.isNotBlank()) put("text", node.text.take(200))
      if (node.desc.isNotBlank()) put("desc", node.desc.take(200))
      put("cls", node.cls.take(60))
      put("clickable", node.clickable)
      put("editable", node.editable)
      put("scrollable", node.scrollable)
      if (node.checkable) put("checked", node.checked)
      putJsonArray("bounds") { for (v in node.bounds) add(JsonPrimitive(v)) }
    }
    val kept = mutableListOf<JsonObject>()
    var truncated = candidates.size > maxNodes
    for (node in candidates.take(maxNodes)) {
      val entry = nodeJson(node)
      val probe = buildJsonObject {
        put("package", packageName)
        putJsonArray("nodes") { kept.forEach { add(it) }; add(entry) }
        put("truncated", true)
      }
      if (probe.toString().toByteArray(Charsets.UTF_8).size > maxBytes) { truncated = true; break }
      kept += entry
    }
    if (kept.size < candidates.take(maxNodes).size) truncated = true
    return buildJsonObject {
      put("package", packageName)
      putJsonArray("nodes") { kept.forEach { add(it) } }
      put("truncated", truncated)
    }
  }
}

internal sealed interface TapResolution {
  data class Node(val id: String) : TapResolution
  data class Point(val x: Float, val y: Float) : TapResolution
  object NotFound : TapResolution
}

internal object PhoneNodeResolver {
  private fun byId(nodes: List<ScreenNode>, id: String) = nodes.firstOrNull { it.id == id && it.visible }

  /** id wins over text over coordinates; exactly one is expected but any subset resolves deterministically. */
  fun resolveTap(nodes: List<ScreenNode>, id: String?, text: String?, x: Float?, y: Float?): TapResolution {
    val target = when {
      !id.isNullOrBlank() -> byId(nodes, id) ?: return TapResolution.NotFound
      !text.isNullOrBlank() -> nodes.firstOrNull { it.visible && (it.text.contains(text, ignoreCase = true) || it.desc.contains(text, ignoreCase = true)) } ?: return TapResolution.NotFound
      x != null && y != null -> return TapResolution.Point(x, y)
      else -> return TapResolution.NotFound
    }
    target.clickId?.let { return TapResolution.Node(it) }
    return TapResolution.Point(target.centerX, target.centerY)
  }

  /** Given id must resolve to an editable node or one of its descendants; otherwise the focused/first editable is used. */
  fun resolveEditable(nodes: List<ScreenNode>, id: String?): ScreenNode? {
    if (!id.isNullOrBlank()) {
      val node = byId(nodes, id) ?: return null
      if (node.editable) return node
      val start = nodes.indexOf(node)
      for (i in start + 1 until nodes.size) {
        val child = nodes[i]
        if (child.depth <= node.depth) break
        if (child.editable && child.visible) return child
      }
      return null
    }
    return nodes.firstOrNull { it.visible && it.editable && it.focused }
      ?: nodes.firstOrNull { it.visible && it.editable }
  }

  fun resolveScrollable(nodes: List<ScreenNode>, id: String?): ScreenNode? {
    if (!id.isNullOrBlank()) {
      val node = byId(nodes, id) ?: return null
      node.scrollId?.let { sid -> nodes.firstOrNull { it.id == sid && it.visible }?.let { return it } }
      return if (node.scrollable) node else nodes.firstOrNull { it.visible && it.scrollable }
    }
    return nodes.firstOrNull { it.visible && it.scrollable && it.focused }
      ?: nodes.firstOrNull { it.visible && it.scrollable }
  }
}

internal data class LaunchApp(val label: String, val pkg: String)

internal object PhoneApps {
  private fun normalize(value: String) = value.trim().lowercase()

  /** exact label > exact package > label contains > package contains; null when nothing matches. */
  fun match(query: String, apps: List<LaunchApp>): LaunchApp? {
    val q = normalize(query)
    if (q.isEmpty()) return null
    return apps.firstOrNull { normalize(it.label) == q }
      ?: apps.firstOrNull { it.pkg.equals(query.trim(), ignoreCase = true) }
      ?: apps.firstOrNull { normalize(it.label).contains(q) }
      ?: apps.firstOrNull { it.pkg.lowercase().contains(q) }
  }

  fun filter(query: String?, apps: List<LaunchApp>, limit: Int = 80): List<LaunchApp> {
    val q = query?.let(::normalize)?.takeIf { it.isNotEmpty() } ?: return apps.take(limit)
    return apps.filter { normalize(it.label).contains(q) || it.pkg.lowercase().contains(q) }.take(limit)
  }
}
