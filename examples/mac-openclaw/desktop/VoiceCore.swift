import Foundation

// Some system voices emit more than one zero-length terminal PCM callback.
// Count completion once per utterance across the audio callback queue.
final class VoiceCompletionGate: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    func take() -> Bool { lock.lock(); defer { lock.unlock() }; if completed { return false }; completed = true; return true }
}

// Independent of microphone and network: the same generation owns text/audio.
struct VoiceGeneration {
    private(set) var value: UInt64 = 0
    mutating func advance() -> UInt64 { value &+= 1; return value }
    func accepts(_ candidate: UInt64) -> Bool { candidate == value }
}

struct VoiceUtteranceBuffer {
    private(set) var pending = ""
    private var first = true
    private var fenced = false
    private var ticks = 0
    mutating func append(_ text: String) {
        for character in text {
            if character == "`" { ticks += 1; continue }
            if ticks >= 3 { fenced.toggle() }
            ticks = 0
            if !fenced { pending.append(character) }
        }
    }
    mutating func take(force: Bool = false) -> String? {
        let minimum = first ? 8 : 18
        var count = 0, end: String.Index?
        for index in pending.indices {
            count += 1
            let ch = pending[index]
            if "。！？!?；;\n".contains(ch) || (count >= minimum && "，,：:".contains(ch)) || count >= 68 {
                end = pending.index(after: index); break
            }
        }
        if end == nil && force && !pending.isEmpty { end = pending.endIndex }
        guard let boundary = end else { return nil }
        let raw = String(pending[..<boundary]); pending.removeSubrange(..<boundary)
        let cleaned = raw.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "https?://\\S+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[#*_>|]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return take(force: force) }
        first = false; return cleaned
    }
}

struct VoiceTranscript {
    struct Part { let start: Double; let end: Double; let text: String }
    private(set) var watermark: Double = 0
    private var parts: [Part] = []
    mutating func update(start: Double, end: Double, text: String) {
        guard start.isFinite, end.isFinite, end > watermark, start >= watermark - 0.02 else { return }
        parts.removeAll { $0.start < end && $0.end > start }
        parts.append(Part(start: start, end: end, text: text))
        parts.sort { $0.start < $1.start }
        parts = Array(parts.suffix(80))
    }
    var text: String { parts.filter { $0.end > watermark }.map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines) }
    mutating func commit(through time: Double) { watermark = max(watermark,time); parts.removeAll { $0.end <= watermark } }
}
