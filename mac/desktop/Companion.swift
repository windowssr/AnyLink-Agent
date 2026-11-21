import AppKit

final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class CompanionCoordinator: NSObject {
    private let panel: NSPanel, view: CompanionView, root: URL
    private let openChat: () -> Void
    private var animation: Timer?, poll: Timer?, refreshTask: Task<Void,Never>?
    private var client: LocalGatewayClient?
    private var connected = false, inFlight = false, stopped = false
    private var state: CompanionMood = .offline, activeKeys = Set<String>()
    private var touchedAt = Date(), temporaryUntil = Date.distantPast
    private var observed = false, refreshEpoch: UInt64 = 0
    private let defaults = UserDefaults.standard
    var isVisible: Bool { panel.isVisible }
    init(root: URL,openChat: @escaping () -> Void) throws {
        self.root = root; self.openChat = openChat
        view = CompanionView(root:root)
        panel = CompanionPanel(contentRect:NSRect(x:0,y:0,width:280,height:480),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        panel.title = "AnyLink 桌面伙伴"; panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.stationary,.ignoresCycle]
        panel.contentView = view; panel.isMovableByWindowBackground = false
        super.init()
        view.onOpenChat = openChat
        view.onTap = { [weak self] in self?.pet() }
        view.onMoved = { [weak self] in self?.settle(save:true) }
        view.onMenu = { [weak self] in self?.menu() ?? NSMenu() }
        view.renderer.onChange = { [weak self] in self?.view.needsDisplay = true; self?.publishSnapshot() }
        setScale(defaults.double(forKey:"companion.scale"),save:false)
        if defaults.object(forKey:"companion.x") != nil {
            panel.setFrameOrigin(NSPoint(x:defaults.double(forKey:"companion.x"),y:defaults.double(forKey:"companion.y")))
        } else if let screen = NSScreen.main { panel.setFrameOrigin(NSPoint(x:screen.visibleFrame.maxX-panel.frame.width-22,y:screen.visibleFrame.minY+16)) }
        settle(save:false)
        NotificationCenter.default.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main) { [weak self] _ in Task { @MainActor in self?.settle(save:true) } }
        if defaults.object(forKey:"companion.visible") == nil || defaults.bool(forKey:"companion.visible") { show() }
    }
    func show() {
        stopped = false; defaults.set(true,forKey:"companion.visible"); settle(save:false); panel.orderFrontRegardless(); view.renderer.start()
        if animation == nil { animation = Timer.scheduledTimer(withTimeInterval:1.0/24,repeats:true) { [weak self] _ in Task { @MainActor in self?.animate() } } }
        if poll == nil { poll = Timer.scheduledTimer(withTimeInterval:4,repeats:true) { [weak self] _ in Task { @MainActor in self?.refresh() } } }
        refresh()
        publishSnapshot()
    }
    func reveal() { show(); panel.makeKeyAndOrderFront(nil) }
    func hide() {
        defaults.set(false,forKey:"companion.visible"); stopPresentation()
    }
    private func stopPresentation() {
        stopped = true; panel.orderOut(nil); view.renderer.stop()
        animation?.invalidate(); animation = nil; poll?.invalidate(); poll = nil
        refreshEpoch &+= 1; refreshTask?.cancel(); refreshTask = nil; client?.disconnect(); connected = false; inFlight = false
        publishSnapshot()
    }
    func toggle() { if panel.isVisible { hide() } else { show() } }
    func stop() { stopPresentation() }
    private func animate() {
        let previous = view.mood
        if Date() > temporaryUntil {
            let quiet = state == .idle && Date().timeIntervalSince(touchedAt) > 180
            view.mood = quiet ? .sleepy : state
        }
        view.animate(time:ProcessInfo.processInfo.systemUptime)
        if previous != view.mood { publishSnapshot() }
    }
    private func pet() { touchedAt = Date(); temporaryUntil = Date().addingTimeInterval(2.4); view.mood = .happy; view.renderer.action("wave"); publishSnapshot() }
    private func refresh() {
        guard !stopped,!inFlight,panel.isVisible else { return }; inFlight = true
        let epoch = refreshEpoch
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.refreshEpoch == epoch { self.inFlight = false } }
            do {
                if self.client == nil { self.client = try LocalGatewayClient(root:self.root) }
                guard let client = self.client else { return }
                if !self.connected {
                    try await client.connect(); try Task.checkCancellation()
                    guard self.refreshEpoch == epoch else { return }
                    self.connected = true
                    client.onDisconnect = { [weak self] in self?.connected = false; self?.state = .offline }
                }
                let result = try await client.call("sessions.list",["agentId":"main","includeGlobal":true,"includeUnknown":true,"activeOnly":true,"limit":100,"rowMode":"sidebar"])
                guard !self.stopped,self.refreshEpoch == epoch else { return }
                let next = CompanionSnapshot.decode(result)
                if !self.activeKeys.isEmpty && next.activeKeys.isEmpty && self.observed {
                    // Absence is an end-of-run signal, never a success claim.
                    self.temporaryUntil = Date().addingTimeInterval(5); self.view.mood = .finished
                }
                self.activeKeys = next.activeKeys; self.state = next.mood; self.observed = true
                self.publishSnapshot()
            } catch {
                guard self.refreshEpoch == epoch else { return }
                self.connected = false; self.client?.disconnect(); self.state = .offline
                self.publishSnapshot()
            }
        }
    }
    private func settle(save: Bool) {
        let screens = NSScreen.screens.map(\.visibleFrame)
        if let screen = CompanionGeometry.screen(for:panel.frame,among:screens) { panel.setFrame(CompanionGeometry.contain(panel.frame,in:screen),display:true) }
        if save { defaults.set(panel.frame.minX,forKey:"companion.x"); defaults.set(panel.frame.minY,forKey:"companion.y") }
        touchedAt = Date()
        publishSnapshot()
    }
    private func setScale(_ scale: Double,save: Bool) {
        let value = [0.8,1,1.25].contains(scale) ? scale : 1
        let origin = panel.frame.origin; panel.setFrame(NSRect(x:origin.x,y:origin.y,width:280*value,height:480*value),display:true)
        if save { defaults.set(value,forKey:"companion.scale"); settle(save:true) }
    }
    private func menu() -> NSMenu {
        let menu = NSMenu()
        func item(_ title: String,_ action: Selector,_ tag: Int = 0) -> NSMenuItem { let item = NSMenuItem(title:title,action:action,keyEquivalent:""); item.target = self; item.tag = tag; return item }
        menu.addItem(item("打开 AnyLink 聊天",#selector(open)))
        menu.addItem(item("摸摸头",#selector(touch)))
        menu.addItem(item("举手打招呼",#selector(gesture(_:)),1)); menu.addItem(item("竖起手指",#selector(gesture(_:)),2)); menu.addItem(item("点点头",#selector(gesture(_:)),3))
        let size = NSMenu(); for (title,tag) in [("小",80),("标准",100),("大",125)] { let option = item(title,#selector(resize(_:)),tag); option.state = abs(panel.frame.width-280*Double(tag)/100)<1 ? .on : .off; size.addItem(option) }
        let sizing = NSMenuItem(title:"形象大小",action:nil,keyEquivalent:""); sizing.submenu = size; menu.addItem(sizing)
        menu.addItem(item("移回屏幕右下角",#selector(resetPosition)))
        menu.addItem(item("重新加载形象",#selector(reloadAvatar)))
        menu.addItem(item("角色来源与使用须知",#selector(credits)))
        menu.addItem(.separator()); menu.addItem(item("隐藏桌面伙伴",#selector(hideMenu)))
        return menu
    }
    @objc private func open() { openChat() }
    @objc private func touch() { pet() }
    @objc private func gesture(_ sender: NSMenuItem) { view.renderer.action([1:"wave",2:"point",3:"nod"][sender.tag] ?? "nod") }
    @objc private func credits() { if let url = URL(string:"https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md") { NSWorkspace.shared.open(url) } }
    @objc private func reloadAvatar() { view.renderer.stop(); if panel.isVisible { view.renderer.start() } }
    @objc private func resize(_ sender: NSMenuItem) { setScale(Double(sender.tag)/100,save:true) }
    @objc private func hideMenu() { hide() }
    @objc private func resetPosition() { if let screen = NSScreen.main { panel.setFrameOrigin(NSPoint(x:screen.visibleFrame.maxX-panel.frame.width-22,y:screen.visibleFrame.minY+16)); settle(save:true) } }
    private func publishSnapshot() {
        // Diagnostics contain UI state and counts only, never conversation text,
        // task names, screenshots, mouse history, tokens or model responses.
        let folder = root.appendingPathComponent("data/mac/desktop",isDirectory:true), file = folder.appendingPathComponent("companion-state.json")
        let data: [String:Any] = ["visible":panel.isVisible,"mood":view.mood.rawValue,"agent_state":state.rawValue,"active_sessions":activeKeys.count,"renderer":view.renderer.status,"last_action":view.renderer.lastAction,"frame":["x":panel.frame.minX,"y":panel.frame.minY,"width":panel.frame.width,"height":panel.frame.height],"updated_at":Date().timeIntervalSince1970,"read_only":true]
        do { try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]); let encoded = try JSONSerialization.data(withJSONObject:data); try encoded.write(to:file,options:.atomic); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path) } catch {}
    }
}
