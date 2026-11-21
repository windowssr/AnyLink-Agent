import AppKit
import WebKit

private let gateway = URL(string: "http://127.0.0.1:18791/openclaw/")!
private let health = URL(string: "http://127.0.0.1:18791/healthz")!

struct DesktopConfiguration: Decodable {
    let projectRoot: String
}

enum DesktopError: Error {
    case configuration, credentials
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private let status = NSTextField(labelWithString: "正在连接本机 Agent…")
    private let progress = NSProgressIndicator()
    private let message = NSTextField(wrappingLabelWithString: "正在连接 Mac 上的 OpenClaw。首次启动可能需要约一分钟。")
    private let heading = NSTextField(labelWithString: "连接你的 Mac 助理")
    private var placeholder: NSStackView!
    private var timer: Timer?
    private var healthInFlight = false
    private var serviceStarted = false
    private var pageLoaded = false
    private var wasHealthy = false
    private var startedAt = Date()
    private var root: URL?
    private var computer: MacControlCoordinator?
    private var serviceError: String?
    private var checkingInterface = false
    private var pendingInterfaceRoute: String?
    private var pendingInterfaceSince: Date?
    private var recoveredInterfaceRoutes = Set<String>()
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.connectionProxyDictionary = [:]
        return URLSession(configuration: configuration)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        do {
            guard let configURL = Bundle.main.url(forResource: "desktop", withExtension: "json") else { throw DesktopError.configuration }
            let config = try JSONDecoder().decode(DesktopConfiguration.self, from: Data(contentsOf: configURL))
            let candidate = URL(fileURLWithPath: config.projectRoot, isDirectory: true).standardizedFileURL
            guard FileManager.default.fileExists(atPath: candidate.appendingPathComponent("mac/start.mjs").path) else { throw DesktopError.configuration }
            root = candidate
            computer = MacControlCoordinator(root: candidate)
        } catch {
            serviceError = "找不到已配置的 AnyLink 工程。请在工程中重新运行 node mac/build-app.mjs 和 node mac/install-app.mjs。"
        }
        buildMenu()
        buildWindow()
        buildStatusItem()
        showWindow(nil)
        pollHealth()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            DispatchQueue.main.async { self?.pollHealth() }
        }
    }

    private func menuItem(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func buildMenu() {
        let main = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(menuItem("关于 AnyLink", #selector(about)))
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("显示 AnyLink", #selector(showWindow(_:)), "0"))
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("退出 AnyLink 窗口", #selector(quit), "q"))
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)
        let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
        }
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); editItem.submenu = edit; main.addItem(editItem)
        let view = NSMenu(title: "助理")
        view.addItem(menuItem("重新连接", #selector(reconnect), "r"))
        view.addItem(menuItem("电脑控制与权限…", #selector(openComputerControl)))
        view.addItem(menuItem("停止电脑控制", #selector(stopComputerControl)))
        view.addItem(menuItem("打开工作区", #selector(openWorkspace), "1"))
        view.addItem(menuItem("打开日志文件夹", #selector(openLogs)))
        view.addItem(menuItem("在浏览器打开", #selector(openBrowser)))
        let viewItem = NSMenuItem(title: "助理", action: nil, keyEquivalent: ""); viewItem.submenu = view; main.addItem(viewItem)
        let windows = NSMenu(title: "窗口")
        windows.addItem(NSMenuItem(title: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windows.addItem(NSMenuItem(title: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: ""); windowItem.submenu = windows; main.addItem(windowItem)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windows
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1260, height: 840), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "AnyLink · Mac 助理"
        window.minSize = NSSize(width: 850, height: 600)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("AnyLinkMainWindow")
        window.center()

        let content = NSView(); window.contentView = content
        let toolbar = NSStackView(); toolbar.orientation = .horizontal; toolbar.spacing = 12
        toolbar.edgeInsets = NSEdgeInsets(top: 10, left: 18, bottom: 10, right: 18)
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        progress.style = .spinning; progress.controlSize = .small; progress.isDisplayedWhenStopped = false
        progress.startAnimation(nil)
        status.font = .systemFont(ofSize: 12, weight: .medium)
        status.setAccessibilityIdentifier("anylink.connection")
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let workspace = NSButton(title: "工作区", target: self, action: #selector(openWorkspace)); workspace.bezelStyle = .rounded
        workspace.setAccessibilityLabel("打开工作区")
        let reload = NSButton(title: "重新连接", target: self, action: #selector(reconnect)); reload.bezelStyle = .rounded
        let control = NSButton(title: "电脑控制", target: self, action: #selector(openComputerControl)); control.bezelStyle = .rounded
        for view in [progress, status, spacer, control, workspace, reload] { toolbar.addArrangedSubview(view) }
        content.addSubview(toolbar)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        if #available(macOS 14.0, *) { config.preferences.inactiveSchedulingPolicy = .throttle }
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.allowsBackForwardNavigationGestures = false
        webView.setAccessibilityLabel("AnyLink 本机聊天")
        // Keep the WebKit view attached and visible while loading. Hiding it can
        // suspend module initialization before the navigation delegate finishes.
        content.addSubview(webView)

        heading.font = .systemFont(ofSize: 24, weight: .semibold)
        message.font = .systemFont(ofSize: 14); message.textColor = .secondaryLabelColor
        message.alignment = .center
        let symbol = NSImageView(image: NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: "本机助理") ?? NSImage())
        symbol.contentTintColor = .systemTeal
        symbol.translatesAutoresizingMaskIntoConstraints = false
        symbol.widthAnchor.constraint(equalToConstant: 64).isActive = true
        symbol.heightAnchor.constraint(equalToConstant: 64).isActive = true
        placeholder = NSStackView(views: [symbol, heading, message])
        placeholder.orientation = .vertical; placeholder.spacing = 20; placeholder.alignment = .centerX
        placeholder.wantsLayer = true
        placeholder.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        placeholder.layer?.cornerRadius = 16
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(placeholder)
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: content.safeAreaLayoutGuide.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: content.leadingAnchor), toolbar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: toolbar.bottomAnchor), webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor), webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            placeholder.centerXAnchor.constraint(equalTo: content.centerXAnchor), placeholder.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            placeholder.widthAnchor.constraint(lessThanOrEqualToConstant: 560)
        ])
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "link", accessibilityDescription: "AnyLink")
        statusItem.button?.toolTip = "AnyLink · 本机助理"
        let menu = NSMenu()
        menu.addItem(menuItem("显示 AnyLink", #selector(showWindow(_:))))
        menu.addItem(menuItem("打开工作区", #selector(openWorkspace)))
        menu.addItem(menuItem("重新连接", #selector(reconnect)))
        menu.addItem(menuItem("电脑控制与权限…", #selector(openComputerControl)))
        menu.addItem(menuItem("停止电脑控制", #selector(stopComputerControl)))
        menu.addItem(.separator())
        menu.addItem(menuItem("退出 AnyLink 窗口", #selector(quit)))
        statusItem.menu = menu
    }

    private func token() throws -> String {
        guard let root = root else { throw DesktopError.configuration }
        let file = root.appendingPathComponent("secrets/mac-gateway-token")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value
        guard permissions & 0o077 == 0, owner == getuid() else { throw DesktopError.credentials }
        let value = try String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil else { throw DesktopError.credentials }
        return value
    }

    private func authenticatedURL() throws -> URL {
        let remembered = UserDefaults.standard.string(forKey: "lastChatRoute").flatMap { URL(string: $0, relativeTo: gateway)?.absoluteURL }
        let current = webView?.url
        let route = [current, remembered].compactMap { $0 }.first(where: { isLocal($0) && !$0.path.contains("/__openclaw__/session-entry") }) ?? gateway
        var components = URLComponents(url: route, resolvingAgainstBaseURL: false)!
        components.queryItems = components.queryItems?.filter { $0.name == "agent" }
        // Chat document GETs otherwise render OpenClaw's public reader first.
        // Use its official protected handoff; the Gateway still checks access.
        if route.path.hasPrefix("/openclaw/chat/") {
            let returnPath = components.percentEncodedPath
            components.path = "/openclaw/__openclaw__/session-entry"
            components.queryItems = [URLQueryItem(name: "path", value: returnPath)]
        }
        components.fragment = "token=" + (try token())
        return components.url!
    }

    private func saveRoute() {
        guard let url = webView?.url, isLocal(url), !url.path.contains("/__openclaw__/session-entry"), var route = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        route.fragment = nil
        route.queryItems = route.queryItems?.filter { $0.name == "agent" }
        if let url = route.url { UserDefaults.standard.set(url.absoluteString, forKey: "lastChatRoute") }
    }

    private func pollHealth() {
        if let error = serviceError {
            status.stringValue = "需要检查本机配置"; showMessage("暂时无法连接", error); return
        }
        guard !healthInFlight else { return }
        healthInFlight = true
        var request = URLRequest(url: health)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        session.dataTask(with: request) { [weak self] data, response, error in
            let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let healthy = error == nil && (response as? HTTPURLResponse)?.statusCode == 200 && object?["ok"] as? Bool == true
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.healthInFlight = false
                self.handleHealth(healthy)
            }
        }.resume()
    }

    private func handleHealth(_ healthy: Bool) {
        if healthy {
            wasHealthy = true
            status.stringValue = "本机 Agent 已连接 · 云端模型与记忆"
            progress.stopAnimation(nil)
            if !pageLoaded { loadChat() }
            else { checkInterfaceConnection() }
        } else {
            progress.startAnimation(nil)
            status.stringValue = wasHealthy ? "正在重新连接本机 Agent…" : "正在启动本机 Agent…"
            if !pageLoaded {
                let slow = Date().timeIntervalSince(startedAt) > 90
                showMessage(slow ? "本机 Agent 尚未就绪" : "连接你的 Mac 助理", slow ? "启动时间较长。可以重新连接，或从“助理”菜单打开日志文件夹排查。" : "正在启动 Mac 上的 OpenClaw，首次启动可能需要约一分钟。")
            }
            if !serviceStarted { serviceStarted = true; startService() }
        }
    }

    private func checkInterfaceConnection() {
        guard !checkingInterface, let route = webView.url, isLocal(route), route.path.hasPrefix("/openclaw/chat/") else { return }
        checkingInterface = true
        // OpenClaw 2026.11.6 can leave a newly created pane waiting for its
        // connection after the backend accepted the turn. Observe only status
        // and whether a draft exists; never inspect or resubmit chat content.
        let probe = """
        (() => {
          const pending = !!document.querySelector('.chat-pane__connection-icon--busy');
          const draft = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
            .some(el => (el.value || el.textContent || '').trim().length > 0);
          return pending && !draft;
        })()
        """
        webView.evaluateJavaScript(probe) { [weak self] result, error in
            guard let self = self else { return }
            self.checkingInterface = false
            guard error == nil, self.webView.url?.path == route.path else { return }
            guard result as? Bool == true else {
                self.pendingInterfaceSince = nil; self.pendingInterfaceRoute = nil; return
            }
            if self.pendingInterfaceRoute != route.path {
                self.pendingInterfaceRoute = route.path; self.pendingInterfaceSince = Date(); return
            }
            guard let since = self.pendingInterfaceSince, Date().timeIntervalSince(since) >= 12 else { return }
            // Slug renames do not permit repeated recovery of the same session.
            let key = route.path.range(of: "[a-f0-9]{32}$", options: .regularExpression).map { String(route.path[$0]) } ?? route.path
            guard !self.recoveredInterfaceRoutes.contains(key) else { return }
            self.recoveredInterfaceRoutes.insert(key)
            self.saveRoute()
            self.status.stringValue = "正在恢复会话连接…"
            self.loadChat() // GET only. A task accepted by the Gateway keeps running.
        }
    }

    private func showMessage(_ title: String, _ detail: String) {
        heading.stringValue = title; message.stringValue = detail
        placeholder.isHidden = false
        if serviceError != nil { progress.stopAnimation(nil) }
    }

    private func loadChat() {
        do {
            let url = try authenticatedURL()
            pageLoaded = true
            var request = URLRequest(url: url)
            request.setValue("Bearer " + (try token()), forHTTPHeaderField: "Authorization")
            webView.load(request)
        } catch {
            serviceError = "无法读取本机凭据。请确认工程 secrets/mac-gateway-token 属于当前用户，权限为 600，并已完成 Mac 配对。"
            showMessage("需要配置本机连接", serviceError!)
            status.stringValue = "本机凭据不可用"
        }
    }

    private func startService() {
        // Use the existing per-user service. Never kill a running task or run another Gateway.
        let plist = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.anylink.openclaw.plist")
        guard FileManager.default.fileExists(atPath: plist.path) else {
            serviceError = "尚未安装本机后台服务。请先按照工程的 Mac 安装说明安装 com.anylink.openclaw LaunchAgent。"
            pollHealth(); return
        }
        let domain = "gui/\(getuid())"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            func run(_ args: [String]) -> Int32 {
                let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/launchctl"); process.arguments = args
                process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                do { try process.run(); process.waitUntilExit(); return process.terminationStatus } catch { return -1 }
            }
            let loaded = run(["print", domain + "/com.anylink.openclaw"]) == 0
            let result = loaded ? run(["kickstart", domain + "/com.anylink.openclaw"]) : run(["bootstrap", domain, plist.path])
            if result != 0 {
                DispatchQueue.main.async {
                    self?.serviceError = "无法启动当前用户的后台服务。请从“助理”菜单查看日志，检查 LaunchAgent 安装。"
                    self?.pollHealth()
                }
            }
        }
    }

    @objc private func showWindow(_ sender: Any?) {
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc private func reconnect() {
        saveRoute()
        serviceError = root == nil ? "找不到 AnyLink 工程，请重新构建并安装应用。" : nil
        serviceStarted = false; startedAt = Date(); pageLoaded = false
        webView.stopLoading()
        showMessage("重新连接", "正在连接本机 Agent；现有聊天任务会继续在后台运行。")
        pollHealth()
    }
    @objc private func openWorkspace() { if let root = root { NSWorkspace.shared.open(root.appendingPathComponent("data/mac/workspace")) } }
    @objc private func openComputerControl() { computer?.showSettings() }
    @objc private func stopComputerControl() { computer?.stopControl() }
    @objc private func openLogs() { if let root = root { NSWorkspace.shared.open(root.appendingPathComponent("data/mac/logs")) } }
    @objc private func openBrowser() {
        do {
            var url = URLComponents(url: gateway, resolvingAgainstBaseURL: false)!
            url.fragment = "token=" + (try token())
            NSWorkspace.shared.open(url.url!)
        }
        catch { showMessage("需要配置本机连接", "无法读取本机凭据，请检查安装。") }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func about() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let alert = NSAlert(); alert.messageText = "AnyLink \(version)"
        alert.informativeText = "你的 Mac 助理\n\n聊天与工具在本机 OpenClaw 运行，模型调用和统一记忆通过 ywc。\n\n关闭或退出此窗口后，已安装的本机 Agent 继续在后台运行。文件工具使用当前工作区，其他工具遵循本机审批。"
        alert.addButton(withTitle: "知道了"); alert.beginSheetModal(for: window)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { saveRoute() }
    func windowWillClose(_ notification: Notification) { saveRoute() }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == 18791 && url.user == nil && url.password == nil && (url.path == "/openclaw" || url.path.hasPrefix("/openclaw/"))
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isLocal(url) || url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated && url.scheme == "https" {
            var external = URLComponents(url: url, resolvingAgainstBaseURL: false); external?.fragment = nil
            if let externalURL = external?.url { NSWorkspace.shared.open(externalURL) }
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, isLocal(url) { webView.load(navigationAction.request) }
        else if let url = navigationAction.request.url, url.scheme == "https" {
            var external = URLComponents(url: url, resolvingAgainstBaseURL: false); external?.fragment = nil
            if let externalURL = external?.url { NSWorkspace.shared.open(externalURL) }
        }
        return nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        saveRoute()
        placeholder.isHidden = true; webView.isHidden = false
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        saveRoute(); pageLoaded = false
        showMessage("正在恢复聊天窗口", "界面进程已退出，正在重新连接；后台 Agent 任务不会重新提交。")
        pollHealth()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    private func navigationFailed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        pageLoaded = false
        showMessage("聊天界面暂未就绪", "正在重试连接。也可以点击“重新连接”或查看本机日志。")
        // Do not log localized network errors: they can contain the authenticated URL.
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard isLocal(frame.request.url ?? gateway) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
}

@main
struct AnyLinkDesktop {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
