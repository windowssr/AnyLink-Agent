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
    var currentSession: (() -> String?)?, openRecord: ((String,String) -> Void)?, openVoice: (() -> Void)?
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
    private var recordSession: String?, chatEvents = 0, proactiveReplies = 0
    private let started = Date().timeIntervalSince1970*1000
    private let defaults = UserDefaults.standard
    private var roam: Bool { defaults.object(forKey:"companion.roam") == nil || defaults.bool(forKey:"companion.roam") }
    private var proactive: Bool { defaults.object(forKey:"companion.proactive") == nil || defaults.bool(forKey:"companion.proactive") }
    private var readAloud: Bool { defaults.object(forKey:"companion.readAloud") == nil || defaults.bool(forKey:"companion.readAloud") }
    private var snoozed: Bool { Date().timeIntervalSince1970 < defaults.double(forKey:"companion.snoozeUntil") }
    var isVisible: Bool { panel.isVisible }
    init(root: URL,openChat: @escaping () -> Void) throws {
        self.root = root; self.openChat = openChat; conversation = CompanionConversation(root:root); speech = CompanionSpeech(root:root)
        view = CompanionView(root:root)
        panel = CompanionPanel(contentRect:NSRect(x:0,y:0,width:280,height:520),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        panel.title = "AnyLink 桌面伙伴"; panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false; panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.stationary,.ignoresCycle]
        panel.contentView = view; panel.isMovableByWindowBackground = false
        super.init()
        if defaults.string(forKey:"companion.requestState") != nil { recordSession = conversation.key.components(separatedBy:":").last }
        view.onOpenChat = { [weak self] in self?.showChat() }
        view.onTap = { [weak self] in self?.pet() }
        view.onMoved = { [weak self] in self?.walk = nil; self?.settle(save:true); self?.nextWalk = Date().addingTimeInterval(40) }
        view.onDragStart = { [weak self] in self?.walk = nil }
        view.onMenu = { [weak self] in self?.walk = nil; self?.touchedAt = Date(); self?.nextWalk = Date().addingTimeInterval(35); return self?.menu() ?? NSMenu() }
        view.onStopSpeech = { [weak self] in self?.stopSpeaking() }
        view.renderer.onChange = { [weak self] in self?.view.needsDisplay = true; self?.publishSnapshot() }
        speech.onSpeaking = { [weak self] speaking in
            guard let self else { return }; self.view.speaking = speaking || self.voiceSpeaking
            if speaking { self.walk = nil }; self.publishSnapshot()
        }
        speech.onFailure = { [weak self] in self?.view.showMessage("甜妹声音暂时没连上，文字回复还在聊天里。",seconds:12); self?.publishSnapshot() }
        conversation.onText = { [weak self] text in
            guard let self,!self.stopped,!self.sleeping else { return }
            self.recordSession = self.conversation.key.components(separatedBy:":").last
            self.proactiveReplies += 1
            self.present(text,emotion:Date()<self.expressionUntil ? self.view.emotion : .happy,gesture:Date()<self.expressionUntil ? "none" : "nod",speak:true)
        }
        conversation.onFailure = { [weak self] in self?.view.showMessage("这次招呼的结果未确认，我不会自动重发。",seconds:15); self?.publishSnapshot() }
        conversation.onBusy = { [weak self] busy in if busy { self?.walk = nil }; self?.publishSnapshot() }
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
        stopped = false; defaults.set(true,forKey:"companion.visible"); settle(save:false); panel.orderFrontRegardless(); view.renderer.start(); writeLease()
        if animation == nil { animation = Timer.scheduledTimer(withTimeInterval:1.0/24,repeats:true) { [weak self] _ in Task { @MainActor in self?.animate() } } }
        if poll == nil { poll = Timer.scheduledTimer(withTimeInterval:4,repeats:true) { [weak self] _ in Task { @MainActor in self?.refresh() } } }
        if journal == nil { journal = Timer.scheduledTimer(withTimeInterval:0.3,repeats:true) { [weak self] _ in Task { @MainActor in self?.readEvents() } } }
        refresh(); publishSnapshot()
    }
    func reveal() { show(); panel.makeKeyAndOrderFront(nil) }
    func hide() { defaults.set(false,forKey:"companion.visible"); stopPresentation() }
    private func stopPresentation() {
        stopped = true; walk = nil; panel.orderOut(nil); view.renderer.stop(); speech.stop(); conversation.stop(); writeLease()
        animation?.invalidate(); animation = nil; poll?.invalidate(); poll = nil; journal?.invalidate(); journal = nil
        refreshEpoch &+= 1; refreshTask?.cancel(); refreshTask = nil; client?.disconnect(); connected = false; inFlight = false
        clearEvents(); publishSnapshot()
    }
    func toggle() { if panel.isVisible { hide() } else { show() } }
    func stop() { stopPresentation() }
    private func suspend() { sleeping = true; walk = nil; speech.stop(); conversation.stop(); onSuspend?(); view.renderer.stop(); writeLease(); publishSnapshot() }
    private func resume() { sleeping = false; nextProactive = Date().addingTimeInterval(1200); nextWalk = Date().addingTimeInterval(30); if !stopped && panel.isVisible { view.renderer.start() }; writeLease(); publishSnapshot() }
    func setVoiceActivity(running: Bool,speaking: Bool) {
        voiceActive = running; voiceSpeaking = speaking
        if running { speech.stop(); walk = nil }
        view.speaking = speaking || speech.speaking; publishSnapshot()
    }
    func stopSpeaking() { speech.stop(); interruptVoice?(); view.speaking = voiceSpeaking; publishSnapshot() }
    private func animate() {
        guard !sleeping else { return }
        let now = Date(), previous = view.mood
        if now > temporaryUntil { view.mood = state == .idle && now.timeIntervalSince(touchedAt)>180 ? .sleepy : state }
        if now > emotionUntil { view.emotion = .neutral }
        if let current = walk {
            if view.dragging || (view.pointerInside && now>ignoreHoverUntil) || state != .idle || speech.speaking || voiceActive || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { walk = nil }
            else { panel.setFrameOrigin(current.position(at:ProcessInfo.processInfo.systemUptime)); if current.finished(at:ProcessInfo.processInfo.systemUptime) { walk = nil; publishSnapshot() } }
        }
        view.walking = walk != nil; view.walkDirection = walk?.direction ?? 1
        view.animate(time:ProcessInfo.processInfo.systemUptime)
        if now.timeIntervalSince(leaseAt)>10 { writeLease(); scheduleCompanionship(); publishSnapshot() }
        if roam && now > nextWalk && state == .idle && !conversation.pending && !voiceActive && !speech.speaking && !snoozed && now.timeIntervalSince(touchedAt)>12 && !away { startWalk(manual:false) }
        if previous != view.mood { publishSnapshot() }
    }
    private var away: Bool { CGEventSource.secondsSinceLastEventType(.combinedSessionState,eventType:.null)>300 }
    private func pet() {
        if speech.speaking { stopSpeaking(); return }
        touchedAt = Date(); nextWalk = Date().addingTimeInterval(40); temporaryUntil = Date().addingTimeInterval(3); view.mood = .happy
        defaults.set(0,forKey:"companion.unanswered"); nextProactive = Date().addingTimeInterval(Double.random(in:1200...2400))
        present("嘿，收到你的摸摸啦。要不要和我聊两句？",emotion:.happy,gesture:"wave",speak:true)
    }
    private func present(_ text: String,emotion: CompanionEmotion,gesture: String,speak: Bool) {
        view.showMessage(String(text.prefix(110)),seconds:25); view.emotion = emotion; emotionUntil = Date().addingTimeInterval(12)
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
            if currentSession?() == "__new__" { continue }
            seen.insert(name)
            let own = event.agentId == "companion" && event.sessionKey == conversation.key
            let voice = voiceActive && event.sessionKey.contains(":voice:")
            let selected = currentSession?().map { route in
                let target = CompanionPolicy.normalizedSession(route)
                return target == CompanionPolicy.normalizedSession(event.sessionId) || target == CompanionPolicy.normalizedSession(event.sessionKey.components(separatedBy:":").last ?? "")
            } ?? false
            guard own || voice || selected || (!event.runId.isEmpty && relevantRuns.contains(event.runId)) else { continue }
            if !event.runId.isEmpty { relevantRuns.insert(event.runId) }
            if own { recordSession = conversation.key.components(separatedBy:":").last }
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
                    present(event.text ?? "",emotion:event.emotion ?? .neutral,gesture:event.explicit_expression == true ? "none" : (event.gesture ?? "none"),speak:!voice)
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
        let allowed = CompanionPolicy.canInitiate(enabled:proactive,quiet:CompanionPolicy.quiet(hour:Calendar.current.component(.hour,from:now)),away:away,busy:state != .idle || conversation.pending,speaking:speech.speaking || voiceActive,paused:snoozed,lastAttempt:defaults.double(forKey:"companion.lastAttempt"),now:now.timeIntervalSince1970,daily:defaults.integer(forKey:"companion.daily"))
        if allowed { initiate(manual:false) }
    }
    private func initiate(manual: Bool) {
        guard !stopped,!sleeping,!voiceActive,!conversation.pending,state == .idle else { if manual { view.showMessage("等当前这件事忙完，我们再聊两句。",seconds:10) }; return }
        // Persist before submission; a lost result never retries on launch/wake.
        defaults.set(Date().timeIntervalSince1970,forKey:"companion.lastAttempt")
        nextProactive = Date().addingTimeInterval(Double.random(in:1200...2400)); walk = nil
        if manual { defaults.set(0,forKey:"companion.unanswered") }
        else { defaults.set(defaults.integer(forKey:"companion.daily")+1,forKey:"companion.daily"); defaults.set(defaults.integer(forKey:"companion.unanswered")+1,forKey:"companion.unanswered") }
        view.showMessage("让我想想，和你聊点什么…",seconds:15); conversation.initiate(manual:manual,recentContext:Date()<recentTopicUntil ? recentTopic : nil); publishSnapshot()
    }
    private func startWalk(manual: Bool) {
        nextWalk = Date().addingTimeInterval(Double.random(in:40...80))
        guard walk == nil,!view.dragging,!sleeping,!NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,!voiceActive,!speech.speaking,!conversation.pending,state == .idle else { return }
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
                if !self.activeKeys.isEmpty && next.activeKeys.isEmpty && self.observed { self.temporaryUntil = Date().addingTimeInterval(5); self.view.mood = .finished }
                self.activeKeys = next.activeKeys; self.state = next.mood; self.observed = true; self.publishSnapshot()
            } catch { guard self.refreshEpoch == epoch else { return }; self.connected = false; self.client?.disconnect(); self.state = .offline; self.publishSnapshot() }
        }
    }
    private func settle(save: Bool) {
        if let screen = CompanionGeometry.screen(for:panel.frame,among:NSScreen.screens.map(\.visibleFrame)) { panel.setFrame(CompanionGeometry.contain(panel.frame,in:screen),display:true) }
        if save { defaults.set(panel.frame.minX,forKey:"companion.x"); defaults.set(panel.frame.minY,forKey:"companion.y") }
        touchedAt = Date(); publishSnapshot()
    }
    private func setScale(_ scale: Double,save: Bool) {
        let value = [0.8,1,1.25].contains(scale) ? scale : 1
        let origin = panel.frame.origin; panel.setFrame(NSRect(x:origin.x,y:origin.y,width:280*value,height:520*value),display:true)
        if save { defaults.set(value,forKey:"companion.scale"); walk = nil; settle(save:true) }
    }
    private func menu() -> NSMenu {
        let menu = NSMenu()
        func item(_ title: String,_ action: Selector,_ tag: Int = 0,_ checked: Bool = false) -> NSMenuItem { let item = NSMenuItem(title:title,action:action,keyEquivalent:""); item.target = self; item.tag = tag; item.state = checked ? .on : .off; return item }
        menu.addItem(item("打开 AnyLink 聊天",#selector(open)))
        menu.addItem(item("现在聊两句",#selector(chatNow))); menu.addItem(item("语音聊天…",#selector(voiceMenu)))
        menu.addItem(item("停止说话",#selector(stopSpeechMenu))); menu.addItem(item("摸摸头",#selector(touch)))
        menu.addItem(item("走两步",#selector(walkNow))); menu.addItem(item("自由走动",#selector(toggleRoam),0,roam))
        menu.addItem(item("主动找我聊天",#selector(toggleProactive),0,proactive)); menu.addItem(item("语音播报 · "+speech.label,#selector(toggleReadAloud),0,readAloud))
        menu.addItem(item(snoozed ? "结束免打扰" : "安静陪伴一小时",#selector(snooze)))
        menu.addItem(.separator()); menu.addItem(item("抬手致意",#selector(gesture(_:)),1)); menu.addItem(item("竖起手指",#selector(gesture(_:)),2)); menu.addItem(item("点点头",#selector(gesture(_:)),3))
        let size = NSMenu(); for (title,tag) in [("小",80),("标准",100),("大",125)] { size.addItem(item(title,#selector(resize(_:)),tag,abs(panel.frame.width-280*Double(tag)/100)<1)) }
        let sizing = NSMenuItem(title:"形象大小",action:nil,keyEquivalent:""); sizing.submenu = size; menu.addItem(sizing)
        menu.addItem(item("移回屏幕右下角",#selector(resetPosition))); menu.addItem(item("重新加载形象",#selector(reloadAvatar))); menu.addItem(item("角色来源与使用须知",#selector(credits)))
        menu.addItem(.separator()); menu.addItem(item("隐藏桌面伙伴",#selector(hideMenu))); return menu
    }
    private func showChat() { if let id = recordSession { openRecord?("companion",id) } else { openChat() } }
    @objc private func open() { openChat() }
    @objc private func chatNow() { initiate(manual:true) }
    @objc private func voiceMenu() { openVoice?() }
    @objc private func stopSpeechMenu() { stopSpeaking() }
    @objc private func touch() { pet() }
    @objc private func walkNow() { startWalk(manual:true) }
    @objc private func toggleRoam() { defaults.set(!roam,forKey:"companion.roam"); walk = nil; nextWalk = Date().addingTimeInterval(8); publishSnapshot() }
    @objc private func toggleProactive() { defaults.set(!proactive,forKey:"companion.proactive"); publishSnapshot() }
    @objc private func toggleReadAloud() { defaults.set(!readAloud,forKey:"companion.readAloud"); if !readAloud { stopSpeaking() }; publishSnapshot() }
    @objc private func snooze() { defaults.set(snoozed ? 0 : Date().addingTimeInterval(3600).timeIntervalSince1970,forKey:"companion.snoozeUntil"); speech.stop(); walk = nil; publishSnapshot() }
    @objc private func gesture(_ sender: NSMenuItem) { view.renderer.action([1:"wave",2:"point",3:"nod"][sender.tag] ?? "nod") }
    @objc private func credits() { if let url = URL(string:"https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md") { NSWorkspace.shared.open(url) } }
    @objc private func reloadAvatar() { view.renderer.stop(); if panel.isVisible { view.renderer.start() } }
    @objc private func resize(_ sender: NSMenuItem) { setScale(Double(sender.tag)/100,save:true) }
    @objc private func hideMenu() { hide() }
    @objc private func resetPosition() { walk = nil; if let screen = NSScreen.main { panel.setFrameOrigin(NSPoint(x:screen.visibleFrame.maxX-panel.frame.width-22,y:screen.visibleFrame.minY+16)); settle(save:true) } }
    private func saveJSON(_ value: [String:Any],name: String) {
        let file = root.appendingPathComponent("data/mac/desktop").appendingPathComponent(name).standardizedFileURL
        do { try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]); try JSONSerialization.data(withJSONObject:value).write(to:file,options:.atomic); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path) } catch {}
    }
    private func publishSnapshot() {
        saveJSON(["visible":panel.isVisible,"mood":view.mood.rawValue,"emotion":view.emotion.rawValue,"agent_state":state.rawValue,"active_sessions":activeKeys.count,"renderer":view.renderer.status,"last_action":view.renderer.lastAction,"walking":walk != nil,"roaming_enabled":roam,"proactive_enabled":proactive,"read_aloud":readAloud,"speaking":speech.speaking || voiceSpeaking,"voice_active":voiceActive,"speech_utterances":speech.utterances,"voice_available":speech.profile != nil || speech.voice != nil,"voice_locale":"zh-CN","voice_profile":speech.profile ?? "system","voice_label":speech.label,"chat_events":chatEvents,"proactive_replies":proactiveReplies,"proactive_pending":conversation.pending,"snoozed":snoozed,"status_client_read_only":true,"read_only":false,"frame":["x":panel.frame.minX,"y":panel.frame.minY,"width":panel.frame.width,"height":panel.frame.height],"updated_at":Date().timeIntervalSince1970],name:"companion-state.json")
    }
}
