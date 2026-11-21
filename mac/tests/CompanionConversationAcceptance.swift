import Foundation
@main struct CompanionConversationAcceptance {
    @MainActor static func main() async {
        let chat = CompanionConversation(root:URL(fileURLWithPath:FileManager.default.currentDirectoryPath))
        var text = "",failed = false
        chat.onText = { text = $0 }; chat.onFailure = { failed = true }
        let began = Date(); chat.initiate(manual:true)
        while chat.pending && Date().timeIntervalSince(began)<100 { try? await Task.sleep(nanoseconds:100_000_000) }
        guard !failed,!text.isEmpty,!chat.pending else { print("FAIL: companion conversation did not complete");chat.stop();exit(1) }
        print("PASS: native companion chat completed; characters=\(text.count), elapsed_ms=\(Int(Date().timeIntervalSince(began)*1000))")
    }
}
