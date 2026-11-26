import Foundation

@main struct VoiceGatewayAcceptance {
    @MainActor static func main() async {
        do {
            let root = URL(fileURLWithPath:FileManager.default.currentDirectoryPath), gateway = try VoiceGateway(root:root)
            try await gateway.connect(); print("PASS: signed native voice client authenticated")
            let key = "agent:main:anylink:voice-proof:"+UUID().uuidString.lowercased()
            _ = try await gateway.call("sessions.messages.subscribe",["key":key,"agentId":"main","subscriptionId":"voice-acceptance"])
            let began = ProcessInfo.processInfo.systemUptime, id = UUID().uuidString
            var first: Double?, terminal = false, reply = "", run = ""
            gateway.onEvent = { name,event in
                guard name == "chat", event["sessionKey"] as? String == key else { return }
                if event["state"] as? String == "delta" {
                    if first == nil { first = ProcessInfo.processInfo.systemUptime }
                    let delta = event["deltaText"] as? String ?? ""; reply = event["replace"] as? Bool == true ? delta : reply+delta
                }
                if event["state"] as? String == "final",reply.isEmpty,let message = event["message"] as? [String:Any],let content = message["content"] as? [[String:Any]] {
                    reply = content.compactMap { $0["text"] as? String }.joined(); if !reply.isEmpty,first == nil { first = ProcessInfo.processInfo.systemUptime }
                }
                if ["final","error","aborted"].contains(event["state"] as? String ?? "") { terminal = true }
            }
            let ack = try await gateway.call("chat.send",["sessionKey":key,"agentId":"main","message":"请只回复：语音链路已连接。","thinking":"off","deliver":false,"idempotencyKey":id])
            run = ack["runId"] as? String ?? ""
            let deadline = ProcessInfo.processInfo.systemUptime+120
            while !terminal && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(nanoseconds:100_000_000) }
            guard terminal,!reply.isEmpty,let first else { throw VoiceFailure.unavailable("Native reply did not complete; terminal=\(terminal), characters=\(reply.count)") }
            print("PASS: real streamed reply, first text \(Int((first-began)*1000)) ms")
            let duplicate = try await gateway.call("chat.send",["sessionKey":key,"agentId":"main","message":"请只回复：语音链路已连接。","thinking":"off","deliver":false,"idempotencyKey":id])
            guard duplicate["runId"] as? String == run else { throw VoiceFailure.unavailable("Submission deduplication changed run") }
            print("PASS: same submission reconciles to the same run")
            let abortID = UUID().uuidString; var shouldAbort = false, aborted = false, completedBeforeAbort = false, targetRun = abortID
            gateway.onEvent = { name,event in
                guard name == "chat",event["sessionKey"] as? String == key,event["runId"] as? String == targetRun else { return }
                if event["state"] as? String == "delta" { shouldAbort = true }
                if event["state"] as? String == "aborted" { aborted = true }
                if event["state"] as? String == "final" { completedBeforeAbort = true }
            }
            let second = try await gateway.call("chat.send",["sessionKey":key,"agentId":"main","message":"这是取消流式回复的独立验收，不调用工具。请逐条写出1000句不同的工作鼓励语，每句至少十个字，不先概述，不省略条目。","thinking":"off","deliver":false,"idempotencyKey":abortID])
            let abortRun = second["runId"] as? String ?? abortID
            targetRun = abortRun
            let firstDeadline = ProcessInfo.processInfo.systemUptime+90
            while !shouldAbort && !completedBeforeAbort && ProcessInfo.processInfo.systemUptime < firstDeadline { try await Task.sleep(nanoseconds:50_000_000) }
            let abortBegan = ProcessInfo.processInfo.systemUptime
            let result = try await gateway.call("chat.abort",["sessionKey":key,"agentId":"main","runId":abortRun,"preserveSideRuns":true,"discardPendingInput":true])
            let abortAckMs = Int((ProcessInfo.processInfo.systemUptime-abortBegan)*1000)
            let abortDeadline = ProcessInfo.processInfo.systemUptime+15
            while !aborted && !completedBeforeAbort && ProcessInfo.processInfo.systemUptime < abortDeadline { try await Task.sleep(nanoseconds:100_000_000) }
            guard result["aborted"] as? Bool == true || aborted || completedBeforeAbort else { throw VoiceFailure.unavailable("Named run abort was not acknowledged") }
            let report: [String:Any] = ["passed":true,"session":key,"first_text_ms":Int((first-began)*1000),"abort_ack_ms":abortAckMs,"aborted_event":aborted,"completed_before_abort":completedBeforeAbort,"raw_audio_saved":false]
            let data = try JSONSerialization.data(withJSONObject:report,options:.prettyPrinted)
            try data.write(to:root.appendingPathComponent("artifacts/voice/gateway-acceptance.json"))
            print("PASS: exact-run cancellation reconciled in \(abortAckMs) ms; aborted=\(aborted), already_completed=\(completedBeforeAbort)")
            gateway.disconnect()
        } catch { print("FAIL: \(error.localizedDescription)"); exit(1) }
    }
}
