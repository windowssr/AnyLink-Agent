import Foundation

struct CompanionCommand: Decodable {
    let action: String
    let roaming: Bool?, proactive: Bool?, read_aloud: Bool?
    let minutes: Int?, scale: Double?
    var valid: Bool {
        switch action {
        case "configure": return roaming != nil || proactive != nil || read_aloud != nil
        case "quiet": return minutes.map { (0...720).contains($0) } ?? false
        case "resize": return scale.map { [0.8,1,1.25].contains($0) } ?? false
        default: return ["status","walk","pet","reset_position","reload","show","hide","open_chat","open_voice","stop_speaking","chat_now","credits"].contains(action)
        }
    }
}
private struct CompanionControlRequest: Decodable {
    let id: String, epoch: String
    let created_at: Double, expires_at: Double
    let command: CompanionCommand
}

@MainActor final class CompanionControlServer {
    private let folder: URL
    private let epoch = UUID().uuidString
    private let started = Date().timeIntervalSince1970*1000
    private var timer: Timer?, leaseAt = Date.distantPast, paused = false
    var onCommand: ((CompanionCommand) -> [String:Any])?
    init(root: URL) { folder = root.appendingPathComponent("data/mac/companion/control") }
    func start() {
        for name in ["requests","receipts"] { try? FileManager.default.createDirectory(at:folder.appendingPathComponent(name),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]) }
        lease(enabled:true)
        timer = Timer.scheduledTimer(withTimeInterval:0.2,repeats:true) { [weak self] _ in Task { @MainActor in self?.poll() } }
    }
    func pause(_ value: Bool) { paused = value; lease(enabled:!value) }
    func stop() { timer?.invalidate(); timer = nil; lease(enabled:false) }
    private func write(_ value: [String:Any],to url: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject:value) else { return }
        try? data.write(to:url,options:.atomic); try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    }
    private func lease(enabled: Bool) { leaseAt = Date(); write(["enabled":enabled,"epoch":epoch,"expires_at":Date().timeIntervalSince1970*1000+45000],to:folder.appendingPathComponent("presence.json")) }
    func poll() {
        let now = Date().timeIntervalSince1970*1000
        if Date().timeIntervalSince(leaseAt)>10 { lease(enabled:!paused) }
        let requests = folder.appendingPathComponent("requests"),receipts = folder.appendingPathComponent("receipts")
        for file in (try? FileManager.default.contentsOfDirectory(at:requests,includingPropertiesForKeys:nil)) ?? [] where file.pathExtension == "json" {
            guard file.deletingPathExtension().lastPathComponent.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else { continue }
            let receipt = receipts.appendingPathComponent(file.lastPathComponent)
            defer { try? FileManager.default.removeItem(at:file) }
            if FileManager.default.fileExists(atPath:receipt.path) { continue }
            guard let data = try? Data(contentsOf:file),data.count<4096,let value = try? JSONDecoder().decode(CompanionControlRequest.self,from:data),value.id == file.deletingPathExtension().lastPathComponent else { continue }
            let valid = !paused && value.epoch == epoch && value.created_at.isFinite && value.expires_at.isFinite && value.created_at>=started && value.created_at<=now+1000 && value.expires_at>=now && value.expires_at-value.created_at<=12000 && value.command.valid
            let result = valid ? (onCommand?(value.command) ?? ["status":"desktop_unavailable","applied":false]) : ["status":"expired_or_invalid","applied":false]
            write(result.merging(["request_id":value.id,"completed_at":now]) { current,_ in current },to:receipt)
        }
        // Bounded acknowledgement retention; pending requests expire on their
        // original epoch and are never replayed after application restart.
        let files = ((try? FileManager.default.contentsOfDirectory(at:receipts,includingPropertiesForKeys:[.contentModificationDateKey])) ?? []).sorted { $0.lastPathComponent<$1.lastPathComponent }
        for file in files {
            let modified = (try? file.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? Date()
            if Date().timeIntervalSince(modified)>3600 { try? FileManager.default.removeItem(at:file) }
        }
    }
}
