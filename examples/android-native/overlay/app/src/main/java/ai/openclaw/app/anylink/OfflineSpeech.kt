package ai.openclaw.app.anylink

import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.io.File

internal data class OfflineSpeechResult(val text: String, val endpoint: Boolean)
internal interface OfflineSpeechCapture : AutoCloseable {
  fun accept(samples: ShortArray, count: Int): OfflineSpeechResult
  fun finish(): String
}
internal interface OfflineSpeechPlatform {
  fun available(): Boolean
  fun open(): OfflineSpeechCapture
}

/** Cache the CPU recognizer; each utterance owns a separate stream, released even when cancelled. */
internal class SherpaOfflineSpeech(private val models: OfflineAsrModels) : OfflineSpeechPlatform {
  private val lock = Any()
  private var recognizer: OnlineRecognizer? = null
  override fun available() = models.state.value.ready
  override fun open(): OfflineSpeechCapture = synchronized(lock) {
    check(available()) { "请先在「保活」下载本地离线识别模型。" }
    val engine = recognizer ?: OnlineRecognizer(config = OnlineRecognizerConfig(
      modelConfig = OnlineModelConfig(
        transducer = OnlineTransducerModelConfig(
          encoder = File(models.directory, "encoder-epoch-99-avg-1.int8.onnx").absolutePath,
          decoder = File(models.directory, "decoder-epoch-99-avg-1.onnx").absolutePath,
          joiner = File(models.directory, "joiner-epoch-99-avg-1.onnx").absolutePath,
        ),
        tokens = File(models.directory, "tokens.txt").absolutePath, numThreads = 2, provider = "cpu", modelType = "zipformer", modelingUnit = "cjkchar",
      ),
      decodingMethod = "modified_beam_search", maxActivePaths = 4, hotwordsScore = 1.5f,
      endpointConfig = EndpointConfig(rule1 = EndpointRule(false, 3f, 0f), rule2 = EndpointRule(true, 1.1f, 0f), rule3 = EndpointRule(false, 0f, 28f)),
    )).also { recognizer = it }
    val stream = engine.createStream("大肥鱼")
    var closed = false
    object : OfflineSpeechCapture {
      override fun accept(samples: ShortArray, count: Int): OfflineSpeechResult = synchronized(lock) {
        check(!closed)
        stream.acceptWaveform(FloatArray(count) { samples[it] / 32768f }, 16000)
        while (engine.isReady(stream)) engine.decode(stream)
        OfflineSpeechResult(engine.getResult(stream).text.trim(), engine.isEndpoint(stream))
      }
      override fun finish(): String = synchronized(lock) {
        check(!closed)
        stream.acceptWaveform(FloatArray(8000), 16000)
        stream.inputFinished()
        while (engine.isReady(stream)) engine.decode(stream)
        engine.getResult(stream).text.trim()
      }
      override fun close() = synchronized(lock) { if (!closed) { closed = true; stream.release() }; Unit }
    }
  }
}
