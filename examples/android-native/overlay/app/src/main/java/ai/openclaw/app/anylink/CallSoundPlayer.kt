package ai.openclaw.app.anylink

import ai.openclaw.app.R
import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal enum class CallCue(val resource: Int) {
  Start(R.raw.anylink_call_start), End(R.raw.anylink_call_end),
}

/** Offline cues follow the current communication route and finish before microphone capture begins. */
internal class CallSoundPlayer(private val context: Context, private val createPlayer: () -> MediaPlayer = { MediaPlayer() }) {
  private val main = Handler(Looper.getMainLooper())
  private var current: Playback? = null
  private inner class Playback(val player: MediaPlayer, val continuation: CancellableContinuation<Boolean>) {
    var finished = false
    fun finish(success: Boolean) {
      if (finished) return
      finished = true
      if (current === this) current = null
      runCatching { player.setOnPreparedListener(null); player.setOnCompletionListener(null); player.setOnErrorListener(null); player.release() }
      if (continuation.isActive) continuation.resume(success)
    }
  }
  suspend fun play(cue: CallCue): Boolean = withContext(Dispatchers.Main.immediate) {
    stop()
    withTimeoutOrNull(1200) {
      suspendCancellableCoroutine { continuation ->
        val player = runCatching { createPlayer() }.getOrNull()
        if (player == null) { continuation.resume(false); return@suspendCancellableCoroutine }
        val playback = Playback(player, continuation)
        current = playback
        continuation.invokeOnCancellation {
          if (Looper.myLooper() == Looper.getMainLooper()) playback.finish(false) else main.post { playback.finish(false) }
        }
        try {
          player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
          player.setVolume(0.55f, 0.55f)
          player.setOnPreparedListener {
            if (current === playback && continuation.isActive) runCatching { player.start() }.onFailure { playback.finish(false) }
          }
          player.setOnCompletionListener { playback.finish(true) }
          player.setOnErrorListener { _, _, _ -> playback.finish(false); true }
          player.setDataSource(context, Uri.parse("android.resource://${context.packageName}/${cue.resource}"))
          player.prepareAsync()
        } catch (_: Exception) { playback.finish(false) }
      }
    } ?: false
  }
  fun stop() {
    val playback = current ?: return
    if (Looper.myLooper() == Looper.getMainLooper()) playback.finish(false) else main.post { playback.finish(false) }
  }
}
