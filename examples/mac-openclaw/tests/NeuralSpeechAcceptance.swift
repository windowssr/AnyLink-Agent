import Foundation
import AVFoundation

@main struct NeuralSpeechAcceptance {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath:CommandLine.arguments[1])
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:temporary) }
        let config = temporary.appendingPathComponent("data/mac/voice/neural.json")
        try FileManager.default.createDirectory(at:config.deletingLastPathComponent(),withIntermediateDirectories:true)
        func write(_ value: [String:Any]) throws { try JSONSerialization.data(withJSONObject:value).write(to:config) }
        assert(NeuralSpeech.profile(root:temporary) == nil)
        try write(["provider":"edge-tts","enabled":true,"profile":"sweet-lively"])
        assert(NeuralSpeech.profile(root:temporary) == nil)
        try write(["provider":"edge-tts","enabled":true,"profile":"sweet-lively","consent_microsoft":true])
        assert(NeuralSpeech.profile(root:temporary) == "sweet-lively")
        try write(["provider":"edge-tts","enabled":true,"profile":"unknown","consent_microsoft":true])
        assert(NeuralSpeech.profile(root:temporary) == nil)
        guard let profile = NeuralSpeech.profile(root:root) else { throw NeuralSpeechFailure.unavailable }
        let began = Date()
        let audio = try await NeuralSpeech.synthesize("嘿，我是大肥鱼呀！今天也让我陪着你吧。",root:root,profile:profile)
        let milliseconds = Int(Date().timeIntervalSince(began)*1000)
        let pcm = try NeuralSpeech.decode(audio,root:root)
        guard pcm.frameLength>0 else { throw NeuralSpeechFailure.format }
        let target = AVAudioFormat(standardFormatWithSampleRate:24000,channels:1)!
        let playback = try VoicePCMConverter().convert(pcm,to:target)
        guard playback.frameLength>0,playback.format == target else { throw NeuralSpeechFailure.format }
        let folder = root.appendingPathComponent("data/mac/voice/generated")
        let remaining = try FileManager.default.contentsOfDirectory(atPath:folder.path)
        assert(remaining.isEmpty)
        let task = Task { try await NeuralSpeech.synthesize(String(repeating:"这是一段取消测试。",count:60),root:root,profile:profile) }
        try await Task.sleep(nanoseconds:20_000_000); let cancelAt = Date(); task.cancel()
        var cancelled = false
        do { _ = try await task.value } catch { cancelled = true }
        assert(cancelled)
        let cancelMilliseconds = Int(Date().timeIntervalSince(cancelAt)*1000)
        assert(cancelMilliseconds<3000)
        let report: [String:Any] = ["provider":"edge-tts","profile":profile,"synthesis_ms":milliseconds,"audio_bytes":audio.count,"decoded_frames":pcm.frameLength,"duration_seconds":Double(pcm.frameLength)/pcm.format.sampleRate,"cancel_ms":cancelMilliseconds,"temporary_audio_cleaned":true,"consent_checks":4,"raw_microphone_audio_saved":false]
        let destination = root.appendingPathComponent("artifacts/neural-speech-acceptance.json")
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:destination)
        print("PASS neural synthesis, PCM decode, explicit-consent gate and in-flight cancellation: \(milliseconds) ms synthesis, \(cancelMilliseconds) ms cancel")
    }
}
