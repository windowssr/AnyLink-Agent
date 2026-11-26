import AppKit
import AVFoundation

@MainActor
protocol VoiceControlling: AnyObject {
    func show()
    func stop()
    func shutdown() async
    func interruptOutput()
}

@available(macOS 26.0, *)
@MainActor
final class VoiceCoordinator: NSObject, VoiceControlling, NSWindowDelegate {
    var onActivity: ((Bool,Bool) -> Void)?
    private final class Turn {
        let generation: UInt64, submission = UUID().uuidString
        let sent = ProcessInfo.processInfo.systemUptime
        var run: String?, cancelled = false, terminal = false
        var raw = "", sequence = -1, chunker = VoiceUtteranceBuffer()
        var firstToken: Double?, firstAudio: Double?
        var speechEnded: Double
        init(generation: UInt64,speechEnded: Double) { self.generation = generation; self.speechEnded = speechEnded }
    }
    private let root: URL, gateway: VoiceGateway, audio = VoiceAudio(), recognition = VoiceRecognition()
    private let openChat: (String) -> Void
    private var panel: NSPanel?
    private let status = NSTextField(wrappingLabelWithString:"点击开始后收音，停止或关闭此面板即关闭麦克风。")
    private let caption = NSTextField(wrappingLabelWithString:"你说的话会在这里实时显示。")
    private let response = NSTextView()
    private let metricsLabel = NSTextField(wrappingLabelWithString:"本地中文识别 · 本地中文播报 · DeepSeek Flash")
    private let startButton = NSButton(title:"开始语音聊天",target:nil,action:nil)
    private let sendButton = NSButton(title:"说完了，立即发送",target:nil,action:nil)
    private var generation = VoiceGeneration(), transcript = VoiceTranscript()
    private var turns: [String:Turn] = [:], active: Turn?, playbackTurn: Turn?
    private var earlyEvents: [[String:Any]] = []
    private var timer: Timer?, startTask: Task<Void,Never>?
    private var running = false, outputPlaying = false, finalizing = false
    private var audioPosition = 0.0, speechStart = 0.0, lastSpeech = 0.0, lastText = 0.0, noise = 0.001
    private var speechLatched = false
    private var metrics: [[String:Any]] = []
    private let sessionID: String
    private var sessionKey: String { "agent:main:anylink:voice:"+sessionID }
    init(root: URL,openChat: @escaping (String) -> Void) throws {
        self.root = root; self.openChat = openChat; gateway = try VoiceGateway(root:root)
        let stored = UserDefaults.standard.string(forKey:"voiceSessionID")
        sessionID = (stored.flatMap { UUID(uuidString:$0)?.uuidString } ?? UUID().uuidString).lowercased()
        UserDefaults.standard.set(sessionID,forKey:"voiceSessionID")
        super.init()
        audio.configureNeural(root:root)
        metricsLabel.stringValue = "本地中文识别 · "+NeuralSpeech.label(profile:NeuralSpeech.profile(root:root))+" · DeepSeek Flash"
        gateway.onEvent = { [weak self] name,payload in self?.event(name,payload) }
        gateway.onDisconnect = { [weak self] in self?.connectionLost() }
        recognition.onText = { [weak self] start,end,text,_ in
            guard let self, self.running else { return }
            self.transcript.update(start:start,end:end,text:text)
            self.caption.stringValue = self.transcript.text
            self.lastText = ProcessInfo.processInfo.systemUptime
        }
        recognition.onError = { [weak self] message in self?.stop(); self?.status.stringValue = message }
        audio.onLevel = { [weak self] level,position in self?.level(level,position) }
        audio.onError = { [weak self] message in self?.stop(); self?.status.stringValue = message }
        audio.onSpeechError = { [weak self] message in self?.status.stringValue = message }
        audio.onOutput = { [weak self] playing in
            guard let self else { return }; self.outputPlaying = playing; self.onActivity?(self.running,playing)
            if self.running { self.status.stringValue = playing ? "正在回复 · 直接开口或点“打断”即可停止" : (self.active == nil ? "正在听 · 说完稍停就会发送" : "正在思考 · 可以随时打断") }
        }
        audio.onFirstBuffer = { [weak self] in
            guard let self, let turn = self.playbackTurn, !turn.cancelled, self.generation.accepts(turn.generation), turn.firstAudio == nil else { return }
            turn.firstAudio = ProcessInfo.processInfo.systemUptime
            let latency = Int((turn.firstAudio!-turn.speechEnded)*1000)
            self.metricsLabel.stringValue = "停顿至首段音频调度：\(latency) ms · 开口可打断"
            self.record(["kind":"first_audio_scheduled","milliseconds":latency,"first_text_ms":Int(((turn.firstToken ?? turn.sent)-turn.sent)*1000)])
        }
    }
    func show() {
        if panel == nil {
            let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 15
            stack.edgeInsets = NSEdgeInsets(top:24,left:26,bottom:24,right:26)
            let title = NSTextField(labelWithString:"和你的 Mac 助理说话"); title.font = .systemFont(ofSize:22,weight:.semibold)
            let speechDetail = NeuralSpeech.profile(root:root) == nil ? "回复使用本机系统语音。" : "回复文字发送给微软在线神经语音，声音在本机播放。"
            let detail = NSTextField(wrappingLabelWithString:"麦克风与中文识别在本机；识别文字经本机 OpenClaw → ywc → DeepSeek。"+speechDetail+"原始麦克风音频不上传、不保存。")
            detail.preferredMaxLayoutWidth = 610; detail.textColor = .secondaryLabelColor
            status.font = .systemFont(ofSize:14,weight:.medium); status.setAccessibilityIdentifier("anylink.voice.status")
            caption.font = .systemFont(ofSize:16); caption.preferredMaxLayoutWidth = 610; caption.setAccessibilityIdentifier("anylink.voice.transcript")
            response.isEditable = false; response.isSelectable = true; response.font = .systemFont(ofSize:15)
            response.textContainerInset = NSSize(width:10,height:10); response.setAccessibilityLabel("语音回复文字")
            let scroll = NSScrollView(); scroll.documentView = response; scroll.hasVerticalScroller = true
            scroll.widthAnchor.constraint(equalToConstant:610).isActive = true; scroll.heightAnchor.constraint(equalToConstant:230).isActive = true
            startButton.target = self; startButton.action = #selector(start); startButton.bezelStyle = .rounded
            let interrupt = NSButton(title:"打断回复",target:self,action:#selector(interruptButton)); interrupt.bezelStyle = .rounded
            let end = NSButton(title:"结束语音",target:self,action:#selector(endButton)); end.bezelStyle = .rounded
            sendButton.target = self; sendButton.action = #selector(sendNow); sendButton.bezelStyle = .rounded
            let controls = NSStackView(views:[startButton,interrupt,end,sendButton]); controls.spacing = 10
            let records = NSButton(title:"在聊天中查看完整记录和工具结果",target:self,action:#selector(showRecords)); records.bezelStyle = .rounded
            metricsLabel.font = .systemFont(ofSize:11); metricsLabel.textColor = .secondaryLabelColor
            for view in [title,detail,status,caption,scroll,controls,records,metricsLabel] { stack.addArrangedSubview(view) }
            let panel = NSPanel(contentRect:NSRect(x:0,y:0,width:662,height:530),styleMask:[.titled,.closable],backing:.buffered,defer:false)
            panel.title = "AnyLink · 语音聊天"; panel.contentView = stack; panel.isReleasedWhenClosed = false; panel.delegate = self; panel.center(); self.panel = panel
        }
        panel?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
    }
    @objc private func start() {
        guard !running, startTask == nil else { return }
        startButton.isEnabled = false; status.stringValue = "正在准备麦克风和本地语音模型…"
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                let permission = AVCaptureDevice.authorizationStatus(for:.audio)
                var allowed = permission == .authorized
                if permission == .notDetermined { allowed = await AVCaptureDevice.requestAccess(for:.audio) }
                guard allowed else { throw VoiceFailure.unavailable("请在系统设置 → 隐私与安全性 → 麦克风，为 AnyLink 开启权限。") }
                try Task.checkCancellation(); try await self.gateway.connect()
                _ = try await self.gateway.call("sessions.messages.subscribe",["key":self.sessionKey,"agentId":"main","subscriptionId":"anylink-voice"])
                try Task.checkCancellation()
                let (format,feed) = try await self.recognition.prepare()
                try Task.checkCancellation(); self.transcript = VoiceTranscript(); self.audioPosition = 0; self.lastSpeech = 0; self.speechStart = 0; self.speechLatched = false
                try self.audio.start(format:format,feed:feed)
                self.running = true; self.onActivity?(true,false); self.status.stringValue = "正在听 · 说完稍停就会发送"
                self.timer = Timer.scheduledTimer(withTimeInterval:0.1,repeats:true) { [weak self] _ in Task { @MainActor in self?.tick() } }
            } catch { self.audio.stop(); self.recognition.stop(); self.status.stringValue = (error as? VoiceFailure)?.localizedDescription ?? "语音准备失败，请检查麦克风和本机连接后重试。" }
            self.startTask = nil; self.startButton.isEnabled = true
        }
    }
    private func level(_ rms: Double,_ position: Double) {
        guard running else { return }; audioPosition = position
        let now = ProcessInfo.processInfo.systemUptime
        let threshold = max(0.006,noise*3.5)
        if rms > threshold {
            if speechStart == 0 { speechStart = now }
            lastSpeech = now
            if now-speechStart >= 0.12 && !speechLatched {
                speechLatched = true
                if active != nil || audio.hasOutput { interrupt(reason:"speech") }
            }
        } else {
            if !outputPlaying && !speechLatched { noise = noise*0.98+min(rms,0.006)*0.02 }
            if now-lastSpeech > 0.18 { speechStart = 0 }
        }
    }
    private func tick() {
        guard running else { return }; let now = ProcessInfo.processInfo.systemUptime
        if let turn = active, generation.accepts(turn.generation), now-(turn.firstToken ?? now) > 0.35, turn.chunker.pending.count >= 8, turn.firstAudio == nil {
            if let chunk = turn.chunker.take(force:true) { audio.speak(chunk) }
        }
        if speechLatched && now-lastSpeech > 0.65 && now-lastText > 0.2 && !transcript.text.isEmpty { finishUtterance() }
    }
    @objc private func sendNow() { if running && !transcript.text.isEmpty { finishUtterance() } }
    private func finishUtterance() {
        guard !finalizing else { return }; finalizing = true
        let cut = audioPosition, ended = lastSpeech > 0 ? lastSpeech : ProcessInfo.processInfo.systemUptime
        Task { [weak self] in
            guard let self else { return }
            await self.recognition.finalize(through:cut); try? await Task.sleep(nanoseconds:120_000_000)
            guard self.running else { self.finalizing = false; return }
            guard self.lastSpeech <= ended+0.1 else { self.finalizing = false; return }
            let text = self.transcript.text; self.transcript.commit(through:cut)
            self.speechLatched = false; self.speechStart = 0; self.finalizing = false
            if !text.isEmpty { self.caption.stringValue = "你："+text; self.submit(text,speechEnded:ended) }
        }
    }
    private func submit(_ text: String,speechEnded: Double) {
        if active != nil || audio.hasOutput { interrupt(reason:"new_turn") }
        let turn = Turn(generation:generation.advance(),speechEnded:speechEnded); turns[turn.submission] = turn; active = turn; playbackTurn = turn
        response.string = ""; status.stringValue = "正在思考 · 可以随时打断"
        Task { [weak self] in
            guard let self else { return }
            do {
                let ack = try await self.gateway.call("chat.send",["sessionKey":self.sessionKey,"agentId":"main","message":"（语音对话：请用简短自然的口语回复，代码和详细步骤放在屏幕上。）\n"+text,"thinking":"off","deliver":false,"queueMode":"interrupt","idempotencyKey":turn.submission,"timeoutMs":180000])
                turn.run = ack["runId"] as? String
                let buffered = self.earlyEvents; self.earlyEvents.removeAll()
                for event in buffered where event["runId"] as? String == turn.run { self.event("chat",event) }
                if turn.cancelled { await self.abort(turn) }
            } catch {
                if self.generation.accepts(turn.generation) { self.interrupt(reason:"send_unknown"); self.status.stringValue = "发送结果待确认，未自动重发。请在聊天记录中检查；重新开始前先确认旧任务状态。"; self.running = false; self.audio.stop(); self.recognition.stop(); self.timer?.invalidate() }
            }
        }
        if turns.count > 30 { turns = turns.filter { !$0.value.terminal || $0.value === active } }
    }
    private func event(_ name: String,_ payload: [String:Any]) {
        guard name == "chat", payload["sessionKey"] as? String == sessionKey, let run = payload["runId"] as? String else { return }
        guard let turn = turns.values.first(where:{ $0.run == run || $0.submission == run }) else {
            // Some admitted turns publish before their acknowledgment. Buffer
            // bounded text events, then bind only the acknowledged actual run.
            if turns.values.contains(where:{ $0.run == nil && !$0.terminal }), earlyEvents.count < 64 { earlyEvents.append(payload) }
            return
        }
        turn.run = run
        let state = payload["state"] as? String ?? ""
        if ["final","aborted","error"].contains(state) { turn.terminal = true }
        guard !turn.cancelled, generation.accepts(turn.generation), running else { return }
        let sequence = payload["seq"] as? Int ?? 0; guard sequence > turn.sequence else { return }; turn.sequence = sequence
        if state == "delta" {
            let delta = payload["deltaText"] as? String ?? ""
            if turn.firstToken == nil && !delta.isEmpty { turn.firstToken = ProcessInfo.processInfo.systemUptime }
            if payload["replace"] as? Bool == true {
                if delta.hasPrefix(turn.raw) { turn.chunker.append(String(delta.dropFirst(turn.raw.count))) }
                else { audio.interrupt(); turn.chunker = VoiceUtteranceBuffer(); turn.chunker.append(delta) }
                turn.raw = delta
            } else { turn.raw += delta; turn.chunker.append(delta) }
            response.string = turn.raw; response.scrollToEndOfDocument(nil)
            while let chunk = turn.chunker.take() { audio.speak(chunk) }
        } else if state == "final" {
            if turn.raw.isEmpty, let message = payload["message"] as? [String:Any], let content = message["content"] as? [[String:Any]] {
                turn.raw = content.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator:"\n"); turn.chunker.append(turn.raw); response.string = turn.raw
            }
            while let chunk = turn.chunker.take(force:true) { audio.speak(chunk) }
            active = nil
            if !outputPlaying { status.stringValue = "正在听 · 说完稍停就会发送" }
        } else if state == "aborted" || state == "error" {
            interrupt(reason:state); status.stringValue = state == "error" ? "这一轮未完成，请查看聊天中的错误或审批。麦克风仍开启。" : "已打断 · 正在听"
        }
    }
    private func interrupt(reason: String) {
        let began = ProcessInfo.processInfo.systemUptime, turn = active
        if let turn { turn.cancelled = true }
        playbackTurn?.cancelled = true
        _ = generation.advance(); audio.interrupt(); active = nil; playbackTurn = nil
        record(["kind":"local_interrupt","reason":reason,"milliseconds":(ProcessInfo.processInfo.systemUptime-began)*1000])
        if let turn { Task { [weak self] in await self?.abort(turn) } }
    }
    private func abort(_ turn: Turn) async {
        guard let run = turn.run, !turn.terminal else { return }
        let began = ProcessInfo.processInfo.systemUptime
        do {
            let result = try await gateway.call("chat.abort",["sessionKey":sessionKey,"agentId":"main","runId":run,"preserveSideRuns":true,"discardPendingInput":true])
            record(["kind":"abort_ack","milliseconds":(ProcessInfo.processInfo.systemUptime-began)*1000,"aborted":result["aborted"] ?? false])
        } catch { if !running { status.stringValue = "声音和麦克风已停止；旧任务取消结果待确认，请查看聊天记录。" } }
    }
    @objc private func interruptButton() { interrupt(reason:"button"); if running { status.stringValue = "已打断 · 正在听" } }
    func interruptOutput() { interruptButton() }
    @objc private func endButton() { stop() }
    @objc private func showRecords() { openChat(sessionID) }
    func stop() {
        running = false; startTask?.cancel(); startTask = nil; timer?.invalidate(); timer = nil
        interrupt(reason:"stop"); audio.stop(); recognition.stop(); startButton.isEnabled = true
        speechLatched = false; finalizing = false; status.stringValue = "语音已结束 · 麦克风已关闭"; onActivity?(false,false)
    }
    func shutdown() async { let turn = active; stop(); if let turn { await abort(turn) }; gateway.disconnect() }
    func windowWillClose(_ notification: Notification) { stop() }
    private func connectionLost() { stop(); status.stringValue = "本机连接中断，麦克风已关闭；旧请求状态待确认，不会自动重发。" }
    private func record(_ metric: [String:Any]) {
        metrics.append(metric); metrics = Array(metrics.suffix(60))
        let file = root.appendingPathComponent("data/mac/voice/metrics.json")
        if let data = try? JSONSerialization.data(withJSONObject:metrics,options:.prettyPrinted) { try? data.write(to:file,options:.atomic); try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path) }
    }
}
