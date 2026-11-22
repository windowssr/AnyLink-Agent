import Foundation

@MainActor
private final class FakeInteractionGateway: CompanionInteractionGateway {
    var onEvent: ((String,[String:Any]) -> Void)?, onDisconnect: (() -> Void)?
    var calls: [String] = [], sentKey = "", abortRun = "", holdAdmission = false, abortSucceeded = true
    var admission: CheckedContinuation<[String:Any],Error>?
    func connect() async throws {}
    func call(_ method: String,_ params: [String:Any],requiresReady: Bool) async throws -> [String:Any] {
        calls.append(method)
        if method == "chat.send" {
            sentKey = params["sessionKey"] as? String ?? ""
            if holdAdmission { return try await withCheckedThrowingContinuation { admission = $0 } }
            return ["runId":"owned-run"]
        }
        if method == "chat.abort" { abortRun = params["runId"] as? String ?? ""; return ["aborted":abortSucceeded] }
        return [:]
    }
    func disconnect() {}
    func emit(_ state: String,run: String = "owned-run",text: String = "",seq: Int = 1) {
        var payload: [String:Any] = ["sessionKey":sentKey,"runId":run,"state":state,"deltaText":text,"seq":seq]
        if state == "final" && !text.isEmpty { payload["message"] = ["content":[["type":"text","text":text]]] }
        onEvent?("chat",payload)
    }
}

@main struct CompanionInteractionTests {
    @MainActor static func main() async throws {
        let suite = "anylink.interaction.tests."+UUID().uuidString, defaults = UserDefaults(suiteName:suite)!
        defer { defaults.removePersistentDomain(forName:suite) }
        let root = URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
        func make(_ gateway: FakeInteractionGateway,id: String = UUID().uuidString) -> CompanionInteraction {
            CompanionInteraction(root:root,defaults:defaults,identifier:id,makeGateway:{ gateway })
        }
        func drain() async { for _ in 0..<12 { await Task.yield() } }
        func receipt(_ key: String,run: String = "owned-run",path: String = "/tmp/verified.txt",failed: Bool = false) throws -> CompanionProjection {
            let data = try JSONSerialization.data(withJSONObject:["id":UUID().uuidString,"type":"tool_result","created_at":1,"expires_at":100,"agentId":"main","sessionId":"s","sessionKey":key,"runId":run,"toolName":"anylink_mac_search_files","toolCallId":"call-one","failed":failed,"search":["query":"verified","read_only":true,"name_only":true,"partial":true,"matches":[["name":"verified.txt","path":path]]]])
            return try JSONDecoder().decode(CompanionProjection.self,from:data)
        }
        let gateway = FakeInteractionGateway(), interaction = make(gateway)
        var replies = 0; interaction.onReply = { _ in replies += 1 }
        interaction.engage(); precondition(interaction.phase == .attending)
        interaction.submit("搜索 verified"); interaction.submit("不能重复提交"); await drain()
        precondition(gateway.calls.filter{$0 == "chat.send"}.count == 1)
        interaction.receive(try receipt(interaction.key,run:"unrelated")); precondition(interaction.files.isEmpty)
        interaction.receive(try receipt(interaction.key)); interaction.receive(try receipt(interaction.key))
        precondition(interaction.files.count == 1 && interaction.partial)
        gateway.emit("delta",text:"真实结果"); gateway.emit("delta",text:"重复片段",seq:1)
        gateway.emit("final"); gateway.emit("final")
        precondition(interaction.answer == "真实结果" && replies == 1 && interaction.phase == .presenting)
        interaction.rest(); precondition(interaction.phase == .resting)
        print("PASS: main session, single submission, scoped receipts, ordered text and return to rest")

        let earlyGateway = FakeInteractionGateway(); earlyGateway.holdAdmission = true
        let early = make(earlyGateway); early.submit("搜索文件"); await drain()
        early.receive(try receipt(early.key)); earlyGateway.emit("delta",text:"提前到达的回复"); earlyGateway.emit("final")
        precondition(early.pending && early.files.isEmpty)
        earlyGateway.admission?.resume(returning:["runId":"owned-run"]); earlyGateway.admission = nil; await drain()
        precondition(early.files.count == 1 && early.answer == "提前到达的回复" && !early.pending)
        print("PASS: tool receipt and final event arriving before admission ack are reconciled")

        let cancelledGateway = FakeInteractionGateway(); cancelledGateway.holdAdmission = true
        let cancelled = make(cancelledGateway); var staleSpoken = false; cancelled.onReply = { _ in staleSpoken = true }
        cancelled.submit("搜索文件"); await drain(); cancelled.cancel()
        precondition(cancelled.phase == .cancelling)
        cancelledGateway.admission?.resume(returning:["runId":"admitted-late"]); cancelledGateway.admission = nil; await drain()
        precondition(cancelledGateway.abortRun == "admitted-late" && cancelled.phase == .cancelled && !cancelled.pending)
        cancelledGateway.emit("final",run:"admitted-late",text:"迟到的结果")
        cancelled.receive(try receipt(cancelled.key,run:"admitted-late"))
        precondition(!staleSpoken && cancelled.files.isEmpty)
        print("PASS: cancellation during admission aborts exact run and rejects late speech/results")

        let lostGateway = FakeInteractionGateway(), id = UUID().uuidString
        let lost = make(lostGateway,id:id); lost.submit("运行一次"); await drain(); lostGateway.onDisconnect?()
        precondition(lost.phase == .unknown && !lost.pending)
        let restoredGateway = FakeInteractionGateway(), restored = make(restoredGateway,id:id)
        precondition(restored.phase == .unknown && restoredGateway.calls.isEmpty)
        let noAbort = FakeInteractionGateway(); noAbort.abortSucceeded = false
        let uncertain = make(noAbort); uncertain.submit("运行一次"); await drain(); uncertain.cancel(); await drain()
        precondition(uncertain.phase == .unknown)
        print("PASS: disconnect/relaunch/uncertain cancellation never replay or claim completion")

        let failedGateway = FakeInteractionGateway(), failed = make(failedGateway)
        failed.submit("搜索文件"); await drain(); failed.receive(try receipt(failed.key,failed:true)); failedGateway.emit("final",text:"")
        precondition(failed.phase == .attention && failed.files.isEmpty)
        print("PASS: failed tool receipts cannot become successful file cards")

        let immediateGateway = FakeInteractionGateway(), immediate = make(immediateGateway)
        immediate.submit("刚刚点错了"); immediate.cancel(); await drain()
        precondition(immediateGateway.calls.isEmpty && immediate.phase == .cancelled)
        immediate.submit("新的明确请求"); await drain()
        precondition(immediateGateway.calls.filter{$0 == "chat.send"}.count == 1)
        immediateGateway.emit("final",text:"新请求完成"); await drain(); precondition(immediate.phase == .presenting)
        print("PASS: cancellation before connection cannot attach an obsolete client to a new turn")
    }
}
