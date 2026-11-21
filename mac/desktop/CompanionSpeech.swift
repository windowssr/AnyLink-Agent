import AVFoundation

@MainActor
final class CompanionSpeech: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let root: URL
    private var neuralTask: Task<Void,Never>?, player: AVAudioPlayer?
    private var synth = AVSpeechSynthesizer()
    private var generation = 0
    private(set) var speaking = false
    private(set) var utterances = 0
    var onSpeaking: ((Bool) -> Void)?
    var onFailure: (() -> Void)?
    var profile: String? { NeuralSpeech.profile(root:root) }
    var label: String { NeuralSpeech.label(profile:profile) }
    let voice: AVSpeechSynthesisVoice?
    init(root: URL) {
        self.root = root
        let choices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "zh-CN" && !$0.identifier.contains("eloquence") }
        voice = choices.sorted { lhs,rhs in
            if lhs.gender != rhs.gender { return lhs.gender == .female }
            return lhs.quality.rawValue > rhs.quality.rawValue
        }.first ?? AVSpeechSynthesisVoice(language:"zh-CN")
        super.init(); synth.delegate = self
    }
    func speak(_ raw: String) {
        let text = CompanionPolicy.cleanSpeech(raw); guard !text.isEmpty else { return }
        stop(); utterances += 1
        if let profile {
            let epoch = generation
            neuralTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let data = try await NeuralSpeech.synthesize(text,root:self.root,profile:profile)
                    try Task.checkCancellation(); guard self.generation == epoch else { return }
                    let player = try AVAudioPlayer(data:data); self.player = player; player.delegate = self; player.volume = 0.8
                    guard player.prepareToPlay(),player.play() else { throw NeuralSpeechFailure.format }
                    self.speaking = true; self.onSpeaking?(true)
                } catch {
                    if !Task.isCancelled && self.generation == epoch { self.onFailure?() }
                }
                if self.generation == epoch { self.neuralTask = nil }
            }
            return
        }
        let item = AVSpeechUtterance(string:text)
        item.voice = voice; item.rate = 0.49; item.volume = 0.72
        item.preUtteranceDelay = 0; item.postUtteranceDelay = 0
        synth.speak(item)
    }
    func stop() {
        generation += 1; neuralTask?.cancel(); neuralTask = nil
        player?.delegate = nil; player?.stop(); player = nil
        synth.delegate = nil; synth.stopSpeaking(at:.immediate)
        synth = AVSpeechSynthesizer(); synth.delegate = self
        if speaking { speaking = false; onSpeaking?(false) }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer,successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self,self.player === player else { return }
            self.player = nil; self.speaking = false; self.onSpeaking?(false)
            if !flag { self.onFailure?() }
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer,error: Error?) {
        audioPlayerDidFinishPlaying(player,successfully:false)
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,didStart utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in guard let self,self.synth === synthesizer else { return }; self.speaking = true; self.onSpeaking?(true) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,didFinish utterance: AVSpeechUtterance) { ended(synthesizer) }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,didCancel utterance: AVSpeechUtterance) { ended(synthesizer) }
    nonisolated private func ended(_ synthesizer: AVSpeechSynthesizer) {
        Task { @MainActor [weak self] in guard let self,self.synth === synthesizer else { return }; self.speaking = false; self.onSpeaking?(false) }
    }
}
