import AppKit

final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class CompanionCoordinator: NSObject {
    private let panel: NSPanel, view: CompanionView, root: URL
    private let openChat: () -> Void
    private let speech: CompanionSpeech, conversation: CompanionConversation
    let interaction: CompanionInteraction
    private let surface = CompanionSurface()
    var openRecord: ((String,String) -> Void)?
    private var interactionPhase = CompanionInteractionPhase.resting
    private let control: CompanionControlServer
    var onNotice: ((String) -> Void)?
    private var entrancePending = true, entrance: CompanionEntrance?
    private var requestedWalkUntil = Date.distantPast, controlCommands = 0
    var currentSession: (() -> String?)?, openVoice: (() -> Void)?
    var interruptVoice: (() -> Void)?
    var onSuspend: (() -> Void)?
    private var animation: Timer?, poll: Timer?, journal: Timer?, refreshTask: Task<Void,Never>?
    private var client: LocalGatewayClient?
    private var connected = false, inFlight = false, stopped = false, sleeping = false, voiceActive = false, voiceSpeaking = false
    private var state: CompanionMood = .offline, activeKeys = Set<String>()
    private var touchedAt = Date(), temporaryUntil = Date.distantPast, emotionUntil = Date.distantPast
    private var observed = false, refreshEpoch: UInt64 = 0, walk: CompanionWalk?
    private var nextWalk = Date().addingTimeInterval(15), nextProactive = Date().addingTimeInterval(1200)
    private var ignoreHoverUntil = Date.distantPast
    private var expressionUntil = Date.distantPast
    private var recentTopic: String?, recentTopicUntil = Date.distantPast
    private var seen = Set<String>(), relevantRuns = Set<String>(), leaseAt = Date.distantPast
    private var chatEvents = 0, proactiveReplies = 0
    private let started = Date().timeIntervalSince1970*1000
    private let defaults = UserDefaults.standard
    private var roam: Bool { defaults.object(forKey:"companion.roam") == nil || defaults.bool(forKey:"companion.roam") }
    private var proactive: Bool { defaults.object(forKey:"companion.proactive") == nil || defaults.bool(forKey:"companion.proactive") }
    private var readAloud: Bool { defaults.object(forKey:"companion.readAloud") == nil || defaults.bool(forKey:"companion.readAloud") }
    private var snoozed: Bool { Date().timeIntervalSince1970 < defaults.double(forKey:"companion.snoozeUntil") }
    var isVisible: Bool { panel.isVisible }
    init(root: URL,openChat: @escaping () -> Void) throws {
        self.root = root; self.openChat = openChat; conversation = CompanionConversation(root:root); speech = CompanionSpeech(root:root); control = CompanionControlServer(root:root); interaction = CompanionInteraction(root:root)
        view = CompanionView(root:root)
        panel = CompanionPanel(contentRect:NSRect(x:0,y:0,width:280,height:440),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        panel.title = "AnyLink 桌面伙伴"; panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false; panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.stationary,.ignoresCycle]
        panel.contentView = view; panel.isMovableByWindowBackground = false
        super.init()
        view.onEngage = { [weak self] in self?.engage() }
        view.onMoved = { [weak self] in self?.walk = nil; self?.settle(save:true); self?.surface.position(beside:self?.panel.frame ?? .zero); self?.nextWalk = Date().addingTimeInterval(40) }
        view.onDragStart = { [weak self] in self?.walk = nil; self?.requestedWalkUntil = .distantPast }
        view.onStopSpeech = { [weak self] in self?.stopSpeaking() }
        view.renderer.onChange = { [weak self] in self?.rendererChanged() }
        surface.onSubmit = { [weak self] text in self?.interaction.submit(text) }
        surface.onCancel = { [weak self] in self?.interaction.cancel() }
        surface.onClose = { [weak self] in self?.dismissInteraction() }
        surface.onRecords = { [weak self] in guard let self else { return }; self.openRecord?(self.interaction.identifier,self.interaction.key) }
        interaction.onInterrupt = { [weak self] in self?.stopSpeaking(); self?.conversation.stop() }
        interaction.onChange = { [weak self] in self?.interactionChanged() }
        interaction.onReply = { [weak self] text in
            guard let self,!self.stopped,!self.sleeping else { return }
            self.recentTopic = CompanionPolicy.cleanSpeech(text,limit:300); self.recentTopicUntil = Date().addingTimeInterval(2700)
            self.present(text,emotion:self.interaction.toolFailed ? .apologetic : .happy,gesture:self.interaction.files.isEmpty ? "nod" : "point",speak:true)
        }
        speech.onSpeaking = { [weak self] speaking in
            guard let self else { return }; self.view.speaking = speaking || self.voiceSpeaking
            if speaking { self.walk = nil }; self.publishSnapshot()
        }
        speech.onFailure = { [weak self] in self?.onNotice?("甜妹声音暂时没连上，结果仍可在人物身边查看。"); self?.publishSnapshot() }
        conversation.onText = { [weak self] text in
            guard let self,!self.stopped,!self.sleeping else { return }
            self.proactiveReplies += 1
            self.present(text,emotion:Date()<self.expressionUntil ? self.view.emotion : .happy,gesture:Date()<self.expressionUntil ? "none" : "nod",speak:true)
        }
        conversation.onFailure = { [weak self] in self?.onNotice?("这次招呼的结果未确认，我不会自动重发。"); self?.publishSnapshot() }
        conversation.onBusy = { [weak self] busy in if busy { self?.walk = nil }; self?.publishSnapshot() }
        installConversationDefaults()
        control.onCommand = { [weak self] in self?.apply($0) ?? ["status":"desktop_unavailable","applied":false] }; control.start()
        setScale(defaults.double(forKey:"companion.scale"),save:false)
        if defaults.object(forKey:"companion.x") != nil {
            panel.setFrameOrigin(NSPoint(x:defaults.double(forKey:"companion.x"),y:defaults.double(forKey:"companion.y")))
        } else if let screen = NSScreen.main { panel.setFrameOrigin(NSPoint(x:screen.visibleFrame.maxX-panel.frame.width-22,y:screen.visibleFrame.minY+16)) }
        settle(save:false)
        NotificationCenter.default.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main) { [weak self] _ in Task { @MainActor in self?.walk = nil; self?.settle(save:false) } }
        for name in [NSWorkspace.willSleepNotification,NSWorkspace.screensDidSleepNotification,NSWorkspace.sessionDidResignActiveNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in Task { @MainActor in self?.suspend() } }
        }
        for name in [NSWorkspace.didWakeNotification,NSWorkspace.screensDidWakeNotification,NSWorkspace.sessionDidBecomeActiveNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in Task { @MainActor in self?.resume() } }
        }
        if defaults.object(forKey:"companion.visible") == nil || defaults.bool(forKey:"companion.visible") { show() }
    }
    func show() {
        stopped = false; defaults.set(true,forKey:"companion.visible"); settle(save:false); if entrancePending { panel.alphaValue = 0 }; panel.orderFrontRegardless(); view.renderer.start(); writeLease()
        if animation == nil { animation = Timer.scheduledTimer(withTimeInterval:1.0/24,repeats:true) { [weak self] _ in Task { @MainActor in self?.animate() } } }
        if poll == nil { poll = Timer.scheduledTimer(withTimeInterval:4,repeats:true) { [weak self] _ in Task { @MainActor in self?.refresh() } } }
        if journal == nil { journal = Timer.scheduledTimer(withTimeInterval:0.3,repeats:true) { [weak self] _ in Task { @MainActor in self?.readEvents() } } }
        refresh(); publishSnapshot()
    }
    func reveal() { show(); panel.makeKeyAndOrderFront(nil) }
    func engage() {
        guard !sleeping else { return }
        if !panel.isVisible { show() }; finishEntrance(); stopSpeaking(); conversation.stop()
        walk = nil; requestedWalkUntil = .distantPast; touchedAt = Date(); nextWalk = Date().addingTimeInterval(40)
        nextProactive = Date().addingTimeInterval(1800); defaults.set(0,forKey:"companion.unanswered")
        view.renderer.action("attend"); interaction.engage(); surface.show(beside:panel.frame); interactionChanged()
    }
    private func dismissInteraction() {
        surface.hide(); stopSpeaking()
        if !interaction.pending { interaction.rest(); view.renderer.action("resume") }
        touchedAt = Date(); nextWalk = Date().addingTimeInterval(25); nextProactive = Date().addingTimeInterval(1800); publishSnapshot()
    }
    private func interactionChanged() {
        let phase = interaction.phase
        if interactionPhase != phase {
            if phase == .thinking { view.renderer.action("nod") }
            interactionPhase = phase; touchedAt = Date()
        }
        if interaction.pending || surface.isVisible { walk = nil; requestedWalkUntil = .distantPast }
        surface.update(interaction,beside:panel.frame)
        view.activity = surface.isVisible || interaction.pending ? phase.rawValue : "resting"
        view.lookDirection = surface.frame.midX<panel.frame.midX ? -1 : 1
        publishSnapshot()
    }
    func hide() { defaults.set(false,forKey:"companion.visible"); stopPresentation() }
    private func stopPresentation() {
        stopped = true; surface.hide(); walk = nil; requestedWalkUntil = .distantPast; finishEntrance(); panel.orderOut(nil); view.renderer.stop(); speech.stop(); conversation.stop(); writeLease()
        animation?.invalidate(); animation = nil; poll?.invalidate(); poll = nil; journal?.invalidate(); journal = nil
        refreshEpoch &+= 1; refreshTask?.cancel(); refreshTask = nil; client?.disconnect(); connected = false; inFlight = false
        clearEvents(); publishSnapshot()
    }
    func toggle() { if panel.isVisible { hide() } else { show() } }
    func stop() { interaction.disconnect(); control.stop(); stopPresentation() }
    private func suspend() { sleeping = true; surface.hide(); interaction.disconnect(); finishEntrance(); control.pause(true); requestedWalkUntil = .distantPast; walk = nil; speech.stop(); conversation.stop(); onSuspend?(); view.renderer.stop(); writeLease(); publishSnapshot() }
    private func resume() { sleeping = false; control.pause(false); nextProactive = Date().addingTimeInterval(1200); nextWalk = Date().addingTimeInterval(30); if !stopped && panel.isVisible { view.renderer.start() }; writeLease(); publishSnapshot() }
    func setVoiceActivity(running: Bool,speaking: Bool) {
        voiceActive = running; voiceSpeaking = speaking
        if running { speech.stop(); walk = nil }
        view.speaking = speaking || speech.speaking; publishSnapshot()
    }
    func stopSpeaking() { speech.stop(); interruptVoice?(); view.speaking = voiceSpeaking; publishSnapshot() }
    private func animate() {
        guard !sleeping else { return }
        let now = Date(), previous = view.mood
        if entrancePending || entrance != nil { animateEntrance(); return }
        if now > temporaryUntil { view.mood = state == .idle && now.timeIntervalSince(touchedAt)>180 ? .sleepy : state }
        if interaction.pending { view.mood = interaction.phase == .attention || interaction.phase == .cancelling ? .attention : (interaction.phase == .executing ? .working : .thinking) }
        else if surface.isVisible {
            view.mood = interaction.phase == .attending ? .happy : ([.attention,.unknown].contains(interaction.phase) ? .attention : .finished)
        }
        if now > emotionUntil { view.emotion = .neutral }
        if let current = walk {
            if view.dragging || (view.pointerInside && now>ignoreHoverUntil) || state != .idle || speech.hasOutput || voiceActive || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { walk = nil }
            else { panel.setFrameOrigin(current.position(at:ProcessInfo.processInfo.systemUptime)); if current.finished(at:ProcessInfo.processInfo.systemUptime) { walk = nil; publishSnapshot() } }
        }
        view.walking = walk != nil; view.walkDirection = walk?.direction ?? 1
        view.animate(time:ProcessInfo.processInfo.systemUptime)
        if now.timeIntervalSince(leaseAt)>10 { writeLease(); scheduleCompanionship(); publishSnapshot() }
        if now<requestedWalkUntil && state == .idle && !speech.hasOutput && !voiceActive && !conversation.pending && !interaction.pending && !surface.isVisible { startWalk(manual:true); if walk != nil { requestedWalkUntil = .distantPast } }
        if roam && now > nextWalk && state == .idle && !conversation.pending && !interaction.pending && !surface.isVisible && !voiceActive && !speech.hasOutput && !snoozed && now.timeIntervalSince(touchedAt)>12 && !away { startWalk(manual:false) }
        if previous != view.mood { publishSnapshot() }
    }
    private var away: Bool { CGEventSource.secondsSinceLastEventType(.combinedSessionState,eventType:.null)>300 }
    private func pet() {
        touchedAt = Date(); nextWalk = Date().addingTimeInterval(40); temporaryUntil = Date().addingTimeInterval(3); view.mood = .happy
        defaults.set(0,forKey:"companion.unanswered"); nextProactive = Date().addingTimeInterval(Double.random(in:1200...2400))
        view.emotion = .happy; emotionUntil = Date().addingTimeInterval(12); view.renderer.action("wave")
    }
    private func present(_ text: String,emotion: CompanionEmotion,gesture: String,speak: Bool) {
        view.emotion = emotion; emotionUntil = Date().addingTimeInterval(12)
        if gesture != "none" { view.renderer.action(gesture) }
        if speak && readAloud && !voiceActive && !snoozed { speech.speak(text) }
        publishSnapshot()
    }
    private func readEvents() {
        guard !stopped,!sleeping else { return }
        let folder = root.appendingPathComponent("data/mac/companion/events"),now = Date().timeIntervalSince1970*1000
        let files = (try? FileManager.default.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil)) ?? []
        for file in files.sorted(by:{$0.lastPathComponent<$1.lastPathComponent}) where file.pathExtension == "json" {
            let name = file.lastPathComponent
            guard let timestamp = Double(name.split(separator:"-").first ?? "") else { continue }
            if timestamp<now-120000 { try? FileManager.default.removeItem(at:file); continue }
            guard !seen.contains(name) else { continue }
            guard let data = try? Data(contentsOf:file),data.count<=20000,let event = try? JSONDecoder().decode(CompanionProjection.self,from:data),event.valid(now:now,started:started) else { continue }
            // A newly submitted UI turn can emit before its stable route arrives.
            // Retain only this brief admission window; never replay old history.
            if currentSession?() == "__new__" && event.sessionKey != interaction.key { continue }
            seen.insert(name)
            let own = event.agentId == "companion" && event.sessionKey == conversation.key
            let native = event.agentId == "main" && event.sessionKey == interaction.key
            let voice = voiceActive && event.sessionKey.contains(":voice:")
            let selected = currentSession?().map { route in
                let target = CompanionPolicy.normalizedSession(route)
                return target == CompanionPolicy.normalizedSession(event.sessionId) || target == CompanionPolicy.normalizedSession(event.sessionKey.components(separatedBy:":").last ?? "")
            } ?? false
            guard own || native || voice || selected || (!event.runId.isEmpty && relevantRuns.contains(event.runId)) else { continue }
            if native { interaction.receive(event); continue }
            if !event.runId.isEmpty { relevantRuns.insert(event.runId) }
            chatEvents += 1
            switch event.type {
            case "user":
                if !own { touchedAt = Date(); speech.stop(); walk = nil; defaults.set(0,forKey:"companion.unanswered"); nextProactive = Date().addingTimeInterval(Double.random(in:1200...2400)) }
                view.emotion = event.emotion ?? .neutral; emotionUntil = Date().addingTimeInterval(8)
            case "expression":
                view.emotion = event.emotion ?? .neutral; emotionUntil = Date().addingTimeInterval(12); expressionUntil = emotionUntil
                if let gesture = event.gesture { view.renderer.action(gesture) }
            case "reply":
                if !own {
                    recentTopic = CompanionPolicy.cleanSpeech(event.text ?? "",limit:300); recentTopicUntil = Date().addingTimeInterval(2700)
                    present(event.text ?? "",emotion:event.emotion ?? .neutral,gesture:event.explicit_expression == true ? "none" : (event.gesture ?? "none"),speak:!voice && !interaction.pending && !surface.isVisible)
                }
            case "error": if !own { present("这一轮没有完成，点我查看聊天里的具体情况。",emotion:.apologetic,gesture:"nod",speak:false) }
            default: break
            }
        }
        if seen.count>256 { seen = Set(files.map(\.lastPathComponent)) }; if relevantRuns.count>128 { relevantRuns.removeAll() }
    }
    private func clearEvents() {
        let folder = root.appendingPathComponent("data/mac/companion/events")
        for file in (try? FileManager.default.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil)) ?? [] where file.pathExtension == "json" { try? FileManager.default.removeItem(at:file) }
    }
    private func writeLease() {
        leaseAt = Date()
        saveJSON(["enabled":!stopped && !sleeping && panel.isVisible,"expires_at":Date().timeIntervalSince1970*1000+45000],name:"../companion/presence.json")
    }
    private func scheduleCompanionship() {
        let now = Date(),day = String(Calendar.current.startOfDay(for:Date()).timeIntervalSince1970)
        if defaults.string(forKey:"companion.day") != day { defaults.set(day,forKey:"companion.day"); defaults.set(0,forKey:"companion.daily") }
        guard now > nextProactive,defaults.integer(forKey:"companion.unanswered")<2 else { return }
        let allowed = CompanionPolicy.canInitiate(enabled:proactive,quiet:CompanionPolicy.quiet(hour:Calendar.current.component(.hour,from:now)),away:away,busy:state != .idle || conversation.pending || interaction.pending || surface.isVisible,speaking:speech.hasOutput || voiceActive,paused:snoozed,lastAttempt:defaults.double(forKey:"companion.lastAttempt"),now:now.timeIntervalSince1970,daily:defaults.integer(forKey:"companion.daily"))
        if allowed { initiate(manual:false) }
    }
    private func initiate(manual: Bool) {
        guard !stopped,!sleeping,!voiceActive,!conversation.pending,!interaction.pending,!surface.isVisible,state == .idle else { if manual { onNotice?("等当前这件事忙完，我们再聊两句。") }; return }
        // Persist before submission; a lost result never retries on launch/wake.
        defaults.set(Date().timeIntervalSince1970,forKey:"companion.lastAttempt")
        nextProactive = Date().addingTimeInterval(Double.random(in:1200...2400)); walk = nil
        if manual { defaults.set(0,forKey:"companion.unanswered") }
        else { defaults.set(defaults.integer(forKey:"companion.daily")+1,forKey:"companion.daily"); defaults.set(defaults.integer(forKey:"companion.unanswered")+1,forKey:"companion.unanswered") }
        conversation.initiate(manual:manual,recentContext:Date()<recentTopicUntil ? recentTopic : nil); publishSnapshot()
    }
    private func startWalk(manual: Bool) {
        nextWalk = Date().addingTimeInterval(Double.random(in:40...80))
        guard walk == nil,!view.dragging,!sleeping,!NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,!voiceActive,!speech.hasOutput,!conversation.pending,!interaction.pending,!surface.isVisible,state == .idle else { return }
        if !manual && view.pointerInside { return }
        guard let screen = CompanionGeometry.screen(for:panel.frame,among:NSScreen.screens.map(\.visibleFrame)) else { return }
        let start = panel.frame.origin,roomLeft = start.x-screen.minX,roomRight = screen.maxX-panel.frame.maxX
        let direction: CGFloat = roomRight<90 ? -1 : (roomLeft<90 ? 1 : (Bool.random() ? 1 : -1))
        let destination = CompanionGeometry.contain(NSRect(x:start.x+direction*CGFloat.random(in:100...200),y:start.y,width:panel.frame.width,height:panel.frame.height),in:screen).origin
        guard abs(destination.x-start.x)>10 else { return }
        ignoreHoverUntil = Date().addingTimeInterval(manual ? 15 : 0.5)
        walk = CompanionWalk(from:start,to:destination,started:ProcessInfo.processInfo.systemUptime,duration:max(3,Double(abs(destination.x-start.x))/28)); publishSnapshot()
    }
    private func refresh() {
        guard !stopped,!sleeping,!inFlight,panel.isVisible else { return }; inFlight = true
        let epoch = refreshEpoch
        refreshTask = Task { [weak self] in
            guard let self else { return }; defer { if self.refreshEpoch == epoch { self.inFlight = false } }
            do {
                if self.client == nil { self.client = try LocalGatewayClient(root:self.root) }
                guard let client = self.client else { return }
                if !self.connected {
                    try await client.connect(); try Task.checkCancellation(); guard self.refreshEpoch == epoch else { return }; self.connected = true
                    client.onDisconnect = { [weak self] in self?.connected = false; self?.state = .offline }
                }
                let result = try await client.call("sessions.list",["agentId":"main","includeGlobal":true,"includeUnknown":true,"activeOnly":true,"limit":100,"rowMode":"sidebar"])
                guard !self.stopped,self.refreshEpoch == epoch else { return }
                let next = CompanionSnapshot.decode(result)
                if next.mood == .attention && next.activeKeys == Set([self.interaction.key]) { self.interaction.waitingForAttention() }
                if !self.activeKeys.isEmpty && next.activeKeys.isEmpty && self.observed { self.temporaryUntil = Date().addingTimeInterval(5); self.view.mood = .finished }
                self.activeKeys = next.activeKeys; self.state = next.mood; self.observed = true; self.publishSnapshot()
            } catch { guard self.refreshEpoch == epoch else { return }; self.connected = false; self.client?.disconnect(); self.state = .offline; self.publishSnapshot() }
        }
    }
    private func settle(save: Bool) {
        if let screen = CompanionGeometry.screen(for:panel.frame,among:NSScreen.screens.map(\.visibleFrame)) { panel.setFrame(CompanionGeometry.contain(panel.frame,in:screen),display:true) }
        if save { defaults.set(panel.frame.minX,forKey:"companion.x"); defaults.set(panel.frame.minY,forKey:"companion.y") }
        touchedAt = Date(); publishSnapshot()
        surface.position(beside:panel.frame)
    }
    private func setScale(_ scale: Double,save: Bool) {
        let value = [0.8,1,1.25].contains(scale) ? scale : 1
        let origin = panel.frame.origin; panel.setFrame(NSRect(x:origin.x,y:origin.y,width:280*value,height:440*value),display:true)
        if save { defaults.set(value,forKey:"companion.scale"); walk = nil; settle(save:true) }
    }
    private func installConversationDefaults() {
        guard !defaults.bool(forKey:"companion.conversationDefaults.v0.6") else { return }
        for key in ["roam","proactive","readAloud","visible"] { defaults.set(true,forKey:"companion."+key) }
        defaults.set(0,forKey:"companion.snoozeUntil"); defaults.set(true,forKey:"companion.conversationDefaults.v0.6")
    }
    private func rendererChanged() {
        if entrancePending && view.renderer.ready { beginEntrance() }
        if entrancePending && ["load_failed","assets_missing"].contains(view.renderer.status) { finishEntrance(); onNotice?("形象加载失败，请检查本机素材。"); openChat() }
        publishSnapshot()
    }
    private func beginEntrance() {
        guard entrancePending,let screen = CompanionGeometry.screen(for:panel.frame,among:NSScreen.screens.map(\.visibleFrame)) else { finishEntrance(); return }
        let target = panel.frame,reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let height = min(600,screen.height-36),width = min(420,screen.width-36)
        let origin = NSRect(x:screen.midX-width/2,y:screen.midY-height/2,width:width,height:height)
        entrance = CompanionEntrance(from:reduced ? target : origin,to:target,started:ProcessInfo.processInfo.systemUptime,reducedMotion:reduced)
        entrancePending = false; view.interactionBlocked = true; view.entrance = 0; view.portal = !reduced
        panel.setFrame(reduced ? target : origin,display:true); panel.alphaValue = 1; animateEntrance()
    }
    private func animateEntrance() {
        guard let entrance else { return }
        let time = ProcessInfo.processInfo.systemUptime
        view.entrance = entrance.appearance(at:time); view.portal = entrance.portal(at:time)
        panel.setFrame(entrance.frame(at:time),display:true); view.animate(time:time); publishSnapshot()
        if entrance.finished(at:time) { finishEntrance(); view.renderer.action("wave") }
    }
    private func finishEntrance() {
        if let entrance { panel.setFrame(entrance.to,display:true) }
        entrance = nil; entrancePending = false; view.entrance = 1; view.portal = false; view.interactionBlocked = false; panel.alphaValue = 1
        nextWalk = Date().addingTimeInterval(20); publishSnapshot()
    }
    private func settings() -> [String:Any] {
        ["visible":panel.isVisible,"roaming":roam,"proactive":proactive,"read_aloud":readAloud,"quiet_until":defaults.double(forKey:"companion.snoozeUntil"),"scale":[0.8,1,1.25].contains(defaults.double(forKey:"companion.scale")) ? defaults.double(forKey:"companion.scale") : 1,"renderer":view.renderer.status,"voice":speech.label,"reduced_motion":NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,"walking":walk != nil,"walk_queued":Date()<requestedWalkUntil]
    }
    private func apply(_ command: CompanionCommand) -> [String:Any] {
        guard command.valid else { return ["status":"invalid","applied":false] }
        controlCommands += 1
        if command.action == "status" { return ["status":"ok","applied":true,"state":settings()] }
        finishEntrance()
        var status = "applied",applied = true
        switch command.action {
        case "configure":
            if let value = command.roaming { defaults.set(value,forKey:"companion.roam"); if !value { walk = nil } }
            if let value = command.proactive { defaults.set(value,forKey:"companion.proactive"); nextProactive = Date().addingTimeInterval(1200) }
            if let value = command.read_aloud { defaults.set(value,forKey:"companion.readAloud"); if !value { stopSpeaking() } }
        case "quiet":
            defaults.set(command.minutes == 0 ? 0 : Date().addingTimeInterval(Double(command.minutes!)*60).timeIntervalSince1970,forKey:"companion.snoozeUntil")
            stopSpeaking(); walk = nil; requestedWalkUntil = .distantPast; nextProactive = Date().addingTimeInterval(1200)
        case "walk":
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || sleeping || !panel.isVisible { status = "unavailable"; applied = false }
            else { requestedWalkUntil = Date().addingTimeInterval(90); status = "queued" }
        case "pet": pet()
        case "resize": setScale(command.scale!,save:true)
        case "reset_position": resetPosition()
        case "reload": view.renderer.stop(); if panel.isVisible { view.renderer.start() }
        case "show": show()
        case "hide": hide()
        case "open_chat": engage()
        case "open_voice": openVoice?()
        case "stop_speaking": stopSpeaking()
        case "chat_now": initiate(manual:true); applied = conversation.pending; status = applied ? "queued" : "busy"
        case "credits": if let url = URL(string:"https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md") { NSWorkspace.shared.open(url) }
        default: status = "invalid"; applied = false
        }
        publishSnapshot(); return ["status":status,"applied":applied,"state":settings()]
    }
    private func resetPosition() { walk = nil; if let screen = NSScreen.main { panel.setFrameOrigin(NSPoint(x:screen.visibleFrame.maxX-panel.frame.width-22,y:screen.visibleFrame.minY+16)); settle(save:true) } }
    private func saveJSON(_ value: [String:Any],name: String) {
        let file = root.appendingPathComponent("data/mac/desktop").appendingPathComponent(name).standardizedFileURL
        do { try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]); try JSONSerialization.data(withJSONObject:value).write(to:file,options:.atomic); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path) } catch {}
    }
    private func publishSnapshot() {
        saveJSON(["interaction_phase":interaction.phase.rawValue,"interaction_pending":interaction.pending,"interaction_surface_visible":surface.isVisible,"interaction_files":interaction.files.count,"interaction_search_returned":interaction.searchReturned,"interaction_partial":interaction.partial,"interaction_session":interaction.key,"bubble_visible":false,"context_menu":false,"control_commands":controlCommands,"entrance_phase":entrancePending ? "loading" : (entrance?.phase(at:ProcessInfo.processInfo.systemUptime) ?? "finished"),"visible":panel.isVisible,"mood":view.mood.rawValue,"emotion":view.emotion.rawValue,"agent_state":state.rawValue,"active_sessions":activeKeys.count,"renderer":view.renderer.status,"last_action":view.renderer.lastAction,"walking":walk != nil,"roaming_enabled":roam,"proactive_enabled":proactive,"read_aloud":readAloud,"speaking":speech.speaking || voiceSpeaking,"voice_active":voiceActive,"speech_utterances":speech.utterances,"voice_available":speech.profile != nil || speech.voice != nil,"voice_locale":"zh-CN","voice_profile":speech.profile ?? "system","voice_label":speech.label,"chat_events":chatEvents,"proactive_replies":proactiveReplies,"proactive_pending":conversation.pending,"snoozed":snoozed,"status_client_read_only":true,"read_only":false,"frame":["x":panel.frame.minX,"y":panel.frame.minY,"width":panel.frame.width,"height":panel.frame.height],"updated_at":Date().timeIntervalSince1970],name:"companion-state.json")
    }
}
