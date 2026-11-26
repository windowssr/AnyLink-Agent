import Foundation
import AVFoundation

enum NeuralSpeechFailure: Error { case unavailable, synthesis, format }

private final class NeuralSpeechJob: @unchecked Sendable {
    let process = Process()
    private let lock = NSLock()
    private var cancelled = false
    func launch() throws { lock.lock(); defer { lock.unlock() }; if cancelled { throw CancellationError() }; try process.run() }
    func cancel() { lock.lock(); cancelled = true; let running = process.isRunning; lock.unlock(); if running { process.terminate() } }
}

enum NeuralSpeech {
    static func label(profile: String?) -> String {
        switch profile { case "sweet-lively": return "活泼甜妹"; case "sweet-warm": return "温柔甜妹"; default: return "系统中文女声" }
    }
    static func profile(root: URL) -> String? {
        let file = root.appendingPathComponent("data/mac/voice/neural.json")
        guard let data = try? Data(contentsOf:file),let value = try? JSONSerialization.jsonObject(with:data) as? [String:Any],value["enabled"] as? Bool == true,value["consent_microsoft"] as? Bool == true,value["provider"] as? String == "edge-tts",let profile = value["profile"] as? String,["sweet-lively","sweet-warm"].contains(profile) else { return nil }
        return profile
    }
    static func synthesize(_ text: String,root: URL,profile: String) async throws -> Data {
        let job = NeuralSpeechJob(),input = Pipe(),output = Pipe()
        job.process.executableURL = root.appendingPathComponent("data/mac/voice/neural-venv/bin/python")
        job.process.arguments = [root.appendingPathComponent("examples/mac-openclaw/voice/synthesize.py").path]
        job.process.standardInput = input; job.process.standardOutput = output; job.process.standardError = FileHandle.nullDevice
        let request = try JSONSerialization.data(withJSONObject:["text":String(text.prefix(1400)),"profile":profile])
        let task = Task.detached(priority:.userInitiated) { () throws -> Data in
            try Task.checkCancellation(); try job.launch()
            try input.fileHandleForWriting.write(contentsOf:request); try input.fileHandleForWriting.close()
            let data = output.fileHandleForReading.readDataToEndOfFile(); job.process.waitUntilExit(); try Task.checkCancellation()
            guard job.process.terminationStatus == 0,data.count<1500000,let value = try JSONSerialization.jsonObject(with:data) as? [String:String],value["format"] == "mp3",let encoded = value["audio"],let audio = Data(base64Encoded:encoded),audio.count>100 else { throw NeuralSpeechFailure.synthesis }
            return audio
        }
        DispatchQueue.global().asyncAfter(deadline:.now()+30) { job.cancel() }
        return try await withTaskCancellationHandler(operation:{ try await task.value },onCancel:{ job.cancel(); task.cancel() })
    }
    static func decode(_ data: Data,root: URL) throws -> AVAudioPCMBuffer {
        // Only synthesized output briefly touches this private directory for
        // AVFoundation decoding. Microphone PCM is never written here.
        let folder = root.appendingPathComponent("data/mac/voice/generated",isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let file = folder.appendingPathComponent(UUID().uuidString+".mp3")
        defer { try? FileManager.default.removeItem(at:file) }
        try data.write(to:file,options:.atomic); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        let reader = try AVAudioFile(forReading:file)
        guard reader.length>0,reader.length<=AVAudioFramePosition(reader.processingFormat.sampleRate*180),let pcm = AVAudioPCMBuffer(pcmFormat:reader.processingFormat,frameCapacity:AVAudioFrameCount(reader.length)) else { throw NeuralSpeechFailure.format }
        try reader.read(into:pcm); return pcm
    }
}
