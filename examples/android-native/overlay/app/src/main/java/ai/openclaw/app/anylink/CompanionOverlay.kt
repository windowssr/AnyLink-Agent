package ai.openclaw.app.anylink

import ai.openclaw.app.R
import ai.openclaw.app.ui.AnyLinkPhase
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
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner

/** Crash-proof floating companion bubble: attaches Lifecycle + SavedStateRegistry + ViewModelStore
 * so Jetpack Compose never throws ViewTreeSavedStateRegistryOwner missing on backgrounding, and uses
 * a lightweight native avatar badge instead of a second heavy WebGL WebView. */
internal object CompanionOverlay {
  private const val WIDTH_DP = 96
  private const val HEIGHT_DP = 124
  private var app: Application? = null
  private var windowManager: WindowManager? = null
  private var root: FrameLayout? = null
  private var params: WindowManager.LayoutParams? = null
  private var owner: OverlayViewTreeOwner? = null
  private var hideTarget: View? = null
  private var hideTargetRect = android.graphics.Rect()

  private class OverlayViewTreeOwner : LifecycleOwner, SavedStateRegistryOwner, ViewModelStoreOwner {
    private val lifecycleRegistry = LifecycleRegistry(this)
    private val savedStateController = SavedStateRegistryController.create(this)
    override val viewModelStore: ViewModelStore = ViewModelStore()
    override val lifecycle: Lifecycle get() = lifecycleRegistry
    override val savedStateRegistry: SavedStateRegistry get() = savedStateController.savedStateRegistry

    fun start() {
      savedStateController.performAttach()
      savedStateController.performRestore(null)
      lifecycleRegistry.currentState = Lifecycle.State.CREATED
      lifecycleRegistry.currentState = Lifecycle.State.STARTED
      lifecycleRegistry.currentState = Lifecycle.State.RESUMED
    }

    fun destroy() {
      runCatching { lifecycleRegistry.currentState = Lifecycle.State.DESTROYED }
      runCatching { viewModelStore.clear() }
    }
  }

  @Synchronized
  fun show(context: Context): Boolean = runCatching {
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
    val x = (savedX ?: (screenW - width - (12 * density).toInt())).coerceIn(0, (screenW - width).coerceAtLeast(0))
    val y = (savedY ?: (screenH * 0.28).toInt()).coerceIn(0, (screenH - height).coerceAtLeast(0))

    val viewTreeOwner = OverlayViewTreeOwner().also { it.start() }
    val frame = FrameLayout(application).apply {
      setViewTreeLifecycleOwner(viewTreeOwner)
      setViewTreeSavedStateRegistryOwner(viewTreeOwner)
      setViewTreeViewModelStoreOwner(viewTreeOwner)
    }
    val compose = ComposeView(application).apply {
      setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
      setViewTreeLifecycleOwner(viewTreeOwner)
      setViewTreeSavedStateRegistryOwner(viewTreeOwner)
      setViewTreeViewModelStoreOwner(viewTreeOwner)
      setContent { OverlayContent(runtime) }
    }
    frame.addView(compose, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    val layout = WindowManager.LayoutParams(
      width, height,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START; this.x = x; this.y = y }

    val gestures = OverlayGestures(application, runtime, wm, { params }, { hideTargetRect }) { nx, ny ->
      layout.x = nx; layout.y = ny; runCatching { wm.updateViewLayout(frame, layout) }
    }
    frame.setOnTouchListener(gestures.listener)
    wm.addView(frame, layout)
    root = frame; params = layout; owner = viewTreeOwner
    true
  }.getOrElse {
    hide()
    false
  }

  @Synchronized
  fun hide() {
    removeHideTarget()
    root?.let { runCatching { windowManager?.removeView(it) } }
    owner?.destroy()
    root = null; params = null; owner = null; app = null
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
      text = "×"; textSize = 22f; setTextColor(0xFFB3261E.toInt()); gravity = Gravity.CENTER
      background = android.graphics.drawable.GradientDrawable().apply {
        shape = android.graphics.drawable.GradientDrawable.OVAL
        setColor(0xCCFFFFFF.toInt())
        setStroke((2 * density).toInt(), 0xFFB3261E.toInt())
      }
    }
    val lp = WindowManager.LayoutParams(
      size, size, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; y = (16 * density).toInt() }
    val bounds = wm.currentWindowMetrics.bounds
    hideTargetRect.set(bounds.centerX() - size / 2, bounds.bottom - size - (16 * density).toInt(), bounds.centerX() + size / 2, bounds.bottom - (16 * density).toInt())
    runCatching { wm.addView(view, lp); hideTarget = view }
  }

  private class OverlayGestures(
    private val context: Context,
    private val runtime: AnyLinkRuntime,
    private val wm: WindowManager,
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
          handler.postDelayed(longPress, 500)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - downX; val dy = event.rawY - downY
          if (!dragging && (kotlin.math.abs(dx) > slop || kotlin.math.abs(dy) > slop)) {
            dragging = true; handler.removeCallbacks(longPress); CompanionOverlay.showHideTarget(context)
          }
          if (dragging) {
            val metrics = wm.currentWindowMetrics
            val nx = (startParamsX + (event.rawX - downX)).toInt().coerceIn(0, (metrics.bounds.width() - v.width).coerceAtLeast(0))
            val ny = (startParamsY + (event.rawY - downY)).toInt().coerceIn(0, (metrics.bounds.height() - v.height).coerceAtLeast(0))
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
              if (targetRect().contains(cx, cy)) { runtime.dismissOverlay(); return@OnTouchListener true }
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
    val wsOnline by runtime.wsOnline.collectAsState()
    val notice by runtime.voiceNotice.collectAsState()
    val phase = when {
      speaking -> AnyLinkPhase.Speaking
      listening -> AnyLinkPhase.Listening
      local.phase == "working" -> AnyLinkPhase.Working
      local.busy -> AnyLinkPhase.Thinking
      local.notice.isNotEmpty() -> AnyLinkPhase.Attention
      else -> AnyLinkPhase.Idle
    }
    val ringColor = when {
      listening -> Color(0xFF10B981)
      speaking || local.busy -> Color(0xFF38BDF8)
      wsOnline -> Color(0xFF468CAF)
      else -> Color(0xFF94A3B8)
    }
    val caption = when {
      listening -> "在听…"
      speaking -> "回复中"
      local.tool.isNotBlank() -> toolLabel(local.tool).take(8)
      notice.isNotBlank() -> notice.take(10)
      wsOnline -> "在线"
      else -> phase.caption.take(8)
    }
    MaterialTheme(colorScheme = DeepSeaColorScheme) {
      OverlayBubbleCard(ringColor = ringColor, caption = caption)
    }
  }
}

@Composable
internal fun OverlayBubbleCard(ringColor: Color, caption: String) {
  Column(
    Modifier.fillMaxSize().padding(4.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
  ) {
    Box(
      Modifier.size(72.dp)
        .clip(CircleShape)
        .background(Color(0xE6EAF6FD))
        .border(3.dp, ringColor, CircleShape)
        .padding(3.dp),
      contentAlignment = Alignment.Center,
    ) {
      Image(
        painter = painterResource(R.drawable.anylink_avatar),
        contentDescription = "大肥鱼悬浮球",
        contentScale = ContentScale.Crop,
        modifier = Modifier.fillMaxSize().clip(CircleShape),
      )
    }
    Surface(color = Color(0xEB0F2940), shape = RoundedCornerShape(10.dp)) {
      Text(
        caption, color = Color.White, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
      )
    }
  }
}
