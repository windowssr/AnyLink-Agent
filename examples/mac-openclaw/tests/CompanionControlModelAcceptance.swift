import Foundation

@main struct CompanionControlModelAcceptance {
    @MainActor static func main() async {
        do {
            let root = URL(fileURLWithPath:FileManager.default.currentDirectoryPath),gateway = try VoiceGateway(root:root)
            let receipts = root.appendingPathComponent("data/mac/companion/control/receipts")
            let before = Set(try FileManager.default.contentsOfDirectory(atPath:receipts.path))
            try await gateway.connect()
            let key = "agent:main:anylink:companion-control-proof:"+UUID().uuidString.lowercased()
            _ = try await gateway.call("sessions.messages.subscribe",["key":key,"agentId":"main","subscriptionId":"companion-control-proof"])
            var terminal = "",characters = 0
            gateway.onEvent = { name,event in
                guard name == "chat",event["sessionKey"] as? String == key else { return }
                if let state = event["state"] as? String,["final","error","aborted"].contains(state) {
                    terminal = state
                    if let message = event["message"] as? [String:Any],let content = message["content"] as? [[String:Any]] { characters = content.compactMap { $0["text"] as? String }.joined().count }
                }
            }
            let prompt = "这是桌宠对话控制验收：请用桌宠管理工具查看状态，先缩小成小号，再恢复标准大小并回到右下角；先安静一分钟，再立即恢复，最后保持主动聊天、自由行走、语音播报全部开启。请实际调用工具，按回执用一句话确认。不要操作其他软件，不写文件或长期记忆。"
            let began = Date(),ack = try await gateway.call("chat.send",["sessionKey":key,"agentId":"main","message":prompt,"thinking":"off","deliver":false,"idempotencyKey":UUID().uuidString,"timeoutMs":90000])
            while terminal.isEmpty && Date().timeIntervalSince(began)<100 { try await Task.sleep(nanoseconds:100_000_000) }
            if terminal.isEmpty {
                if let run = ack["runId"] as? String { _ = try? await gateway.call("chat.abort",["sessionKey":key,"agentId":"main","runId":run,"preserveSideRuns":true]) }
                throw VoiceFailure.unavailable("Acceptance result unknown; no automatic resubmission")
            }
            let after = Set(try FileManager.default.contentsOfDirectory(atPath:receipts.path))
            let results = try after.subtracting(before).map { try JSONSerialization.jsonObject(with:Data(contentsOf:receipts.appendingPathComponent($0))) as! [String:Any] }
            let states = results.compactMap { $0["state"] as? [String:Any] }
            guard terminal == "final",states.contains(where:{ ($0["scale"] as? Double) == 0.8 }),states.contains(where:{ ($0["scale"] as? Double) == 1 }),states.contains(where:{ ($0["quiet_until"] as? Double ?? 0)>began.timeIntervalSince1970 }) else { throw VoiceFailure.unavailable("Missing real native changes; terminal=\(terminal), receipts=\(results.count)") }
            let snapshot = try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("data/mac/desktop/companion-state.json"))) as! [String:Any]
            guard snapshot["roaming_enabled"] as? Bool == true,snapshot["proactive_enabled"] as? Bool == true,snapshot["read_aloud"] as? Bool == true,snapshot["snoozed"] as? Bool == false else { throw VoiceFailure.unavailable("Default companion behaviors were not restored") }
            let report: [String:Any] = ["passed":true,"session":key,"terminal":terminal,"native_receipts":results.count,"small_and_standard_observed":true,"quiet_and_resume_observed":true,"defaults_restored":true,"reply_characters":characters,"elapsed_ms":Int(Date().timeIntervalSince(began)*1000)]
            try JSONSerialization.data(withJSONObject:report,options:.prettyPrinted).write(to:root.appendingPathComponent("artifacts/companion-v0.6-model-acceptance.json"))
            print("PASS real model → native controls → receipts: \(results.count) actions, \(Int(Date().timeIntervalSince(began)*1000)) ms")
            gateway.disconnect()
        } catch { print("FAIL: \(error.localizedDescription)");exit(1) }
    }
}
