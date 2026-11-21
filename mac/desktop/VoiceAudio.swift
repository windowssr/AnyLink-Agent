import Foundation
import AVFoundation
import Speech

func copyVoicePCM(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let target = AVAudioPCMBuffer(pcmFormat:source.format,frameCapacity:source.frameLength) else { return nil }
    target.frameLength = source.frameLength
    let a = UnsafeMutableAudioBufferListPointer(target.mutableAudioBufferList), b = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
    for i in 0..<min(a.count,b.count) { if let dst = a[i].mData, let src = b[i].mData { memcpy(dst,src,Int(b[i].mDataByteSize)) } }
    return target
}

final class VoicePCMConverter {
    private var converter: AVAudioConverter?
    func convert(_ source: AVAudioPCMBuffer,to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        if source.format == format { return source }
        if converter?.inputFormat != source.format || converter?.outputFormat != format { converter = AVAudioConverter(from:source.format,to:format) }
        guard let converter, let output = AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(ceil(Double(source.frameLength)*format.sampleRate/source.format.sampleRate)+128)) else { throw VoiceFailure.unavailable("无法转换语音音频格式。") }
        var used = false, error: NSError?
        let result = converter.convert(to:output,error:&error) { _,status in
            if used { status.pointee = .noDataNow; return nil }
            used = true; status.pointee = .haveData; return source
        }
        if result == .error { throw error ?? VoiceFailure.unavailable("语音格式转换失败。") }
        return output
    }
}

@MainActor
final class VoiceAudio {
    private let engine = AVAudioEngine(), player = AVAudioPlayerNode()
    private var synth = AVSpeechSynthesizer()
    private let queue = DispatchQueue(label:"com.anylink.voice.pcm",qos:.userInteractive)
    private let outputFormat = AVAudioFormat(standardFormatWithSampleRate:24000,channels:1)!
    private var outputEpoch: UInt64 = 0
    private var scheduled = 0, synthesizing = 0
    private var neuralRoot: URL?, neuralTask: Task<Void,Never>?
    private var neuralPending: [String] = []
    private(set) var capturing = false
    var hasOutput: Bool { scheduled>0 || synthesizing>0 || !neuralPending.isEmpty || neuralTask != nil }
    var onLevel: ((Double,Double) -> Void)?
    var onOutput: ((Bool) -> Void)?
    var onFirstBuffer: (() -> Void)?
    var onError: ((String) -> Void)?
    var onSpeechError: ((String) -> Void)?
    private(set) var voiceIdentifier = ""
    init() {
        engine.attach(player); engine.connect(player,to:engine.mainMixerNode,format:outputFormat)
        let choices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "zh-CN" && !$0.identifier.contains("eloquence") }
        voiceIdentifier = choices.sorted { $0.quality.rawValue > $1.quality.rawValue }.first?.identifier ?? ""
    }
    func configureNeural(root: URL) { neuralRoot = root }
    func start(format: AVAudioFormat,feed: @escaping (AVAudioPCMBuffer) -> Void) throws {
        guard !capturing else { return }
        // Both capture and our own synthesized output use this voice-processing
        // engine, giving AEC the actual playback reference for barge-in.
        try engine.inputNode.setVoiceProcessingEnabled(true)
        let native = engine.inputNode.outputFormat(forBus:0)
        guard native.sampleRate > 0, native.channelCount > 0 else { throw VoiceFailure.unavailable("没有可用的麦克风输入。") }
        let converter = VoicePCMConverter(); var frames: Int64 = 0
        engine.inputNode.installTap(onBus:0,bufferSize:1024,format:native) { [weak self] buffer,_ in
            guard let copy = copyVoicePCM(buffer) else { return }
            self?.queue.async { [weak self] in
                do {
                    let converted = try converter.convert(copy,to:format)
                    guard converted.frameLength > 0 else { return }
                    frames += Int64(converted.frameLength)
                    let position = Double(frames)/format.sampleRate
                    let values = converted.floatChannelData?[0]
                    var sum: Double = 0
                    if let values { for i in 0..<Int(converted.frameLength) { let v = Double(values[i]); sum += v*v } }
                    else if let values = converted.int16ChannelData?[0] { for i in 0..<Int(converted.frameLength) { let v = Double(values[i])/32768; sum += v*v } }
                    let rms = sqrt(sum/Double(converted.frameLength))
                    feed(converted)
                    DispatchQueue.main.async { self?.onLevel?(rms,position) }
                } catch { DispatchQueue.main.async { self?.onError?("麦克风音频转换失败，请重新开始语音。") } }
            }
        }
        do { engine.prepare(); try engine.start(); capturing = true }
        catch { engine.inputNode.removeTap(onBus:0); throw error }
    }
    func speak(_ text: String) {
        guard capturing, !text.isEmpty else { return }
        if let root = neuralRoot,let profile = NeuralSpeech.profile(root:root) {
            neuralPending.append(String(text.prefix(1400))); startNeural(root:root,profile:profile); return
        }
        let epoch = outputEpoch, utterance = AVSpeechUtterance(string:text)
        utterance.voice = AVSpeechSynthesisVoice(identifier:voiceIdentifier) ?? AVSpeechSynthesisVoice(language:"zh-CN")
        utterance.rate = 0.53; utterance.preUtteranceDelay = 0; utterance.postUtteranceDelay = 0
        synthesizing += 1
        let converter = VoicePCMConverter(), format = outputFormat, completion = VoiceCompletionGate()
        synth.write(utterance) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                guard completion.take() else { return }
                DispatchQueue.main.async { guard let self, self.outputEpoch == epoch else { return }; self.synthesizing = max(0,self.synthesizing-1); self.reportIdle() }; return
            }
            guard let copy = copyVoicePCM(pcm) else { return }
            self?.queue.async { [weak self] in
                do {
                    let output = try converter.convert(copy,to:format)
                    guard output.frameLength > 0 else { return }
                    DispatchQueue.main.async {
                        guard let self, self.outputEpoch == epoch, self.capturing else { return }
                        let first = self.scheduled == 0 && !self.player.isPlaying
                        self.scheduled += 1; self.onOutput?(true)
                        self.player.scheduleBuffer(output,completionCallbackType:.dataPlayedBack) { [weak self] _ in
                            DispatchQueue.main.async { guard let self, self.outputEpoch == epoch else { return }; self.scheduled = max(0,self.scheduled-1); self.reportIdle() }
                        }
                        if !self.player.isPlaying { self.player.play() }
                        if first { self.onFirstBuffer?() }
                    }
                } catch { DispatchQueue.main.async { self?.onError?("本机声音合成失败，文字回复仍可查看。") } }
            }
        }
    }
    private func startNeural(root: URL,profile: String) {
        guard neuralTask == nil else { return }
        let epoch = outputEpoch
        neuralTask = Task { [weak self] in
            guard let self else { return }
            let converter = VoicePCMConverter()
            while self.outputEpoch == epoch && !Task.isCancelled && !self.neuralPending.isEmpty {
                let text = self.neuralPending.removeFirst()
                do {
                    let data = try await NeuralSpeech.synthesize(text,root:root,profile:profile)
                    try Task.checkCancellation(); guard self.outputEpoch == epoch,self.capturing else { return }
                    let pcm = try NeuralSpeech.decode(data,root:root)
                    let output = try converter.convert(pcm,to:self.outputFormat)
                    guard output.frameLength>0 else { throw NeuralSpeechFailure.format }
                    let first = self.scheduled == 0 && !self.player.isPlaying
                    self.scheduled += 1; self.onOutput?(true)
                    self.player.scheduleBuffer(output,completionCallbackType:.dataPlayedBack) { [weak self] _ in
                        DispatchQueue.main.async { guard let self,self.outputEpoch == epoch else { return }; self.scheduled = max(0,self.scheduled-1); self.reportIdle() }
                    }
                    if !self.player.isPlaying { self.player.play() }
                    if first { self.onFirstBuffer?() }
                } catch {
                    guard self.outputEpoch == epoch,!Task.isCancelled else { return }
                    self.neuralPending.removeAll()
                    self.onSpeechError?("甜妹声音暂时没连上，文字回复仍可查看。麦克风保持开启。")
                }
            }
            if self.outputEpoch == epoch { self.neuralTask = nil; self.reportIdle() }
        }
    }
    // Pending network synthesis remains interruptible via hasOutput, but must
    // not keep the mouth moving across a gap with no scheduled audio.
    private func reportIdle() { if scheduled == 0 && synthesizing == 0 { onOutput?(false) } }
    func interrupt() {
        outputEpoch &+= 1
        neuralTask?.cancel(); neuralTask = nil; neuralPending.removeAll()
        synth.stopSpeaking(at:.immediate); player.stop(); scheduled = 0; synthesizing = 0; onOutput?(false)
        // A stopped synthesizer can retain cancelled callbacks; a fresh instance
        // plus epoch fencing prevents the next response from inheriting them.
        synth = AVSpeechSynthesizer()
    }
    func stop() { interrupt(); if capturing { engine.inputNode.removeTap(onBus:0); engine.stop(); capturing = false } }
}

@available(macOS 26.0, *)
@MainActor
final class VoiceRecognition {
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var tasks: [Task<Void,Never>] = []
    var onText: ((Double,Double,String,Bool) -> Void)?
    var onError: ((String) -> Void)?
    func prepare() async throws -> (AVAudioFormat,(AVAudioPCMBuffer) -> Void) {
        guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo:Locale(identifier:"zh-CN")) else { throw VoiceFailure.unavailable("这台 Mac 暂不支持本地中文识别。") }
        let module = SpeechTranscriber(locale:locale,transcriptionOptions:[],reportingOptions:[.volatileResults,.fastResults],attributeOptions:[])
        if let install = try await AssetInventory.assetInstallationRequest(supporting:[module]) { try await install.downloadAndInstall() }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:[module]) else { throw VoiceFailure.unavailable("本地语音识别没有可用音频格式。") }
        let analyzer = SpeechAnalyzer(modules:[module],options:.init(priority:.userInitiated,modelRetention:.lingering)); self.analyzer = analyzer
        try await analyzer.prepareToAnalyze(in:format)
        let (stream,continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy:.bufferingNewest(48)); self.continuation = continuation
        tasks.append(Task { [weak self] in
            do { for try await result in module.results { guard !Task.isCancelled else { return }; self?.onText?(result.range.start.seconds,result.range.end.seconds,String(result.text.characters),result.isFinal) } }
            catch { if !Task.isCancelled { self?.onError?("本地语音识别中断，请重新开始。") } }
        })
        tasks.append(Task { [weak self] in
            do { try await analyzer.start(inputSequence:stream) }
            catch { if !Task.isCancelled { self?.onError?("本地语音分析失败，请重新开始。") } }
        })
        return (format,{ buffer in
            if case .dropped = continuation.yield(AnalyzerInput(buffer:buffer)) {
                DispatchQueue.main.async { [weak self] in self?.onError?("音频处理来不及，已停止本轮以避免漏字。") }
            }
        })
    }
    func finalize(through seconds: Double) async { try? await analyzer?.finalize(through:CMTime(seconds:seconds,preferredTimescale:48000)) }
    func stop() {
        continuation?.finish(); continuation = nil; tasks.forEach { $0.cancel() }; tasks.removeAll()
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }; analyzer = nil
    }
}
