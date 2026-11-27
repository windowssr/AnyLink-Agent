package ai.openclaw.app.ui

import ai.openclaw.app.R
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.view.ViewGroup
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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.ByteArrayInputStream
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
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

internal fun openBundledAsset(context: Context, rawPath: String): WebResourceResponse {
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
  call: Boolean = false,
  reloadTrigger: Int = 0,
  onStatusChange: (String) -> Unit = {},
  modifier: Modifier = Modifier,
) {
  var web by remember { mutableStateOf<WebView?>(null) }
  var ready by remember { mutableStateOf(false) }
  var webFailed by remember { mutableStateOf(false) }
  var paused by remember { mutableStateOf(false) }
  var webEpoch by remember { mutableIntStateOf(0) }
  var restarting by remember { mutableStateOf(false) }
  val monitor = remember(reloadTrigger) { AvatarLoadMonitor() }
  val context = LocalContext.current
  val privateCharacter = remember(context) {
    runCatching { context.assets.open("anylink/character-mode.json").bufferedReader().use { org.json.JSONObject(it.readText()).optBoolean("private_character") } }.getOrDefault(false)
  }
  var status by remember { mutableStateOf("正在加载形象…") }
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
      put("call", call)
    }.toString()
  val currentPayload by rememberUpdatedState(payload)

  fun report(message: String) {
    status = message
    statusCallback(message)
  }

  fun failed(view: WebView, reason: String) {
    if (web !== view || webFailed || restarting) return
    ready = false
    if (monitor.retry()) {
      restarting = true
      report("${reason.take(180)}；正在以兼容模式重试…")
      webEpoch++
    } else {
      webFailed = true
      report("形象加载失败：${reason.take(200)}")
    }
  }

  fun receive(view: WebView, signal: AvatarSignal) {
    if (web !== view || webFailed || restarting) return
    when (signal.state) {
      "ready" -> if (!ready) {
        ready = true
        report(if (privateCharacter) "Live2D 已就绪" else "公开版形象已就绪")
        view.evaluateJavascript("window.anylinkMobileAvatar?.update($currentPayload)", null)
      }
      "loading" -> if (!ready && signal.message.isNotBlank() && signal.message != status) report(signal.message)
      "failed" -> failed(view, signal.message.ifBlank { "脚本执行失败" })
    }
  }

  // Start with the actual WebView, not ON_RESUME: Compose can create the view after that event.
  // Poll a keyless presentation snapshot as well as listening to console messages (OEM WebViews differ).
  LaunchedEffect(web, paused, ready, webEpoch) {
    val view = web ?: return@LaunchedEffect
    if (paused || ready || webFailed) return@LaunchedEffect
    monitor.start(SystemClock.elapsedRealtime())
    while (isActive && web === view && !ready && !webFailed) {
      val encoded = withTimeoutOrNull(1500) {
        suspendCancellableCoroutine<String?> { continuation ->
          view.evaluateJavascript("JSON.stringify(window.anylinkAvatarStatus || null)") { value ->
            if (continuation.isActive) continuation.resume(value)
          }
        }
      }
      parseAvatarSignal(encoded)?.let { receive(view, it) }
      if (monitor.timedOut(SystemClock.elapsedRealtime()) && !ready) {
        failed(view, "加载超时（$status）")
        break
      }
      delay(500)
    }
  }

  LaunchedEffect(reloadTrigger) {
    if (reloadTrigger > 0) {
      ready = false
      webFailed = false
      webEpoch++
      report("正在重新初始化形象…")
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


  Box(modifier, contentAlignment = Alignment.TopCenter) {
    // Full-bleed hardware-accelerated WebView: never clip with RoundedCornerShape, start at alpha(0f),
    // or cover with an opaque full-screen layer (which causes Android Chromium to throttle WebGL rAF).
    if (!webFailed) {
      key(webEpoch) {
        AndroidView(
          modifier = Modifier.fillMaxSize(),
          factory = { context ->
            WebView(context).apply {
              // AndroidView's default WRAP_CONTENT makes Chromium force a zero-height HTML
              // layout viewport even when Compose measures this view to fill the screen.
              layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
              web = this
              restarting = false
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
                  return avatarResourceResponse(context, request.url)
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                  request.url.scheme != "https" || request.url.host != "appassets.androidplatform.net" || request.url.path != "/assets/anylink/portrait.html"

                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                  if (web === view) report("正在打开形象页面…")
                }

                override fun onPageFinished(view: WebView, url: String?) {
                  if (web === view && !ready && !webFailed) {
                    view.evaluateJavascript("JSON.stringify(window.anylinkAvatarStatus || null)") { value ->
                      parseAvatarSignal(value)?.let { receive(view, it) }
                    }
                  }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                  val desc = "${error.errorCode}: ${error.description} (${request.url.lastPathSegment})"
                  Log.w(TAG, "web error: $desc")
                  if (isRequiredAvatarResource(request.url, request.isForMainFrame)) failed(view, "页面或模型资源加载失败：$desc")
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                  val desc = "HTTP ${errorResponse.statusCode} (${request.url.lastPathSegment})"
                  Log.w(TAG, "http error: $desc")
                  if (isRequiredAvatarResource(request.url, request.isForMainFrame)) failed(view, "资源加载异常：$desc")
                }

                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                  Log.w(TAG, "render process gone didCrash=${detail.didCrash()}; recreating WebView")
                  failed(view, "渲染进程退出（crash=${detail.didCrash()}）")
                  return true
                }
              }
              webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                  val text = message.message().orEmpty()
                  Log.i(TAG, "console: ${text.take(400)}")
                  if (web !== this@apply || webFailed || restarting) return true
                  when {
                    text == "ANYLINK_AVATAR_READY" -> receive(this@apply, AvatarSignal("ready", ""))
                    text.startsWith("ANYLINK_AVATAR_STAGE:") -> {
                      receive(this@apply, AvatarSignal("loading", text.removePrefix("ANYLINK_AVATAR_STAGE:").trim()))
                    }
                    text.startsWith("ANYLINK_AVATAR_WARN:") -> {
                      Log.w(TAG, text)
                    }
                    text == "ANYLINK_AVATAR_CONTEXT_LOST" -> {
                      ready = false
                      report("WebGL 上下文丢失，等待恢复…")
                    }
                    text.startsWith("ANYLINK_AVATAR_FAILED") -> {
                      failed(this@apply, text.removePrefix("ANYLINK_AVATAR_FAILED:").trim().ifBlank { "未知错误" })
                    }
                  }
                  return true
                }

                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
              }
              report(if (monitor.compatible) "正在以兼容模式打开形象页面…" else "正在打开形象页面…")
              // Attach and measure before starting Chromium; the lifecycle may already be RESUMED.
              post { if (web === this) {
                if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) onResume()
                loadUrl("https://appassets.androidplatform.net/assets/anylink/portrait.html" + if (monitor.compatible) "?compat=1" else "")
              } }
            }
          },
          update = { if (ready) it.evaluateJavascript("window.anylinkMobileAvatar?.update($payload)", null) },
          onRelease = { view ->
            if (web === view) web = null
            view.stopLoading()
            view.destroy()
          },
        )
      }
    }

    // Native animated portrait fallback: sits centered WITHOUT an opaque full-screen backdrop so Android Chromium
    // never marks the underlying WebView as occluded or throttles WebGL rendering, and fades out once Live2D is ready.
    AnimatedVisibility(
      visible = !ready || webFailed,
      enter = fadeIn(tween(220)),
      exit = fadeOut(tween(380)),
      modifier = Modifier.padding(top = if (mini) 86.dp else 116.dp),
    ) {
      Box(
        modifier = Modifier
          .size(if (mini) 100.dp else 256.dp, if (mini) 140.dp else 340.dp)
          .graphicsLayer {
            translationY = if (animationsEnabled) bobDp * density else 0f
          },
        contentAlignment = Alignment.TopCenter,
      ) {
        if (!privateCharacter || webFailed) Image(
          painter = painterResource(R.drawable.anylink_portrait),
          contentDescription = "大肥鱼形象",
          contentScale = ContentScale.Fit,
          modifier = Modifier.fillMaxSize(),
        )
        if (privateCharacter) Column(
          Modifier.align(Alignment.BottomCenter),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          if (!webFailed) CircularProgressIndicator(Modifier.size(24.dp))
          Text(if (webFailed) "形象暂未加载" else status, textAlign = TextAlign.Center)
          if (webFailed) TextButton(onClick = {
            monitor.reset()
            ready = false
            webFailed = false
            webEpoch++
          }) { Text("重新加载") }
        }
      }
    }
  }
}

private const val TAG = "AnyLinkAvatar"
