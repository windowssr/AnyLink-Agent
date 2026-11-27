package ai.openclaw.app.ui

import ai.openclaw.app.R
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
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
import androidx.compose.runtime.LaunchedEffect
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private fun mimeForAsset(path: String): Pair<String, String?> = when {
  path.endsWith(".html", ignoreCase = true) -> "text/html" to "UTF-8"
  path.endsWith(".js", ignoreCase = true) -> "application/javascript" to "UTF-8"
  path.endsWith(".json", ignoreCase = true) -> "application/json" to "UTF-8"
  path.endsWith(".css", ignoreCase = true) -> "text/css" to "UTF-8"
  path.endsWith(".svg", ignoreCase = true) -> "image/svg+xml" to "UTF-8"
  path.endsWith(".png", ignoreCase = true) -> "image/png" to null
  path.endsWith(".jpg", ignoreCase = true) || path.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg" to null
  path.endsWith(".webp", ignoreCase = true) -> "image/webp" to null
  path.endsWith(".wasm", ignoreCase = true) -> "application/wasm" to null
  path.endsWith(".moc3", ignoreCase = true) -> "application/octet-stream" to null
  else -> "application/octet-stream" to null
}

private fun openBundledAsset(context: Context, rawPath: String): WebResourceResponse {
  // Use Uri.decode (RFC 3986) rather than URLDecoder so '+' in filenames is never turned into spaces.
  val decoded = runCatching { Uri.decode(rawPath) }.getOrDefault(rawPath)
  val rel = decoded.removePrefix("/assets/").trimStart('/')
  if (!rel.startsWith("anylink/") || rel.contains("..")) {
    Log.w(TAG, "blocked asset path: $rel")
    return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
  }
  val stream = runCatching { context.assets.open(rel) }.getOrNull()
  if (stream == null) {
    Log.w(TAG, "missing bundled asset (404): $rel")
    return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
  }
  val (mime, encoding) = mimeForAsset(rel)
  val headers = mapOf(
    "Access-Control-Allow-Origin" to "https://appassets.androidplatform.net",
    "Cache-Control" to "no-store",
  )
  return WebResourceResponse(mime, encoding, 200, "OK", headers, stream)
}

@SuppressLint("SetJavaScriptEnabled") // Only the bundled, keyless Live2D view runs JavaScript.
@Composable
internal fun AnyLinkPortrait(
  phase: AnyLinkPhase,
  emotion: String,
  gesture: String?,
  sequence: String?,
  audioLevel: Float = 0f,
  safeTopPx: Int = 0,
  safeBottomPx: Int = 0,
  mini: Boolean = false,
  reloadTrigger: Int = 0,
  onStatusChange: (String) -> Unit = {},
  modifier: Modifier = Modifier,
) {
  var web by remember { mutableStateOf<WebView?>(null) }
  var ready by remember { mutableStateOf(false) }
  var webFailed by remember { mutableStateOf(false) }
  var paused by remember { mutableStateOf(false) }
  var webEpoch by remember { mutableIntStateOf(0) }
  var autoReloaded by remember { mutableStateOf(false) }
  val animationsEnabled = rememberSystemAnimationsEnabled()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val statusCallback by rememberUpdatedState(onStatusChange)
  val payload =
    buildJsonObject {
      put("phase", phase.wire)
      put("emotion", emotion)
      put("gesture", gesture ?: "none")
      put("sequence", sequence ?: "")
      put("level", audioLevel.coerceIn(0f, 1f))
      put("paused", paused)
      put("reducedMotion", !animationsEnabled)
      put("safeTop", safeTopPx)
      put("safeBottom", safeBottomPx)
      put("mini", mini)
    }.toString()
  val currentPayload by rememberUpdatedState(payload)

  LaunchedEffect(reloadTrigger) {
    if (reloadTrigger > 0) {
      ready = false
      webFailed = false
      autoReloaded = false
      webEpoch++
      statusCallback("正在重新初始化 Live2D WebView…")
    }
  }

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
        if (view != null && !webFailed && !autoReloaded) view.postDelayed({
          if (web === view && !ready && !webFailed && !autoReloaded) {
            autoReloaded = true
            Log.w(TAG, "avatar not ready 25s after resume; reloading once")
            statusCallback("加载超时，正在自动重试一次…")
            view.reload()
          }
        }, 25_000)
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
    // Full-bleed hardware-accelerated WebView: never clip with RoundedCornerShape, start at alpha(0f),
    // or cover with an opaque full-screen layer (which causes Android Chromium to throttle WebGL rAF).
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
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                  val uri = request.url
                  // Let WebView handle inline data: and blob: URLs natively (used by Pixi ImageBitmap/Blob & Cubism).
                  if (uri.scheme == "data" || uri.scheme == "blob") return null
                  if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/assets/anylink/") == true) {
                    return openBundledAsset(context, uri.encodedPath ?: uri.path.orEmpty())
                  }
                  Log.w(TAG, "blocked request: ${uri.scheme}://${uri.host}${uri.path}")
                  return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                  val desc = "${error.errorCode}: ${error.description} (${request.url.lastPathSegment})"
                  Log.w(TAG, "web error: $desc")
                  if (request.isForMainFrame) statusCallback("WebView 加载失败：$desc")
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                  val desc = "HTTP ${errorResponse.statusCode} (${request.url.lastPathSegment})"
                  Log.w(TAG, "http error: $desc")
                  statusCallback("资源加载异常：$desc")
                }

                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                  Log.w(TAG, "render process gone didCrash=${detail.didCrash()}; recreating WebView")
                  ready = false
                  statusCallback("WebView 渲染进程已重启（crash=${detail.didCrash()}）")
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
                      statusCallback("Live2D 已就绪")
                      evaluateJavascript("window.anylinkMobileAvatar?.update($currentPayload)", null)
                    }
                    text.startsWith("ANYLINK_AVATAR_STAGE:") -> {
                      statusCallback(text.removePrefix("ANYLINK_AVATAR_STAGE:").trim())
                    }
                    text.startsWith("ANYLINK_AVATAR_WARN:") -> {
                      Log.w(TAG, text)
                    }
                    text == "ANYLINK_AVATAR_CONTEXT_LOST" -> {
                      ready = false
                      statusCallback("WebGL 上下文丢失，等待恢复…")
                    }
                    text.startsWith("ANYLINK_AVATAR_FAILED") -> {
                      ready = false
                      webFailed = true
                      statusCallback("已回退静态头像（${text.removePrefix("ANYLINK_AVATAR_FAILED:").trim().ifBlank { "未知错误" }}）")
                    }
                  }
                  return true
                }

                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
              }
              statusCallback("正在加载 Live2D 引擎与模型…")
              loadUrl("https://appassets.androidplatform.net/assets/anylink/portrait.html")
            }
          },
          update = { if (ready) it.evaluateJavascript("window.anylinkMobileAvatar?.update($payload)", null) },
        )
      }
    }

    // Native animated portrait fallback: sits centered WITHOUT an opaque full-screen backdrop so Android Chromium
    // never marks the underlying WebView as occluded or throttles WebGL rendering, and fades out once Live2D is ready.
    AnimatedVisibility(
      visible = !ready || webFailed,
      enter = fadeIn(tween(220)),
      exit = fadeOut(tween(380)),
      modifier = Modifier.padding(top = if (mini) 86.dp else 104.dp),
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

private const val TAG = "AnyLinkAvatar"
