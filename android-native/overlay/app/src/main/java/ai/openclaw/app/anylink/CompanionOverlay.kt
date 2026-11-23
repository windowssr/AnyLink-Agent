package ai.openclaw.app.anylink

import ai.openclaw.app.ui.AnyLinkPhase
import ai.openclaw.app.ui.AnyLinkPortrait
import android.app.Application
import android.content.Context
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner

/** Floating Live2D companion: a small non-focusable overlay window with tap-to-talk,
 * long-press to open the app and drag-to-move with a bottom hide target. */
internal object CompanionOverlay {
  private const val WIDTH_DP = 120
  private const val HEIGHT_DP = 196
  private var app: Application? = null
  private var windowManager: WindowManager? = null
  private var root: FrameLayout? = null
  private var params: WindowManager.LayoutParams? = null
  private var hideTarget: View? = null
  private var hideTargetRect = android.graphics.Rect()

  private class OverlayLifecycleOwner : LifecycleOwner {
    private val registry = LifecycleRegistry(this)
    init { registry.currentState = Lifecycle.State.RESUMED }
    override val lifecycle: Lifecycle get() = registry
  }

  @Synchronized
  fun show(context: Context): Boolean {
    if (root != null) return true
    val application = context.applicationContext as? Application ?: return false
    app = application
    val runtime = AnyLinkRuntime.get(application)
    val wm = application.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return false
    windowManager = wm
    val density = application.resources.displayMetrics.density
    val width = (WIDTH_DP * density).toInt()
    val height = (HEIGHT_DP * density).toInt()
    val metrics = wm.currentWindowMetrics
    val screenW = metrics.bounds.width(); val screenH = metrics.bounds.height()
    val (savedX, savedY) = runtime.overlayPosition() ?: (null to null)
    val x = (savedX ?: (screenW - width - (16 * density).toInt())).coerceIn(0, (screenW - width).coerceAtLeast(0))
    val y = (savedY ?: (screenH * 0.30).toInt()).coerceIn(0, (screenH - height).coerceAtLeast(0))

    val frame = FrameLayout(application)
    val compose = ComposeView(application)
    compose.setViewCompositionStrategy(androidx.compose.ui.platform.ViewCompositionStrategy.DisposeOnDetachedFromWindow)
    compose.setViewTreeLifecycleOwner(OverlayLifecycleOwner())
    compose.setContent { OverlayContent(runtime) }
    frame.addView(compose, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    val layout = WindowManager.LayoutParams(
      width, height,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START; this.x = x; this.y = y }

    val gestures = OverlayGestures(application, runtime, wm, { frame }, { params }, { hideTargetRect }) { nx, ny ->
      layout.x = nx; layout.y = ny; wm.updateViewLayout(frame, layout)
    }
    frame.setOnTouchListener(gestures.listener)
    try {
      wm.addView(frame, layout)
    } catch (_: Exception) { return false }
    root = frame; params = layout
    return true
  }

  @Synchronized
  fun hide() {
    removeHideTarget()
    root?.let { runCatching { windowManager?.removeView(it) } }
    root = null; params = null; app = null
  }

  private fun removeHideTarget() {
    hideTarget?.let { runCatching { windowManager?.removeView(it) } }
    hideTarget = null
  }

  private fun showHideTarget(context: Context) {
    if (hideTarget != null || app == null) return
    val wm = windowManager ?: return
    val density = context.resources.displayMetrics.density
    val size = (52 * density).toInt()
    val view = TextView(context).apply {
      text = "×"; textSize = 22f; setTextColor(0xFFB3261E.toInt()); gravity = android.view.Gravity.CENTER
      background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(0xCCFFFFFF.toInt()); setStroke((2 * density).toInt(), 0xFFB3261E.toInt()) }
    }
    val params = WindowManager.LayoutParams(size, size, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT).apply { gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; y = (10 * density).toInt() }
    val bounds = wm.currentWindowMetrics.bounds
    hideTargetRect.set(bounds.centerX() - size / 2, bounds.bottom - size - (10 * density).toInt(), bounds.centerX() + size / 2, bounds.bottom - (10 * density).toInt())
    try { wm.addView(view, params) ; hideTarget = view }
    catch (_: Exception) { }
  }

  private class OverlayGestures(
    private val context: Context,
    private val runtime: AnyLinkRuntime,
    private val wm: WindowManager,
    private val view: () -> FrameLayout?,
    private val params: () -> WindowManager.LayoutParams?,
    private val targetRect: () -> android.graphics.Rect,
    private val move: (Int, Int) -> Unit,
  ) {
    private var downX = 0f; private var downY = 0f; private var startParamsX = 0; private var startParamsY = 0
    private var dragging = false; private var longPressed = false; private var downAt = 0L
    private val slop = android.view.ViewConfiguration.get(context).scaledTouchSlop
    private val handler = Handler(Looper.getMainLooper())
    private val longPress = Runnable { if (!dragging && !longPressed) { longPressed = true; runtime.openApp() } }

    val listener = View.OnTouchListener { v, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX; downY = event.rawY; downAt = event.eventTime
          dragging = false; longPressed = false
          startParamsX = params()?.x ?: 0; startParamsY = params()?.y ?: 0
          handler.postDelayed(longPress, 550)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - downX; val dy = event.rawY - downY
          if (!dragging && (kotlin.math.abs(dx) > slop || kotlin.math.abs(dy) > slop)) {
            dragging = true; handler.removeCallbacks(longPress); CompanionOverlay.showHideTarget(context)
          }
          if (dragging) {
            val metrics = wm.currentWindowMetrics
            val w = v.width; val h = v.height
            val nx = (startParamsX + (event.rawX - downX)).toInt().coerceIn(0, (metrics.bounds.width() - w).coerceAtLeast(0))
            val ny = (startParamsY + (event.rawY - downY)).toInt().coerceIn(0, (metrics.bounds.height() - h).coerceAtLeast(0))
            move(nx, ny)
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          handler.removeCallbacks(longPress)
          CompanionOverlay.removeHideTarget()
          if (dragging) {
            val p = params()
            if (p != null) {
              val cx = p.x + v.width / 2; val cy = p.y + v.height / 2
              val rect = targetRect()
              if (rect.contains(cx, cy)) { runtime.dismissOverlay(); return@OnTouchListener true }
              runtime.setOverlayPosition(p.x, p.y)
            }
          } else if (!longPressed && event.eventTime - downAt < 400) {
            runtime.startListening()
          }
          dragging = false
          true
        }
        MotionEvent.ACTION_CANCEL -> { handler.removeCallbacks(longPress); CompanionOverlay.removeHideTarget(); dragging = false; true }
        else -> false
      }
    }
  }

  @Composable
  private fun OverlayContent(runtime: AnyLinkRuntime) {
    val agentState by runtime.agent.collectAsState()
    val local = agentState?.state?.collectAsState()?.value ?: LocalAgentState()
    val listening by runtime.listening.collectAsState()
    val speaking by runtime.speaking.collectAsState()
    val notice by runtime.voiceNotice.collectAsState()
    val phase = when {
      speaking -> AnyLinkPhase.Speaking
      listening -> AnyLinkPhase.Listening
      local.phase == "working" -> AnyLinkPhase.Working
      local.busy -> AnyLinkPhase.Thinking
      local.notice.isNotEmpty() -> AnyLinkPhase.Attention
      else -> AnyLinkPhase.Idle
    }
    val caption = when {
      notice.isNotBlank() -> notice.take(30)
      local.tool.isNotBlank() -> "正在${toolLabel(local.tool)}"
      listening -> "我在听…"
      speaking -> "正在回复"
      else -> phase.caption
    }
    MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF468CAF), background = Color.Transparent)) {
      Box(Modifier.fillMaxSize()) {
        AnyLinkPortrait(phase, local.emotion, local.gesture, local.sequence, safeTopPx = 0, safeBottomPx = 0, mini = true, modifier = Modifier.fillMaxSize())
        Box(
          Modifier.fillMaxSize().padding(bottom = 4.dp),
          contentAlignment = androidx.compose.ui.Alignment.BottomCenter,
        ) {
          androidx.compose.material3.Surface(
            color = Color(0xCCFFFFFF), shape = RoundedCornerShape(10.dp),
          ) {
            androidx.compose.material3.Text(
              caption, fontSize = 10.sp, maxLines = 2,
              modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
          }
        }
      }
    }
  }
}
