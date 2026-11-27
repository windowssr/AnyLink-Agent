package ai.openclaw.app.anylink

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

/** Bounded audio queue. The HTTP producer can run while this utterance is playing or is next in line. */
internal class PcmSpeechStream(val spoken: String, val voice: String, val requestId: String, val sampleRate: Int = 24000) {
  val audio = Channel<ByteArray>(8)
  val levels = PcmLevels(sampleRate)
  var producer: Job? = null
  var closeNetwork: () -> Unit = {}
  @Volatile var completed = false
  fun cancel() { audio.cancel(); producer?.cancel(); closeNetwork() }
}

internal class PcmLevels(private val sampleRate: Int) {
  private val frames = ArrayList<Float>()
  private var sum = 0.0; private var count = 0
  @Synchronized fun append(bytes: ByteArray) {
    require(bytes.size % 2 == 0)
    for (i in bytes.indices step 2) {
      val value = ((bytes[i].toInt() and 255) or (bytes[i + 1].toInt() shl 8)).toShort().toDouble() / 32768
      sum += value * value; count++
      if (count == sampleRate / 50) { frames += SpeechEnvelope.normalizedRms(sum, count); sum = 0.0; count = 0 }
    }
  }
  @Synchronized fun levelAt(positionFrames: Long): Float = frames.getOrElse((positionFrames / (sampleRate / 50)).toInt()) { 0f }
}

internal interface PcmOutput {
  fun play()
  fun write(bytes: ByteArray, offset: Int, size: Int): Int
  fun positionFrames(): Long
  fun stop()
  fun release()
}
internal class AndroidPcmOutput(rate: Int, call: Boolean) : PcmOutput {
  private val track = AudioTrack.Builder()
    .setAudioAttributes(AudioAttributes.Builder().setUsage(if (call) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
    .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
    .setTransferMode(AudioTrack.MODE_STREAM)
    .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), rate / 5 * 2))
    .build()
  init { check(track.state == AudioTrack.STATE_INITIALIZED) }
  override fun play() = track.play()
  override fun write(bytes: ByteArray, offset: Int, size: Int): Int = track.write(bytes, offset, size, AudioTrack.WRITE_NON_BLOCKING)
  override fun positionFrames(): Long = track.playbackHeadPosition.toLong() and 0xffffffffL
  override fun stop() { runCatching { track.pause(); track.flush() } }
  override fun release() = track.release()
}

/** Returns only after the playback head has consumed the final frame, not merely after the HTTP stream ends. */
internal suspend fun renderPcm(stream: PcmSpeechStream, output: PcmOutput) {
  var written = 0L
  output.play()
  for (bytes in stream.audio) {
    currentCoroutineContext().ensureActive(); stream.levels.append(bytes)
    var offset = 0
    while (offset < bytes.size) {
      currentCoroutineContext().ensureActive()
      val n = output.write(bytes, offset, bytes.size - offset)
      check(n >= 0) { "PCM_WRITE_FAILED" }
      if (n == 0) delay(8) else { offset += n; written += n }
    }
  }
  check(stream.completed) { "PCM_STREAM_INCOMPLETE" }
  val deadline = android.os.SystemClock.elapsedRealtime() + (written / 2 - output.positionFrames()).coerceAtLeast(0) * 1000 / stream.sampleRate + 2000
  while (output.positionFrames() < written / 2) {
    currentCoroutineContext().ensureActive()
    check(android.os.SystemClock.elapsedRealtime() < deadline) { "PCM_DRAIN_TIMEOUT" }; delay(10)
  }
}
