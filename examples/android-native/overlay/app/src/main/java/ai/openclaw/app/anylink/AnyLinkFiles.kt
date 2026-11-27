package ai.openclaw.app.anylink

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale

internal data class PickedFile(
  val uri: Uri,
  val filename: String,
  val mimeType: String,
  val sizeBytes: Long,
)

internal data class DownloadedArtifact(
  val bytes: ByteArray,
  val filename: String,
  val contentType: String,
  val sha256: String,
)

internal data class SavedFile(
  val uri: Uri?,
  val displayPath: String,
  val filename: String,
  val contentType: String,
  val sizeBytes: Int,
)

/** Android SAF picker + MediaStore.Downloads helpers (zero runtime storage permissions on API 31+). */
internal object AnyLinkFiles {
  const val MAX_BYTES: Int = 10 * 1024 * 1024

  fun sanitizeFilename(raw: String?): String {
    val base = (raw ?: "attachment.bin").replace('\\', '/').substringAfterLast('/')
    val cleaned = base.replace(Regex("[\\x00-\\x1f\"<>|:*?]"), "_").trim()
    return (cleaned.ifBlank { "attachment.bin" }).take(200)
  }

  fun formatSize(bytes: Long): String = when {
    bytes >= 1024L * 1024L -> String.format(Locale.US, "%.2f MB", bytes.toDouble() / (1024.0 * 1024.0))
    bytes >= 1024L -> String.format(Locale.US, "%.1f KB", bytes.toDouble() / 1024.0)
    else -> "$bytes B"
  }

  fun readPickedFile(context: Context, uri: Uri): PickedFile {
    var name: String? = null
    var size = -1L
    runCatching {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameIdx >= 0) name = cursor.getString(nameIdx)
          if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) size = cursor.getLong(sizeIdx)
        }
      }
    }
    if (size > MAX_BYTES) throw LinkFailure("ARTIFACT_TOO_LARGE", "文件大小超过 10 MiB 限制（当前 ${formatSize(size)}）")
    val mime = context.contentResolver.getType(uri)?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
    val cleanName = sanitizeFilename(name ?: uri.lastPathSegment ?: "attachment.bin")
    return PickedFile(uri = uri, filename = cleanName, mimeType = mime, sizeBytes = size.coerceAtLeast(0L))
  }

  fun readBytesBounded(context: Context, uri: Uri, maxBytes: Int = MAX_BYTES): ByteArray {
    val input = context.contentResolver.openInputStream(uri) ?: throw LinkFailure("FILE_UNREADABLE", "无法读取选中的文件")
    input.use { stream ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(16 * 1024)
      var total = 0
      while (true) {
        val n = stream.read(buf)
        if (n <= 0) break
        total += n
        if (total > maxBytes) throw LinkFailure("ARTIFACT_TOO_LARGE", "文件大小超过 10 MiB 限制")
        out.write(buf, 0, n)
      }
      if (total == 0) throw LinkFailure("FILE_EMPTY", "文件为空，未发送")
      return out.toByteArray()
    }
  }

  fun saveReceivedFile(context: Context, bytes: ByteArray, filename: String, contentType: String): SavedFile {
    val cleanName = sanitizeFilename(filename)
    val safeMime = contentType.substringBefore(';').trim().ifBlank { "application/octet-stream" }
    if (Build.VERSION.SDK_INT >= 29) {
      val inserted = runCatching {
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, cleanName)
          put(MediaStore.Downloads.MIME_TYPE, safeMime)
          put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/AnyLink")
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return@runCatching null
        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return@runCatching null
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        SavedFile(uri = uri, displayPath = "下载/AnyLink/$cleanName", filename = cleanName, contentType = safeMime, sizeBytes = bytes.size)
      }.getOrNull()
      if (inserted != null) return inserted
    }
    val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir, "AnyLink").apply { mkdirs() }
    val dot = cleanName.lastIndexOf('.')
    val stem = if (dot > 0) cleanName.substring(0, dot) else cleanName
    val ext = if (dot > 0) cleanName.substring(dot) else ""
    var target = File(dir, cleanName)
    var idx = 2
    while (target.exists() && idx < 1000) {
      target = File(dir, "$stem (${idx++})$ext")
    }
    target.writeBytes(bytes)
    return SavedFile(uri = Uri.fromFile(target), displayPath = "AnyLink/${target.name}", filename = target.name, contentType = safeMime, sizeBytes = bytes.size)
  }

  fun openFile(context: Context, uriString: String, mimeType: String): Boolean = runCatching {
    val uri = Uri.parse(uriString)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, mimeType.ifBlank { "*/*" })
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(Intent.createChooser(intent, "打开文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
  }.getOrDefault(false)

  fun shareFile(context: Context, uriString: String, filename: String, mimeType: String): Boolean = runCatching {
    val uri = Uri.parse(uriString)
    val intent = Intent(Intent.ACTION_SEND).apply {
      type = mimeType.ifBlank { "*/*" }
      putExtra(Intent.EXTRA_STREAM, uri)
      putExtra(Intent.EXTRA_SUBJECT, filename)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(Intent.createChooser(intent, "分享 $filename").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
  }.getOrDefault(false)
}
