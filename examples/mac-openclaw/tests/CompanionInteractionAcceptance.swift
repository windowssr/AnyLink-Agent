import Foundation

@main struct CompanionInteractionAcceptance {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
        let name = "anylink.interaction.acceptance."+UUID().uuidString, defaults = UserDefaults(suiteName:name)!
        defer { defaults.removePersistentDomain(forName:name) }
        let chat = CompanionInteraction(root:root,defaults:defaults,identifier:UUID().uuidString.lowercased())
        var phases: [String] = [], spoken = 0, seen = Set<String>()
        chat.onChange = { if phases.last != chat.phase.rawValue { phases.append(chat.phase.rawValue) } }
        chat.onReply = { _ in spoken += 1 }
        chat.engage(); let began = Date(),started = began.timeIntervalSince1970*1000
        chat.submit("请使用 anylink_mac_search_files 只读工具，按文件名搜索 CompanionInteractionTests.swift，scope=projects，limit=3。不要读文件内容、不保存记忆、不使用其他工具；最后用一句话说明实际搜索结果。")
        let folder = root.appendingPathComponent("data/mac/companion/events"), deadline = Date().addingTimeInterval(150)
        var completedAt: Date?
        repeat {
            let files = (try? FileManager.default.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil)) ?? []
            for file in files where !seen.contains(file.lastPathComponent) && file.pathExtension == "json" {
                seen.insert(file.lastPathComponent)
                if let data = try? Data(contentsOf:file),let projection = try? JSONDecoder().decode(CompanionProjection.self,from:data),projection.valid(now:Date().timeIntervalSince1970*1000,started:started) { chat.receive(projection) }
            }
            if !chat.pending && completedAt == nil { completedAt = Date() }
            try await Task.sleep(nanoseconds:100_000_000)
        } while (chat.pending || (!chat.searchReturned && chat.phase == .presenting && Date().timeIntervalSince(completedAt ?? Date())<2)) && Date()<deadline
        let expected = root.appendingPathComponent("examples/mac-openclaw/tests/CompanionInteractionTests.swift").path
        guard chat.phase == .presenting,chat.files.contains(where:{$0.path == expected}),spoken == 1,!chat.answer.isEmpty else {
            chat.disconnect(); print("FAIL: phase=\(chat.phase.rawValue), receipts=\(chat.files.count), spoken=\(spoken), phases=\(phases)"); exit(1)
        }
        chat.rest(); precondition(chat.phase == .resting)
        let report: [String:Any] = ["passed":true,"elapsed_ms":Int(Date().timeIntervalSince(began)*1000),"phases":phases,"verified_file":expected,"file_count":chat.files.count,"partial":chat.partial,"reply_count":spoken,"session":chat.key,"automatic_replay":false]
        try JSONSerialization.data(withJSONObject:report,options:.prettyPrinted).write(to:root.appendingPathComponent("artifacts/desktop-interaction-acceptance.json"))
        print("PASS: real model, main Agent, structured file receipt, one final reply and return to rest; phases=\(phases)")
    }
}
