@file:Suppress("DEPRECATION")

package ai.openclaw.app.anylink

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** Phone control surface for the device agent. Node ids are valid only until the
 * next screen() read; every read replaces the reference map. */
class AnyLinkAccessibilityService : AccessibilityService(), PhoneControl {
  private val lock = Any()
  private var nodes = listOf<ScreenNode>()
  private val refs = mutableMapOf<String, AccessibilityNodeInfo>()

  override fun onServiceConnected() {
    super.onServiceConnected()
    PhoneControlBridge.control = this
  }

  override fun onUnbind(intent: Intent?): Boolean {
    if (PhoneControlBridge.control === this) PhoneControlBridge.control = null
    clearRefs()
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    if (PhoneControlBridge.control === this) PhoneControlBridge.control = null
    clearRefs()
    super.onDestroy()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
  override fun onInterrupt() = Unit

  private fun clearRefs() {
    synchronized(lock) { refs.values.forEach { runCatching { it.recycle() } }; refs.clear() }
  }

  // ---- screen ---------------------------------------------------------------

  override fun screen(): JsonObject {
    val own = packageName
    val screenRect = Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
    val found = mutableListOf<ScreenNode>()
    val kept = mutableMapOf<String, AccessibilityNodeInfo>()
    var counter = 0
    var fgPackage = ""
    fun walk(node: AccessibilityNodeInfo, depth: Int, clickA: String?, scrollA: String?, budget: IntArray) {
      if (budget[0] <= 0) return
      budget[0]--
      val id = "n${++counter}"
      val bounds = Rect(); node.getBoundsInScreen(bounds)
      val pkg = node.packageName?.toString().orEmpty()
      val visible = node.isVisibleToUser && bounds.intersect(screenRect)
      val clickable = node.isClickable
      val scrollable = node.isScrollable
      val editable = node.isEditable
      val entry = ScreenNode(
        id = id,
        text = node.text?.toString().orEmpty(),
        desc = node.contentDescription?.toString().orEmpty(),
        cls = node.className?.toString()?.substringAfterLast('.') ?: "",
        pkg = pkg, own = pkg == own, visible = visible, focused = node.isFocused,
        clickable = clickable, editable = editable, scrollable = scrollable,
        checkable = node.isCheckable, checked = node.isChecked,
        bounds = intArrayOf(bounds.left, bounds.top, bounds.right, bounds.bottom),
        depth = depth,
        clickId = if (clickable) id else clickA,
        scrollId = if (scrollable) id else scrollA,
      )
      found += entry
      kept[id] = node
      val childClick = entry.clickId; val childScroll = entry.scrollId
      for (i in 0 until node.childCount) {
        val child = node.getChild(i) ?: continue
        walk(child, depth + 1, childClick, childScroll, budget)
      }
    }
    val windows = runCatching { windows }.getOrNull().orEmpty()
    for (window in windows) {
      if (!window.isActive) continue
      val root = runCatching { window.root }.getOrNull() ?: continue
      if (root.packageName?.toString() == own) { runCatching { root.recycle() }; continue }
      if (fgPackage.isEmpty()) fgPackage = root.packageName?.toString().orEmpty()
      walk(root, 0, null, null, intArrayOf(900))
    }
    if (fgPackage.isEmpty()) fgPackage = runCatching { rootInActiveWindow?.packageName?.toString() }.getOrNull().orEmpty()
    synchronized(lock) {
      refs.values.forEach { runCatching { it.recycle() } }
      refs.clear(); refs.putAll(kept)
      nodes = found
    }
    return PhoneScreenSerializer.serialize(found, own, fgPackage.ifBlank { "android" })
  }

  // ---- actions ---------------------------------------------------------------

  private fun nodeFor(id: String): AccessibilityNodeInfo? = synchronized(lock) { refs[id] }

  private fun gestureTap(x: Float, y: Float): Boolean {
    val path = Path().apply { moveTo(x, y) }
    val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 60)).build()
    return dispatchGesture(gesture, null, null)
  }

  private fun gestureSwipe(x1: Float, y1: Float, x2: Float, y2: Float): Boolean {
    val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
    val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 280)).build()
    return dispatchGesture(gesture, null, null)
  }

  private fun centerOf(node: AccessibilityNodeInfo): Pair<Float, Float>? {
    val b = Rect(); node.getBoundsInScreen(b)
    return if (b.width() > 0 && b.height() > 0) (b.centerX().toFloat() to b.centerY().toFloat()) else null
  }

  override fun tap(id: String?, text: String?, x: Float?, y: Float?): Boolean {
    val snapshot = synchronized(lock) { nodes.toList() }
    return when (val target = PhoneNodeResolver.resolveTap(snapshot, id, text, x, y)) {
      is TapResolution.Node -> {
        val node = nodeFor(target.id)
        val clicked = node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
        if (clicked) true else node?.let { centerOf(it) }?.let { gestureTap(it.first, it.second) } == true
      }
      is TapResolution.Point -> gestureTap(target.x, target.y)
      TapResolution.NotFound -> false
    }
  }

  override fun setText(text: String, id: String?, submit: Boolean): Boolean {
    val snapshot = synchronized(lock) { nodes.toList() }
    val target = PhoneNodeResolver.resolveEditable(snapshot, id) ?: return false
    val node = nodeFor(target.id) ?: return false
    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
    val set = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    if (set && submit) runCatching { node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) }
    return set
  }

  override fun scroll(direction: String, id: String?): Boolean {
    val snapshot = synchronized(lock) { nodes.toList() }
    val metrics = resources.displayMetrics
    val cx = metrics.widthPixels / 2f; val cy = metrics.heightPixels / 2f
    val span = metrics.widthPixels * 0.4f
    val target = PhoneNodeResolver.resolveScrollable(snapshot, id)
    val node = target?.let { nodeFor(it.id) }
    if (node != null) {
      val action = when (direction) {
        "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD
        "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD
        "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT
        else -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT
      }
      if (runCatching { node.performAction(action.id) }.getOrDefault(false)) return true
    }
    // Gesture fallback: finger moves opposite the content direction.
    return when (direction) {
      "up" -> gestureSwipe(cx, cy + span, cx, cy - span)
      "down" -> gestureSwipe(cx, cy - span, cx, cy + span)
      "left" -> gestureSwipe(cx + span, cy, cx - span, cy)
      else -> gestureSwipe(cx - span, cy, cx + span, cy)
    }
  }

  override fun back(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)
  override fun home(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)

  // ---- apps ------------------------------------------------------------------

  private fun launcherApps(): List<LaunchApp> {
    val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val resolved = runCatching { packageManager.queryIntentActivities(intent, 0) }.getOrDefault(emptyList())
    return resolved.mapNotNull { info ->
      val pkg = info.activityInfo?.packageName ?: return@mapNotNull null
      val label = runCatching { info.loadLabel(packageManager).toString() }.getOrDefault(pkg)
      LaunchApp(label, pkg)
    }.distinctBy { it.pkg }
  }

  override fun openApp(query: String): Boolean {
    val app = PhoneApps.match(query, launcherApps()) ?: return false
    val intent = packageManager.getLaunchIntentForPackage(app.pkg) ?: return false
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return runCatching { startActivity(intent) }.isSuccess
  }

  override fun listApps(query: String?): JsonArray {
    val apps = PhoneApps.filter(query, launcherApps())
    return JsonArray(apps.map { buildJsonObject { put("label", it.label.take(80)); put("package", it.pkg) } })
  }
}
