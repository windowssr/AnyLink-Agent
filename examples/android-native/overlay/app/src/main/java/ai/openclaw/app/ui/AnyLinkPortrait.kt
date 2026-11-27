package ai.openclaw.app.ui

import ai.openclaw.app.R
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color as AndroidColor
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.ByteArrayInputStream
import java.net.URLDecoder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private fun mimeForAsset(path: String): String = when {
  path.endsWith(".html", ignoreCase = true) -> "text/html"
  path.endsWith(".js", ignoreCase = true) -> "application/javascript"
  path.endsWith(".json", ignoreCase = true) -> "application/json"
  path.endsWith(".png", ignoreCase = true) -> "image/png"
  path.endsWith(".jpg", ignoreCase = true) || path.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg"
  path.endsWith(".svg", ignoreCase = true) -> "image/svg+xml"
  path.endsWith(".css", ignoreCase = true) -> "text/css"
  path.endsWith(".moc3", ignoreCase = true) -> "application/octet-stream"
  else -> "application/octet-stream"
}

private fun openBundledAsset(context: Context, rawPath: String): WebResourceResponse {
  val decoded = runCatching { URLDecoder.decode(rawPath, "UTF-8") }.getOrDefault(rawPath)
  val rel = decoded.removePrefix("/assets/").trimStart('/')
  if (!rel.startsWith("anylink/") || rel.contains("..")) {
    return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
  }
  val stream = runCatching { context.assets.open(rel) }.getOrNull()
    ?: return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
  val headers = mapOf(
    "Access-Control-Allow-Origin" to "https://appassets.androidplatform.net",
    "Cache-Control" to "no-store",
  )
  return WebResourceResponse(mimeForAsset(rel), "UTF-8", 200, "OK", headers, stream)
}

@SuppressLint("SetJavaScriptEnabled") // Only the bundled, keyless Live2D view runs JavaScript.
@Composable
internal fun AnyLinkPortrait(
  phase: AnyLinkPhase,
  emotion: String,
  gesture: String?,
  sequence: String?,
  safeTopPx: Int = 0,
  safeBottomPx: Int = 0,
  mini: Boolean = false,
  modifier: Modifier = Modifier,
) {
  var web by remember { mutableStateOf<WebView?>(null) }
  var ready by remember { mutableStateOf(false) }
  var webFailed by remember { mutableStateOf(false) }
  var paused by remember { mutableStateOf(false) }
  var webEpoch by remember { mutableIntStateOf(0) }
  val animationsEnabled = rememberSystemAnimationsEnabled()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val payload =
    buildJsonObject {
      put("phase", phase.wire)
      put("emotion", emotion)
      put("gesture", gesture ?: "none")
      put("sequence", sequence ?: "")
      put("paused", paused)
      put("reducedMotion", !animationsEnabled)
      put("safeTop", safeTopPx)
      put("safeBottom", safeBottomPx)
      put("mini", mini)
    }.toString()
  val currentPayload by rememberUpdatedState(payload)

  DisposableEffect(lifecycle) {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
        paused = true
        web?.evaluateJavascript("window.anylinkMobileAvatar?.update({phase:'idle',paused:true})", null)
        web?.onPause()
      } else if (event == Lifecycle.Event.ON_RESUME) {
        paused = false
        web?.onResume()
        val view = web
        if (view != null && !webFailed) view.postDelayed({
          if (web === view && !ready && !webFailed) {
            Log.w(TAG, "avatar not ready 8s after resume; reloading")
            view.reload()
          }
        }, 8000)
      }
    }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }

  val infinite = rememberInfiniteTransition(label = "avatar-breathe")
  val bobDp by infinite.animateFloat(
    initialValue = -3f,
    targetValue = 3f,
    animationSpec = infiniteRepeatable(tween(2600, easing = FastOutSlowInEasing), RepeatMode.Reverse),
    label = "bob",
  )
  val pulseScale by infinite.animateFloat(
    initialValue = 0.985f,
    targetValue = 1.022f,
    animationSpec = infiniteRepeatable(tween(if (phase == AnyLinkPhase.Speaking) 440 else 2400, easing = FastOutSlowInEasing), RepeatMode.Reverse),
    label = "pulse",
  )

  Box(modifier, contentAlignment = Alignment.TopCenter) {
    // Full-bleed hardware-accelerated WebView: never clip with RoundedCornerShape or start at alpha(0f),
    // which prevents Android Chromium WebGL layer compositing bugs on transparent canvases.
    if (!webFailed) {
      key(webEpoch) {
        DisposableEffect(webEpoch) {
          onDispose { web?.stopLoading(); web?.destroy(); web = null }
        }
        AndroidView(
          modifier = Modifier.fillMaxSize(),
          factory = { context ->
            WebView(context).apply {
              web = this
              isFocusable = false
              setBackgroundColor(AndroidColor.TRANSPARENT)
              settings.javaScriptEnabled = true
              settings.domStorageEnabled = false
              settings.allowFileAccess = false
              settings.allowContentAccess = false
              // Keep exact CSS dp viewport (do NOT set useWideViewPort/loadWithOverviewMode which inflate innerWidth to 980px).
              settings.useWideViewPort = false
              settings.loadWithOverviewMode = false
              settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
              settings.mediaPlaybackRequiresUserGesture = true
              webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                  val uri = request.url
                  if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/assets/anylink/") == true) {
                    return openBundledAsset(context, uri.encodedPath ?: uri.path.orEmpty())
                  }
                  return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                  Log.w(TAG, "render process gone didCrash=${detail.didCrash()}; recreating WebView")
                  ready = false
                  if (webEpoch < 2) webEpoch++ else webFailed = true
                  return true
                }
              }
              webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                  val text = message.message().orEmpty()
                  Log.i(TAG, "console: ${text.take(400)}")
                  when {
                    text == "ANYLINK_AVATAR_READY" -> {
                      ready = true
                      evaluateJavascript("window.anylinkMobileAvatar?.update($currentPayload)", null)
                    }
                    text == "ANYLINK_AVATAR_CONTEXT_LOST" -> {
                      ready = false
                    }
                    text.startsWith("ANYLINK_AVATAR_FAILED") -> {
                      ready = false
                      webFailed = true
                    }
                  }
                  return true
                }

                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
              }
              loadUrl("https://appassets.androidplatform.net/assets/anylink/portrait.html")
            }
          },
          update = { if (ready) it.evaluateJavascript("window.anylinkMobileAvatar?.update($payload)", null) },
        )
      }
    }

    // Native animated portrait fallback: stays smoothly visible on top until Live2D verifies real rendered pixels,
    // and smoothly re-appears if WebGL loses context or fails, so the character NEVER flashes and disappears.
    AnimatedVisibility(
      visible = !ready || webFailed,
      enter = fadeIn(tween(220)),
      exit = fadeOut(tween(380)),
      modifier = Modifier.fillMaxSize(),
    ) {
      Box(
        modifier = Modifier
          .fillMaxSize()
          .background(Brush.verticalGradient(listOf(Color(0xFFF6FCFF), Color(0xFFDDF1FC), Color(0xFFBFE3F6))))
          .padding(top = if (mini) 86.dp else 104.dp),
        contentAlignment = Alignment.TopCenter,
      ) {
        val ringBrush = Brush.radialGradient(
          colors = listOf(Color(0x668ED8F8), Color(0x22468CAF), Color.Transparent),
        )
        Box(
          modifier = Modifier
            .size(if (mini) 84.dp else 212.dp)
            .graphicsLayer {
              translationY = if (animationsEnabled) bobDp * density else 0f
              val s = if (animationsEnabled) pulseScale else 1f
              scaleX = s; scaleY = s
            }
            .background(ringBrush, CircleShape)
            .padding(if (mini) 8.dp else 16.dp),
          contentAlignment = Alignment.Center,
        ) {
          Image(
            painter = painterResource(R.drawable.anylink_avatar),
            contentDescription = "大肥鱼形象",
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize().clip(CircleShape),
          )
        }
      }
    }
  }
}

private const val TAG = "AnyLinkAvatar"
