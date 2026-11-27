package ai.openclaw.app.anylink

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal sealed interface FilePreview {
  data class Picture(val bitmap: Bitmap, val video: Boolean = false, val pdf: Boolean = false) : FilePreview
  data class Text(val text: String, val truncated: Boolean) : FilePreview
  data object Unsupported : FilePreview
  data object Missing : FilePreview
}
internal fun attachmentMime(name: String, mime: String): String = mime.takeIf { it.isNotBlank() && it != "application/octet-stream" }
  ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()).orEmpty().ifBlank { "application/octet-stream" }

/** Read bounded content from the saved URI; no WebView, network fetch, or whole-file byte arrays. */
internal suspend fun loadFilePreview(context: Context, msg: ChatMessage, large: Boolean = false): FilePreview = withContext(Dispatchers.IO) {
  if (msg.fileUri.isBlank()) return@withContext FilePreview.Unsupported
  val uri = Uri.parse(msg.fileUri)
  val mime = attachmentMime(msg.fileName, msg.fileMime)
  val limit = if (large) 1600 else 560
  try {
    when {
      mime.startsWith("image/") -> {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext FilePreview.Unsupported
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > limit) sample *= 2
        val bitmap = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
        bitmap?.let { FilePreview.Picture(it) } ?: FilePreview.Unsupported
      }
      mime == "application/pdf" -> {
        val fd = context.contentResolver.openFileDescriptor(uri, "r") ?: return@withContext FilePreview.Missing
        PdfRenderer(fd).use { pdf ->
          if (pdf.pageCount == 0) return@withContext FilePreview.Unsupported
          pdf.openPage(0).use { page ->
            val scale = limit.toFloat() / maxOf(page.width, page.height)
            val bitmap = Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1), (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            FilePreview.Picture(bitmap, pdf = true)
          }
        }
      }
      mime.startsWith("video/") -> {
        val retriever = MediaMetadataRetriever()
        try { retriever.setDataSource(context, uri); retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, limit, limit)?.let { FilePreview.Picture(it, video = true) } ?: FilePreview.Unsupported }
        finally { retriever.release() }
      }
      mime.startsWith("text/") || mime in setOf("application/json", "application/xml", "application/javascript") -> {
        val chars = CharArray(if (large) 32769 else 1601)
        val text = context.contentResolver.openInputStream(uri)?.bufferedReader(Charsets.UTF_8)?.use { reader ->
          var count = 0
          while (count < chars.size) { val n = reader.read(chars, count, chars.size - count); if (n < 0) break; count += n }
          String(chars, 0, count)
        } ?: return@withContext FilePreview.Missing
        FilePreview.Text(text.take(chars.size - 1), text.length == chars.size)
      }
      else -> FilePreview.Unsupported
    }
  } catch (e: CancellationException) { throw e }
  catch (_: java.io.FileNotFoundException) { FilePreview.Missing }
  catch (_: SecurityException) { FilePreview.Missing }
  catch (_: Exception) { FilePreview.Unsupported }
}

@Composable
internal fun AttachmentCard(msg: ChatMessage) {
  val context = LocalContext.current
  val colors = MaterialTheme.colorScheme
  val preview by produceState<FilePreview?>(null, msg.fileUri, msg.fileMime) { value = loadFilePreview(context, msg) }
  var expanded by remember { mutableStateOf(false) }
  var openError by remember { mutableStateOf(false) }
  Surface(color = colors.surfaceVariant.copy(alpha = 0.55f), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AppIcon(if (msg.fileMime.startsWith("image/")) AppIcon.Image else AppIcon.File, modifier = Modifier.size(24.dp), tint = colors.primary)
        Column(Modifier.weight(1f)) {
          Text(msg.fileName, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
          Text(AnyLinkFiles.formatSize(msg.fileSize), fontSize = 11.sp, color = colors.onSurfaceVariant)
        }
      }
      when (val result = preview) {
        is FilePreview.Picture -> Surface(onClick = { if (result.video) openError = !AnyLinkFiles.openFile(context, msg.fileUri, attachmentMime(msg.fileName, msg.fileMime)) else expanded = true }, shape = RoundedCornerShape(10.dp)) {
          Box(Modifier.fillMaxWidth().heightIn(min = 100.dp, max = 190.dp), contentAlignment = Alignment.Center) {
            Image(result.bitmap.asImageBitmap(), if (result.pdf) "PDF 首页预览" else "附件预览", Modifier.fillMaxWidth(), contentScale = ContentScale.Fit)
            if (result.video) Surface(color = colors.surface.copy(alpha = 0.9f), shape = RoundedCornerShape(30.dp)) { AppIcon(AppIcon.Play, "播放视频", Modifier.padding(12.dp).size(24.dp)) }
          }
        }
        is FilePreview.Text -> Surface(onClick = { expanded = true }, color = colors.surface, shape = RoundedCornerShape(10.dp)) {
          Text(result.text.ifBlank { "空文本文件" }, fontSize = 12.sp, lineHeight = 18.sp, maxLines = 6, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(10.dp))
        }
        FilePreview.Missing -> Text("文件已移动或读取权限失效，请重新接收。", fontSize = 11.sp, color = colors.error)
        else -> if (msg.fileState == "receiving") LinearProgressIndicator(Modifier.fillMaxWidth())
      }
      if (msg.fileState == "failed") Text(msg.fileError.ifBlank { "接收失败，请重新发送。" }, color = colors.error, fontSize = 11.sp)
      else if (msg.fileState == "receiving") Text("正在接收…", fontSize = 11.sp, color = colors.primary)
      else if (msg.fileLocation.isNotBlank()) Text("已保存至：${msg.fileLocation}", fontSize = 11.sp, color = colors.onSurfaceVariant)
      if (msg.fileUri.isNotBlank()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { openError = !AnyLinkFiles.openFile(context, msg.fileUri, attachmentMime(msg.fileName, msg.fileMime)) }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("打开文件", fontSize = 12.sp) }
        TextButton(onClick = { openError = !AnyLinkFiles.shareFile(context, msg.fileUri, msg.fileName, attachmentMime(msg.fileName, msg.fileMime)) }, contentPadding = PaddingValues(horizontal = 6.dp)) {
          AppIcon(AppIcon.Share, modifier = Modifier.size(15.dp)); Spacer(Modifier.width(4.dp)); Text("分享", fontSize = 12.sp)
        }
      }
      if (openError) Text("没有可用应用打开此文件，或文件已不可读取。", fontSize = 11.sp, color = colors.error)
    }
  }
  if (expanded) Dialog(onDismissRequest = { expanded = false }) {
    val large by produceState<FilePreview?>(preview, msg.fileUri) { value = loadFilePreview(context, msg, large = true) }
    Surface(shape = RoundedCornerShape(20.dp)) {
      Column(Modifier.fillMaxWidth().heightIn(max = 680.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(msg.fileName, Modifier.weight(1f), maxLines = 2, fontSize = 14.sp)
          IconButton(onClick = { expanded = false }) { AppIcon(AppIcon.Close, "关闭预览") }
        }
        when (val result = large) {
          is FilePreview.Picture -> {
            var zoom by remember { mutableFloatStateOf(1f) }
            Box(Modifier.fillMaxWidth().heightIn(min = 200.dp, max = 480.dp).clipToBounds()) {
              Image(result.bitmap.asImageBitmap(), "文件大图", Modifier.fillMaxWidth().pointerInput(Unit) { detectTransformGestures { _, _, scale, _ -> zoom = (zoom * scale).coerceIn(1f, 4f) } }.graphicsLayer(scaleX = zoom, scaleY = zoom), contentScale = ContentScale.Fit)
            }
            if (result.pdf) Text("首页预览，完整阅读请打开文件。", fontSize = 11.sp)
          }
          is FilePreview.Text -> Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) { Text(result.text, fontSize = 13.sp); if (result.truncated) Text("预览已截断，完整内容请打开文件。", fontSize = 11.sp) }
          else -> Text("无法生成此文件的内容预览。", fontSize = 12.sp)
        }
      }
    }
  }
}
