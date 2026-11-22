import Foundation

@MainActor
protocol CompanionInteractionGateway: AnyObject {
    var onEvent: ((String,[String:Any]) -> Void)? { get set }
    var onDisconnect: (() -> Void)? { get set }
    func connect() async throws
    func call(_ method: String,_ params: [String:Any],requiresReady: Bool) async throws -> [String:Any]
    func disconnect()
}
extension VoiceGateway: CompanionInteractionGateway {}

enum CompanionInteractionPhase: String {
    case resting, attending, thinking, executing, attention, presenting, cancelling, cancelled, unknown
    var label: String {
        switch self {
        case .resting: return "安静陪着你"
        case .attending: return "我在，想让我做什么？"
        case .thinking: return "正在想怎么做…"
        case .executing: return "正在帮你处理…"
        case .attention: return "这件事需要你看看"
        case .presenting: return "结果在这里"
        case .cancelling: return "正在确认停止，声音已打断"
        case .cancelled: return "这一轮已停止"
        case .unknown: return "结果待确认，不会自动重发"
        }
    }
}

// One native surface owns one stable main-Agent session. Tool cards only accept
// structured local receipts, never filenames or paths inferred from model prose.
@MainActor
final class CompanionInteraction {
    let key: String, identifier: String
    private let defaults: UserDefaults, persistenceKey: String
    private let makeGateway: () throws -> any CompanionInteractionGateway
    private var gateway: (any CompanionInteractionGateway)?
    private var epoch: UInt64 = 0, run: String?, raw = "", sequence = -1
    private var earlyEvents: [(String,[String:Any])] = [], seenTools = Set<String>()
    private(set) var phase: CompanionInteractionPhase = .resting
    private(set) var pending = false, answer = "", toolLabel = "", files: [CompanionFileResult] = []
    private(set) var partial = false, searchReturned = false, toolFailed = false
    private(set) var submitted = false
    var onChange: (() -> Void)?, onReply: ((String) -> Void)?, onInterrupt: (() -> Void)?
    init(root: URL,defaults: UserDefaults = .standard,identifier: String? = nil,makeGateway: (() throws -> any CompanionInteractionGateway)? = nil) {
        self.defaults = defaults
        let stored = defaults.string(forKey:"companion.desktopSession")
        self.identifier = identifier ?? (stored.flatMap { UUID(uuidString:$0)?.uuidString.lowercased() } ?? UUID().uuidString.lowercased())
        if identifier == nil { defaults.set(self.identifier,forKey:"companion.desktopSession") }
        key = "agent:main:anylink:desktop:"+self.identifier
        persistenceKey = "companion.desktopRequest."+self.identifier
        self.makeGateway = makeGateway ?? { try VoiceGateway(root:root) }
        if ["submitted","cancelling","unknown"].contains(defaults.string(forKey:persistenceKey) ?? "") {
            phase = .unknown; defaults.set("unknown",forKey:persistenceKey)
            answer = "上次请求的结果尚未确认。请查看完整记录；我没有重新执行。"
        }
    }
    func engage() {
        if !pending && phase == .resting { phase = .attending }
        onChange?()
    }
    func rest() { guard !pending else { return }; phase = .resting; onChange?() }
    func submit(_ message: String) {
        let text = message.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !pending,!text.isEmpty,text.count<=6000 else { return }
        onInterrupt?(); detach()
        epoch &+= 1; let generation = epoch
        pending = true; submitted = false; run = nil; raw = ""; sequence = -1; answer = ""; files = []
        earlyEvents = []; queuedProjections = []; seenTools = []; partial = false; searchReturned = false; toolFailed = false; toolLabel = ""
        phase = .thinking; onChange?()
        let submission = UUID().uuidString
        Task { [weak self] in
            guard let self,self.epoch == generation,self.pending else { return }
            do {
                let client = try self.makeGateway(); self.gateway = client
                client.onEvent = { [weak self] name,payload in
                    guard let self,self.epoch == generation else { return }; self.event(name,payload)
                }
                client.onDisconnect = { [weak self] in
                    guard let self,self.epoch == generation,self.pending else { return }; self.failUnknown()
                }
                try await client.connect()
                guard self.epoch == generation,self.pending else { client.disconnect(); return }
                _ = try await client.call("sessions.messages.subscribe",["key":self.key,"agentId":"main","subscriptionId":"anylink-desktop"],requiresReady:true)
                guard self.epoch == generation,self.pending else { client.disconnect(); return }
                self.submitted = true; self.defaults.set("submitted",forKey:self.persistenceKey)
                let message = "（桌面就近交互：简短自然地回复，只完成主人本次交代的事。文件名搜索拿到结构化结果后直接交付，不追加读取内容或运行命令，除非主人本次要求。）\n"+text
                let ack = try await client.call("chat.send",["sessionKey":self.key,"agentId":"main","message":message,"thinking":"off","deliver":false,"idempotencyKey":submission,"timeoutMs":180000],requiresReady:true)
                guard let actualRun = ack["runId"] as? String else { throw VoiceFailure.unavailable("请求没有返回任务标识。") }
                // Cancellation can happen while admission is in flight. Abort
                // that exact admitted run; never submit the message again.
                guard self.epoch == generation else {
                    await self.abort(client:client,run:actualRun,cancelEpoch:self.epoch); return
                }
                self.run = actualRun
                self.flushProjections(run:actualRun)
                let buffered = self.earlyEvents; self.earlyEvents = []
                for (name,payload) in buffered { self.event(name,payload) }
            } catch {
                guard self.epoch == generation else { if self.phase == .cancelling { self.failUnknown() }; return }
                if self.submitted { self.failUnknown() }
                else { self.pending = false; self.phase = .attention; self.answer = "还没提交成功，请检查本机 Agent 连接。"; self.detach(); self.onChange?() }
            }
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds:210_000_000_000)
            guard let self,self.epoch == generation,self.pending else { return }; self.failUnknown()
        }
    }
    private func event(_ name: String,_ payload: [String:Any]) {
        guard pending,name == "chat",payload["sessionKey"] as? String == key else { return }
        guard let run else { if earlyEvents.count<256 { earlyEvents.append((name,payload)) }; return }
        guard payload["runId"] as? String == run else { return }
        let state = payload["state"] as? String ?? ""
        if state == "delta" {
            let next = payload["seq"] as? Int ?? 0; guard next>sequence else { return }; sequence = next
            let delta = payload["deltaText"] as? String ?? ""
            raw = payload["replace"] as? Bool == true ? delta : raw+delta
            if raw.count>64000 { failUnknown() }
        } else if state == "final" {
            if let message = payload["message"] as? [String:Any],let content = message["content"] as? [[String:Any]] {
                let final = content.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator:"\n")
                if !final.isEmpty { raw = final }
            }
            answer = String(raw.trimmingCharacters(in:.whitespacesAndNewlines).prefix(12000)); pending = false
            phase = toolFailed || (answer.isEmpty && !searchReturned) ? .attention : .presenting
            if answer.isEmpty { answer = searchReturned ? "搜索已返回，请查看文件结果。" : "本轮没有返回可展示的结果，请查看完整记录。" }
            defaults.set("completed",forKey:persistenceKey); detach(); onChange?(); onReply?(answer)
        } else if state == "aborted" {
            pending = false; phase = .cancelled; defaults.set("cancelled",forKey:persistenceKey); detach(); onChange?()
        } else if state == "error" {
            pending = false; phase = .attention; answer = "这一轮没有完成，请查看完整记录中的错误或审批。"
            defaults.set("failed",forKey:persistenceKey); detach(); onChange?()
        }
    }
    func receive(_ projection: CompanionProjection) {
        guard projection.sessionKey == key,!([.cancelled,.cancelling,.unknown].contains(phase)),submitted else { return }
        // Hook projections can precede chat.send's acknowledgment. The stable
        // turn is bound when the ack arrives; queue receipts until then.
        guard let run else { queuedProjections.append(projection); if queuedProjections.count>64 { queuedProjections.removeFirst() }; return }
        flushProjections(run:run)
        apply(projection,run:run)
    }
    private var queuedProjections: [CompanionProjection] = []
    private func flushProjections(run: String) {
        let queued = queuedProjections; queuedProjections = []
        for projection in queued { apply(projection,run:run) }
    }
    private func apply(_ projection: CompanionProjection,run: String) {
        guard projection.runId == run,["tool_start","tool_result"].contains(projection.type) else { return }
        let id = projection.type+":"+((projection.toolCallId?.isEmpty == false ? projection.toolCallId : nil) ?? projection.id)
        guard seenTools.insert(id).inserted else { return }
        if projection.type == "tool_start",pending {
            phase = .executing; toolLabel = projection.toolName == "anylink_mac_search_files" ? "正在搜索已开放目录中的文件…" : "正在使用本机工具…"
        } else if projection.type == "tool_result" {
            toolFailed = toolFailed || projection.failed == true
            toolLabel = projection.failed == true ? "工具返回了错误，请查看记录" : "工具已返回结果"
            if projection.toolName == "anylink_mac_search_files",projection.failed != true,let result = projection.search,result.read_only,result.name_only {
                searchReturned = true; partial = partial || result.partial
                for file in result.matches where files.count<50 && file.path.hasPrefix("/") && !file.path.contains("\0") && !files.contains(where:{$0.path == file.path}) {
                    files.append(file); if files.count>=50 { break }
                }
                toolLabel = partial ? "已返回 \(files.count) 项 · 搜索范围不完整" : "已返回 \(files.count) 项文件结果"
            }
            if !pending && toolFailed { phase = .attention }
        }
        onChange?()
    }
    func waitingForAttention() { if pending && phase != .cancelling { phase = .attention; onChange?() } }
    func cancel() {
        guard pending,phase != .cancelling else { return }
        onInterrupt?(); epoch &+= 1; let cancelEpoch = epoch
        queuedProjections = []; earlyEvents = []; phase = .cancelling; defaults.set("cancelling",forKey:persistenceKey); onChange?()
        if !submitted { pending = false; phase = .cancelled; defaults.set("cancelled",forKey:persistenceKey); detach(); onChange?(); return }
        guard let client = gateway else { failUnknown(); return }
        client.onEvent = nil; client.onDisconnect = nil
        if let run { Task { await self.abort(client:client,run:run,cancelEpoch:cancelEpoch) } }
        // Otherwise admission owns the client until its ack and exact-run abort.
    }
    private func abort(client: any CompanionInteractionGateway,run: String,cancelEpoch: UInt64) async {
        do {
            let result = try await client.call("chat.abort",["sessionKey":key,"agentId":"main","runId":run,"preserveSideRuns":true,"discardPendingInput":true],requiresReady:true)
            guard epoch == cancelEpoch,phase == .cancelling else { client.disconnect(); return }
            guard result["aborted"] as? Bool == true else { failUnknown(); return }
            pending = false; phase = .cancelled; answer = "本轮已停止。已经发生的操作不会自动撤销。"
            defaults.set("cancelled",forKey:persistenceKey); detach(); onChange?()
        } catch { if epoch == cancelEpoch { failUnknown() }; client.disconnect() }
    }
    private func failUnknown() {
        epoch &+= 1; pending = false; phase = .unknown
        answer = "请求的结果尚未确认。请查看完整记录；我不会自动重新执行。"
        defaults.set("unknown",forKey:persistenceKey); detach(); onChange?()
    }
    func disconnect() { if pending { failUnknown() } else { detach() } }
    private func detach() {
        gateway?.onDisconnect = nil; gateway?.onEvent = nil; gateway?.disconnect(); gateway = nil
    }
}
