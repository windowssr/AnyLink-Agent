package ai.openclaw.app.ui

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

private fun isAvatarOrigin(uri: Uri) = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.port in setOf(-1, 443)

internal fun avatarResourceResponse(context: Context, uri: Uri): WebResourceResponse? {
  // Pixi/Cubism use inline blobs; WebView handles these without opening the network.
  if (uri.scheme == "data" || uri.scheme == "blob") return null
  if (isAvatarOrigin(uri)) {
    val path = uri.path.orEmpty()
    if (path == "/favicon.ico" || path == "/assets/anylink/favicon.ico") {
      return WebResourceResponse("image/x-icon", null, 204, "No Content", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
    }
    if (path.startsWith("/assets/anylink/")) return openBundledAsset(context, uri.encodedPath ?: path)
  }
  return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}

/** WebView reports HTTP errors for every resource, including optional favicons and gestures. */
internal fun isRequiredAvatarResource(uri: Uri, mainFrame: Boolean): Boolean {
  if (mainFrame) return true
  if (!isAvatarOrigin(uri)) return false
  val path = uri.path.orEmpty()
  val root = "/assets/anylink/"
  if (path.removePrefix(root) in setOf("portrait.html", "avatar-loader.js", "avatar.js", "public-avatar.js", "live2dcubismcore.min.js", "pixi.min.js", "cubism4-colors.min.js") && path.startsWith(root)) return true
  return path.startsWith(root + "model/") &&
    (path.endsWith(".model3.json") || path.endsWith(".moc3") || path.endsWith(".physics3.json") || path.startsWith(root + "model/textures/"))
}
