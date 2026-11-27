package ai.openclaw.app.anylink

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
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
  val sizeBytes: Long,
)

/** Android SAF picker + zero-RAM streaming MediaStore.Downloads helpers (zero runtime storage permissions on API 31+). */
internal object AnyLinkFiles {
  const val MAX_BYTES: Long = 200L * 1024L * 1024L

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
    if (size > MAX_BYTES) throw LinkFailure("ARTIFACT_TOO_LARGE", "文件大小超过 200 MiB 限制（当前 ${formatSize(size)}）")
    val mime = context.contentResolver.getType(uri)?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
    val cleanName = sanitizeFilename(name ?: uri.lastPathSegment ?: "attachment.bin")
    return PickedFile(uri = uri, filename = cleanName, mimeType = mime, sizeBytes = size.coerceAtLeast(0L))
  }

  fun readBytesBounded(context: Context, uri: Uri, maxBytes: Long = MAX_BYTES): ByteArray {
    val input = context.contentResolver.openInputStream(uri) ?: throw LinkFailure("FILE_UNREADABLE", "无法读取选中的文件")
    input.use { stream ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(32 * 1024)
      var total = 0L
      while (true) {
        val n = stream.read(buf)
        if (n <= 0) break
        total += n
        if (total > maxBytes) throw LinkFailure("ARTIFACT_TOO_LARGE", "文件大小超过 200 MiB 限制")
        out.write(buf, 0, n)
      }
      if (total == 0L) throw LinkFailure("FILE_EMPTY", "文件为空，未发送")
      return out.toByteArray()
    }
  }

  /** Stream bytes directly from an HTTP InputStream to MediaStore.Downloads/AnyLink (or app external Downloads fallback)
   * with incremental SHA-256 verification and O(1) RAM footprint (handles 200+ MiB files safely). */
  fun streamToSavedFile(
    context: Context,
    input: InputStream,
    filename: String,
    contentType: String,
    maxBytes: Long = MAX_BYTES,
    expectedSha256: String = "",
  ): Pair<SavedFile, String> {
    val cleanName = sanitizeFilename(filename)
    val safeMime = contentType.substringBefore(';').trim().ifBlank { "application/octet-stream" }
    val digest = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(32 * 1024)

    if (Build.VERSION.SDK_INT >= 29) {
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, cleanName)
        put(MediaStore.Downloads.MIME_TYPE, safeMime)
        put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/AnyLink")
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = runCatching { resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) }.getOrNull()
      if (uri != null) {
        val out = runCatching { resolver.openOutputStream(uri) }.getOrNull()
        if (out != null) {
          var total = 0L
          try {
            out.use { sink ->
              while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                total += n
                if (total > maxBytes) throw LinkFailure("ARTIFACT_TOO_LARGE", "下载的附件超过 200 MiB 上限")
                digest.update(buf, 0, n)
                sink.write(buf, 0, n)
              }
            }
            val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
            if (expectedSha256.isNotBlank() && !expectedSha256.equals(actualSha, ignoreCase = true)) {
              runCatching { resolver.delete(uri, null, null) }
              throw LinkFailure("SHA256_MISMATCH", "附件完整性校验未通过")
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return SavedFile(uri = uri, displayPath = "下载/AnyLink/$cleanName", filename = cleanName, contentType = safeMime, sizeBytes = total) to actualSha
          } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
          }
        } else {
          runCatching { resolver.delete(uri, null, null) }
        }
      }
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
    val tmp = File(dir, ".${target.name}.part")
    var total = 0L
    try {
      tmp.outputStream().use { sink ->
        while (true) {
          val n = input.read(buf)
          if (n <= 0) break
          total += n
          if (total > maxBytes) throw LinkFailure("ARTIFACT_TOO_LARGE", "下载的附件超过 200 MiB 上限")
          digest.update(buf, 0, n)
          sink.write(buf, 0, n)
        }
      }
      val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
      if (expectedSha256.isNotBlank() && !expectedSha256.equals(actualSha, ignoreCase = true)) {
        tmp.delete()
        throw LinkFailure("SHA256_MISMATCH", "附件完整性校验未通过")
      }
      if (!tmp.renameTo(target)) {
        tmp.copyTo(target, overwrite = true)
        tmp.delete()
      }
      return SavedFile(uri = Uri.fromFile(target), displayPath = "AnyLink/${target.name}", filename = target.name, contentType = safeMime, sizeBytes = total) to actualSha
    } catch (e: Exception) {
      tmp.delete()
      throw e
    }
  }

  fun saveReceivedFile(context: Context, bytes: ByteArray, filename: String, contentType: String): SavedFile =
    streamToSavedFile(context, ByteArrayInputStream(bytes), filename, contentType).first

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
