package ai.openclaw.app.anylink

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import kotlin.math.sqrt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal data class SpeechPose(val emotion: String, val gesture: String)
internal fun speechPose(text: String): SpeechPose = when {
  Regex("你好|早安|晚安|回来|再见|接通").containsMatchIn(text) -> SpeechPose("happy", "wave")
  Regex("抱歉|对不起|没关系|别担心|陪着|辛苦").containsMatchIn(text) -> SpeechPose("comfort", "nod")
  Regex("完成|搞定|收到了|已经|没问题|好的").containsMatchIn(text) -> SpeechPose("happy", "nod")
  Regex("首先|注意|这里|可以|需要|建议").containsMatchIn(text) -> SpeechPose("curious", "point")
  else -> SpeechPose("neutral", "none")
}

/** Playback-time RMS, not a synthetic mouth animation. PCM silence maps exactly to a closed mouth. */
internal data class SpeechEnvelope(val levels: List<Float>, val frameMs: Int = 20) {
  fun levelAt(positionMs: Int): Float = if (positionMs < 0) 0f else levels.getOrElse(positionMs / frameMs) { 0f }
  companion object {
    fun normalizedRms(sumSquares: Double, count: Int): Float =
      if (count == 0) 0f else ((sqrt(sumSquares / count) - 0.008) * 5.5).toFloat().coerceIn(0f, 1f)

    private fun readWave(file: File): SpeechEnvelope? = java.io.RandomAccessFile(file, "r").use { input ->
      if (input.length() < 44 || input.readInt() != 0x52494646) return@use null
      input.skipBytes(4)
      if (input.readInt() != 0x57415645) return@use null
      var rate = 0; var channels = 0; var bits = 0; var pcm = false
      while (input.filePointer + 8 <= input.length()) {
        val kind = input.readInt()
        val size = Integer.reverseBytes(input.readInt()).toLong() and 0xffffffffL
        val offset = input.filePointer
        if (offset + size > input.length()) return@use null
        if (kind == 0x666d7420 && size >= 16) {
          pcm = java.lang.Short.reverseBytes(input.readShort()).toInt() == 1
          channels = java.lang.Short.reverseBytes(input.readShort()).toInt()
          rate = Integer.reverseBytes(input.readInt()); input.skipBytes(6)
          bits = java.lang.Short.reverseBytes(input.readShort()).toInt()
        } else if (kind == 0x64617461 && pcm && bits == 16 && channels in 1..8 && rate in 8000..96000) {
          val frameSamples = (rate * channels / 50).coerceAtLeast(1)
          val bytes = ByteArray(frameSamples * 2)
          val levels = ArrayList<Float>()
          var remaining = size
          while (remaining >= 2 && levels.size < 15000) {
            val count = minOf(bytes.size.toLong(), remaining).toInt()
            input.readFully(bytes, 0, count)
            val buffer = java.nio.ByteBuffer.wrap(bytes, 0, count).order(ByteOrder.LITTLE_ENDIAN)
            var sum = 0.0; var n = 0
            while (buffer.remaining() >= 2) { val value = buffer.short.toDouble() / 32768; sum += value * value; n++ }
            levels.add(normalizedRms(sum, n)); remaining -= count
          }
          return@use SpeechEnvelope(levels)
        }
        input.seek(offset + size + size % 2)
      }
      null
    }

    suspend fun decode(file: File): SpeechEnvelope = withContext(Dispatchers.IO) {
      if (file.extension == "wav") readWave(file)?.let { return@withContext it }
      val extractor = MediaExtractor()
      var codec: MediaCodec? = null
      try {
        extractor.setDataSource(file.absolutePath)
        val track = (0 until extractor.trackCount).first { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
        val format = extractor.getTrackFormat(track); extractor.selectTrack(track)
        val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!); codec = decoder
        decoder.configure(format, null, null, 0); decoder.start()
        var output = format
        var inputDone = false
        var outputDone = false
        val info = MediaCodec.BufferInfo()
        val sums = ArrayList<Double>(); val counts = ArrayList<Int>()
        var retries = 0
        val deadline = android.os.SystemClock.elapsedRealtime() + 12000
        while (!outputDone && retries < 200 && android.os.SystemClock.elapsedRealtime() < deadline) {
          currentCoroutineContext().ensureActive()
          if (!inputDone) {
            val index = decoder.dequeueInputBuffer(10000)
            if (index >= 0) {
              val n = extractor.readSampleData(decoder.getInputBuffer(index)!!, 0)
              if (n < 0) { decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true }
              else { decoder.queueInputBuffer(index, 0, n, extractor.sampleTime, 0); extractor.advance() }
            }
          }
          val index = decoder.dequeueOutputBuffer(info, 10000)
          if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) output = decoder.outputFormat
          if (index >= 0) {
            retries = 0
            val bytes = decoder.getOutputBuffer(index)!!.duplicate().order(ByteOrder.LITTLE_ENDIAN)
            bytes.position(info.offset); bytes.limit(info.offset + info.size)
            val rate = output.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            val channels = output.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val encoding = if (output.containsKey(MediaFormat.KEY_PCM_ENCODING)) output.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
            val floatPcm = encoding == AudioFormat.ENCODING_PCM_FLOAT
            val width = if (floatPcm) 4 else 2
            var sample = 0
            while (bytes.remaining() >= width) {
              val v = if (floatPcm) bytes.float.toDouble() else bytes.short.toDouble() / 32768.0
              val timeMs = info.presentationTimeUs / 1000 + sample.toLong() * 1000 / (rate * channels)
              val frame = (timeMs / 20).toInt()
              // Speech responses are bounded on the server; also bound malformed decoder timestamps.
              if (frame in 0 until 15000) {
                while (sums.size <= frame) { sums.add(0.0); counts.add(0) }
                sums[frame] = sums[frame] + v * v; counts[frame] = counts[frame] + 1
              }
              sample++
            }
            outputDone = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            decoder.releaseOutputBuffer(index, false)
          } else retries++
        }
        SpeechEnvelope(sums.indices.map { normalizedRms(sums[it], counts[it]) })
      } finally {
        runCatching { codec?.stop() }; codec?.release(); extractor.release()
      }
    }
  }
}

/** Wait for initialization and synthesize locally to a file, then use the same player and lip clock as cloud TTS. */
internal class SystemSpeechSynthesizer(private val context: Context, private val onError: (String) -> Unit) {
  private var engine: TextToSpeech? = null
  private var initialized: CompletableDeferred<Boolean>? = null
  private val pending = mutableMapOf<String, CompletableDeferred<Boolean>>()
  private var activeUtterance: String? = null
  private val main = Handler(Looper.getMainLooper())
  private fun initialize(): CompletableDeferred<Boolean> {
    initialized?.let { return it }
    val ready = CompletableDeferred<Boolean>(); initialized = ready
    engine = TextToSpeech(context) { status -> main.post {
      val tts = engine
      val supported = status == TextToSpeech.SUCCESS && tts != null && tts.setLanguage(Locale.SIMPLIFIED_CHINESE) >= 0
      if (supported) {
        val voices = tts.voices.orEmpty().filter { it.locale.language == "zh" && !it.isNetworkConnectionRequired }
        val voice = voices.firstOrNull { Regex("female|xiaoxiao|xiaoyi|yue|ting|zh-cn-x-fis|zh-cn-x-zhe", RegexOption.IGNORE_CASE).containsMatchIn(it.name) } ?: voices.firstOrNull()
        if (voice != null) tts.voice = voice
        tts.setSpeechRate(1.06f); tts.setPitch(1.12f)
      }
      ready.complete(supported)
    } }
    engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(id: String?) = Unit
      override fun onDone(id: String?) { main.post { pending.remove(id)?.complete(true) } }
      @Deprecated("Platform callback") override fun onError(id: String?) { main.post { pending.remove(id)?.complete(false) } }
      override fun onStop(id: String?, interrupted: Boolean) { main.post { pending.remove(id)?.complete(false) } }
    })
    return ready
  }
  suspend fun synthesize(text: String): File? = withContext(Dispatchers.Main.immediate) {
    if (withTimeoutOrNull(8000) { initialize().await() } != true) {
      onError("云端播报失败，手机也没有就绪的中文语音引擎，请查看文字回复。"); return@withContext null
    }
    val id = UUID.randomUUID().toString()
    val file = File.createTempFile("local-speech-", ".wav", context.cacheDir)
    val done = CompletableDeferred<Boolean>(); pending[id] = done; activeUtterance = id
    var success = false
    try {
      if (engine?.synthesizeToFile(text, Bundle(), file, id) == TextToSpeech.SUCCESS) success = withTimeoutOrNull(20000) { done.await() } == true
      if (!success || file.length() == 0L) { onError("手机语音合成失败，请查看文字回复。"); null } else file
    } finally {
      pending.remove(id)
      if (!success) { if (activeUtterance == id) engine?.stop(); file.delete() }
      if (activeUtterance == id) activeUtterance = null
    }
  }
  fun cancel() {
    activeUtterance = null
    engine?.stop()
    pending.values.forEach { it.complete(false) }; pending.clear()
  }
}
