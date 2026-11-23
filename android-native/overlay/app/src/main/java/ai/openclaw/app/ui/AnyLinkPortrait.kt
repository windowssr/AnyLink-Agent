package ai.openclaw.app.ui

import ai.openclaw.app.R
import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import android.util.Log
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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
        // If the renderer was killed or the context lost while paused, the page
        // may never reach READY again; reload once after a grace period.
        val view = web
        if (view != null) view.postDelayed({
          if (web === view && !ready) { Log.w(TAG, "avatar not ready 8s after resume; reloading"); view.reload() }
        }, 8000)
      }
    }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }
  Box(modifier) {
    key(webEpoch) {
    DisposableEffect(webEpoch) {
      onDispose { web?.stopLoading(); web?.destroy() }
    }
    if (!ready) {
      Image(
        painter = painterResource(R.drawable.anylink_avatar),
        contentDescription = null,
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxSize(),
      )
    }
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = { context ->
        WebView(context).apply {
          web = this
          setBackgroundColor(AndroidColor.TRANSPARENT)
          settings.javaScriptEnabled = true
          settings.domStorageEnabled = false
          settings.allowFileAccess = false
          settings.allowContentAccess = false
          settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
          settings.mediaPlaybackRequiresUserGesture = true
          val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
          webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
              val uri = request.url
              if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/assets/anylink/") == true) {
                assets.shouldInterceptRequest(uri)?.let { return it }
              }
              return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
              // The renderer crashed (usually memory pressure). Recreate the
              // WebView instead of leaving a dead surface on screen.
              Log.w(TAG, "render process gone didCrash=${detail.didCrash()}; recreating WebView")
              ready = false; webEpoch++
              return true
            }
          }
          webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
              Log.i(TAG, "console: ${message.message().take(400)}")
              if (message.message() == "ANYLINK_AVATAR_READY") {
                ready = true
                evaluateJavascript("window.anylinkMobileAvatar?.update($currentPayload)", null)
              }
              return true
            }

            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
          }
          // There is deliberately no JavascriptInterface: Android actions,
          // microphone, chat and credentials stay in the official native owners.
          loadUrl("https://appassets.androidplatform.net/assets/anylink/portrait.html")
        }
      },
      update = { it.evaluateJavascript("window.anylinkMobileAvatar?.update($payload)", null) },
    )
    }
  }
}

private const val TAG = "AnyLinkAvatar"
