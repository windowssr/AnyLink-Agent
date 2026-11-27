import AppKit

@MainActor
final class MacControlCoordinator: NSObject {
    private let root: URL
    private let state: URL
    private var panel: NSPanel?
    private let information = NSTextField(wrappingLabelWithString: "正在检查本机控制组件…")
    private var busy = false
    private var refreshTimer: Timer?

    init(root: URL) {
        self.root = root
        self.state = root.appendingPathComponent("data/mac/control/control.json")
        super.init()
        if !FileManager.default.fileExists(atPath: state.path) { setEnabled(false) }
        if isEnabled { startHost() }
    }

    private var isEnabled: Bool {
        guard let data = try? Data(contentsOf: state), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return value["enabled"] as? Bool == true
    }

    private var helper: URL {
        let runtime = root.appendingPathComponent("data/mac/control/runtime.json")
        if let data = try? Data(contentsOf: runtime),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let appPath = value["app"] as? String,
           !appPath.isEmpty,
           FileManager.default.fileExists(atPath: appPath) {
            return URL(fileURLWithPath: appPath)
        }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Peekaboo.app")
    }

    private func setEnabled(_ enabled: Bool) {
        do {
            try FileManager.default.createDirectory(at: state.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "enabled": enabled], options: [.prettyPrinted])
            try data.write(to: state, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: state.path)
        } catch { information.stringValue = "无法保存电脑控制设置，请检查本机工程目录。" }
    }

    func showSettings() {
        if panel == nil {
            let view = NSStackView(); view.orientation = .vertical; view.alignment = .leading; view.spacing = 16
            view.edgeInsets = NSEdgeInsets(top: 26, left: 28, bottom: 26, right: 28)
            let title = NSTextField(labelWithString: "让 AnyLink 操作这台 Mac")
            title.font = .systemFont(ofSize: 21, weight: .semibold)
            let detail = NSTextField(wrappingLabelWithString: "电脑控制由官方签名的 Peekaboo 组件执行。所选窗口的截图与界面文字会经你的 ywc 代理交给 DeepSeek 理解。请在 macOS 隐私与安全性设置中，为 Peekaboo 开启“辅助功能”和“屏幕与系统音频录制”。")
            detail.preferredMaxLayoutWidth = 550
            detail.font = .systemFont(ofSize: 13); detail.textColor = .secondaryLabelColor
            information.font = .systemFont(ofSize: 13)
            information.setAccessibilityIdentifier("anylink.computer-status")
            let enable = NSButton(title: "启用电脑控制", target: self, action: #selector(enableControl)); enable.bezelStyle = .rounded
            let stop = NSButton(title: "停止电脑控制", target: self, action: #selector(stopControl)); stop.bezelStyle = .rounded
            let controls = NSStackView(views: [enable, stop]); controls.spacing = 12
            let accessibility = NSButton(title: "辅助功能设置", target: self, action: #selector(openAccessibility)); accessibility.bezelStyle = .rounded
            let screen = NSButton(title: "屏幕录制设置", target: self, action: #selector(openScreenRecording)); screen.bezelStyle = .rounded
            let permissions = NSStackView(views: [accessibility, screen]); permissions.spacing = 12
            let locate = NSButton(title: "在访达中定位授权应用", target: self, action: #selector(locateHost)); locate.bezelStyle = .rounded
            let refresh = NSButton(title: "刷新权限状态", target: self, action: #selector(refreshStatus)); refresh.bezelStyle = .rounded
            let note = NSTextField(wrappingLabelWithString: "开启后，聊天中的 Agent 可以观察所选软件并点击、输入和使用快捷键。停止控制会阻止后续操作；已经发出的单次操作可能正在收尾。关闭聊天窗口不会自动停止电脑控制。")
            note.font = .systemFont(ofSize: 12); note.textColor = .secondaryLabelColor
            for child in [title, detail, information, controls, permissions, locate, refresh, note] { view.addArrangedSubview(child) }
            let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 610, height: 440), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "AnyLink · 电脑控制"; window.isReleasedWhenClosed = false
            window.contentView = view; window.center(); panel = window
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                DispatchQueue.main.async { if self?.panel?.isVisible == true { self?.refreshStatus() } }
            }
        }
        panel?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        refreshStatus()
    }

    private func startHost() {
        guard FileManager.default.fileExists(atPath: helper.path) else {
            information.stringValue = "缺少 Peekaboo 控制组件，请重新安装当前版本的 AnyLink.app。"; return
        }
        // Prevent macOS App Nap from throttling Peekaboo below its 1.0s diagnostic handshake window.
        let defaults = Process()
        defaults.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
        defaults.arguments = ["write", "boo.peekaboo.mac", "NSAppSleepDisabled", "-bool", "YES"]
        try? defaults.run()
        defaults.waitUntilExit()
        let running = NSWorkspace.shared.runningApplications.contains {
            $0.bundleURL?.standardizedFileURL == helper.standardizedFileURL || $0.bundleIdentifier == "boo.peekaboo.mac"
        }
        guard !running else { return }
        let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = false; configuration.hides = true
        NSWorkspace.shared.openApplication(at: helper, configuration: configuration) { [weak self] _, error in
            DispatchQueue.main.async {
                if error != nil { self?.information.stringValue = "Peekaboo 尚未启动。请定位授权应用并手动打开，再检查权限。" }
                else { self?.refreshStatus() }
            }
        }
    }

    @objc private func enableControl() { setEnabled(true); startHost(); refreshStatus() }
    @objc func stopControl() { setEnabled(false); information.stringValue = "电脑控制已停止。Agent 后续的界面操作会被拒绝。" }
    @objc private func locateHost() { NSWorkspace.shared.activateFileViewerSelecting([helper]) }
    @objc private func openAccessibility() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!) }
    @objc private func openScreenRecording() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!) }

    @objc private func refreshStatus() {
        guard !busy else { return }; busy = true
        let root = self.root
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let process = Process()
            process.executableURL = root.appendingPathComponent("data/mac/runtime/node_modules/node/bin/node")
            process.arguments = [root.appendingPathComponent("examples/mac-openclaw/control/status.mjs").path]
            let output = Pipe(); process.standardOutput = output; process.standardError = FileHandle.nullDevice
            var summary = "无法检查控制组件，请检查本机安装。"
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
                if let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], let message = value["summary"] as? String { summary = message }
            } catch {}
            let message = summary
            DispatchQueue.main.async { self?.busy = false; self?.information.stringValue = message }
        }
    }
}
