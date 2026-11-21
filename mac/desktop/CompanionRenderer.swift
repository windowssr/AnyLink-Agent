import AppKit
import WebKit

@MainActor
final class CompanionRenderer: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    var onChange: (() -> Void)?
    private(set) var ready = false, hit = false
    private(set) var status = "starting"
    private(set) var lastAction = "none"
    private let root: URL
    private var server: Process?, input: Pipe?, output: Pipe?, error: Pipe?
    private var allowedURL: URL?, epoch = 0, evaluating = false, receivedData = Data()
    init(root: URL) {
        self.root = root
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame:.zero,configuration:configuration)
        super.init()
        configuration.userContentController.add(self,name:"anylinkAvatar")
        webView.navigationDelegate = self
        webView.setValue(false,forKey:"drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.setAccessibilityElement(false)
    }
    func start() {
        guard server == nil else { return }
        epoch += 1; let generation = epoch
        ready = false; hit = false; receivedData = Data(); status = "loading"; onChange?()
        guard let resources = Bundle.main.resourceURL?.appendingPathComponent("CompanionRenderer") else { fail(); return }
        let model = root.appendingPathComponent("data/mac/companion/model"), runtime = root.appendingPathComponent("data/mac/companion/runtime")
        guard FileManager.default.fileExists(atPath:model.appendingPathComponent("entry.model3.json").path) else { status = "assets_missing"; onChange?(); return }
        let process = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = root.appendingPathComponent("data/mac/runtime/node_modules/node/bin/node")
        process.arguments = [resources.appendingPathComponent("asset-server.mjs").path,resources.path,model.path,runtime.path]
        process.environment = ["ANYLINK_AVATAR_ASSET_TOKEN":(UUID().uuidString+UUID().uuidString).replacingOccurrences(of:"-",with:"").lowercased()]
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        // The only stdout is a scoped static asset URL. It is never persisted.
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            Task { @MainActor [weak self] in
                guard let self,self.epoch == generation,!data.isEmpty else { return }
                self.receivedData.append(data)
                guard self.receivedData.contains(10) else { return }
                guard self.receivedData.count < 2048,let object = try? JSONSerialization.jsonObject(with:self.receivedData) as? [String:String], let value = object["url"], let url = URL(string:value), url.host == "127.0.0.1" else { self.fail(); return }
                self.receivedData = Data()
                self.allowedURL = url; self.webView.load(URLRequest(url:url))
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        process.terminationHandler = { [weak self] _ in Task { @MainActor in guard let self,self.epoch == generation else { return }; self.fail() } }
        server = process; input = stdin; output = stdout; error = stderr
        do { try process.run() } catch { fail() }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds:25_000_000_000)
            guard let self,self.epoch == generation,!self.ready else { return }; self.fail()
        }
    }
    func stop() {
        epoch += 1; ready = false; hit = false; evaluating = false; status = "stopped"
        output?.fileHandleForReading.readabilityHandler = nil; error?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close(); if server?.isRunning == true { server?.terminate() }
        server = nil; input = nil; output = nil; error = nil; allowedURL = nil
        webView.stopLoading(); webView.loadHTMLString("",baseURL:nil); onChange?()
    }
    private func fail() { ready = false; hit = false; status = "load_failed"; onChange?() }
    func update(mood: CompanionMood,x: Double,y: Double,reducedMotion: Bool,emotion: CompanionEmotion = .neutral,speaking: Bool = false,walking: Bool = false,direction: Double = 1,entrance: Double = 1,portal: Bool = false) {
        guard ready,!evaluating else { return }; evaluating = true
        let value: [String:Any] = ["mood":mood.rawValue,"x":x,"y":y,"reducedMotion":reducedMotion,"emotion":emotion.rawValue,"speaking":speaking,"walking":walking,"direction":direction,"entrance":entrance,"portal":portal]
        guard let data = try? JSONSerialization.data(withJSONObject:value), let json = String(data:data,encoding:.utf8) else { evaluating = false; return }
        webView.evaluateJavaScript("window.anylinkAvatar?.update(\(json))") { [weak self] _,_ in self?.evaluating = false }
    }
    func action(_ name: String) {
        guard ready,["wave","point","nod"].contains(name) else { return }
        webView.evaluateJavaScript("window.anylinkAvatar?.action('\(name)')",completionHandler:nil)
    }
    func userContentController(_ userContentController: WKUserContentController,didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,let url = message.frameInfo.request.url,allows(url),let value = message.body as? [String:Any] else { return }
        switch value["type"] as? String {
        case "ready": ready = true; status = "ready"; onChange?()
        case "hit": hit = value["value"] as? Bool == true
        case "action": if let name = value["name"] as? String,["wave","point","nod"].contains(name) { lastAction = name; onChange?() }
        case "error": fail()
        default: break
        }
    }
    private func allows(_ url: URL) -> Bool {
        guard let base = allowedURL else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == base.port && url.path == base.path
    }
    func webView(_ webView: WKWebView,decidePolicyFor action: WKNavigationAction,decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if server == nil && action.request.url?.absoluteString == "about:blank" { decisionHandler(.allow); return }
        decisionHandler(action.request.url.map(allows) == true ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
}
