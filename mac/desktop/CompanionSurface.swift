import AppKit

private final class CompanionInput: NSTextField {
    var onEscape: (() -> Void)?
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

@MainActor
final class CompanionSurface: NSObject, NSTextFieldDelegate {
    private let panel: CompanionPanel
    private let header = NSTextField(labelWithString:"大肥鱼")
    private let status = NSTextField(labelWithString:"")
    private let input = CompanionInput()
    private let send = NSButton(title:"交给我",target:nil,action:nil)
    private let stop = NSButton(title:"停止这轮",target:nil,action:nil)
    private let records = NSButton(title:"完整记录 ↗",target:nil,action:nil)
    private let close = NSButton(title:"",target:nil,action:nil)
    private let progress = NSProgressIndicator()
    private let scroll = NSScrollView(), content = NSStackView()
    private var resultSignature = "", focusWasRequested = false
    var onSubmit: ((String) -> Void)?, onCancel: (() -> Void)?, onClose: (() -> Void)?, onRecords: (() -> Void)?
    var isVisible: Bool { panel.isVisible }
    var frame: CGRect { panel.frame }
    override init() {
        panel = CompanionPanel(contentRect:NSRect(x:0,y:0,width:384,height:164),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        super.init()
        panel.title = "和大肥鱼交代事情"; panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true; panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.ignoresCycle]
        let background = NSVisualEffectView(); background.material = .popover; background.blendingMode = .behindWindow; background.state = .active
        background.wantsLayer = true; background.layer?.cornerRadius = 18; background.layer?.masksToBounds = true
        background.layer?.borderWidth = 1; background.layer?.borderColor = NSColor.systemBlue.withAlphaComponent(0.22).cgColor
        panel.contentView = background
        header.font = .systemFont(ofSize:15,weight:.semibold); header.textColor = .labelColor
        status.font = .systemFont(ofSize:12); status.textColor = .secondaryLabelColor; status.lineBreakMode = .byTruncatingTail
        status.setAccessibilityIdentifier("anylink.companion.status")
        input.placeholderString = "想让我做什么？"; input.font = .systemFont(ofSize:14); input.bezelStyle = .roundedBezel
        input.focusRingType = .none; input.delegate = self; input.target = self; input.action = #selector(submit)
        input.setAccessibilityLabel("交代给大肥鱼的事情"); input.setAccessibilityIdentifier("anylink.companion.input")
        input.onEscape = { [weak self] in self?.onClose?() }
        for button in [send,stop,records,close] { button.target = self; button.bezelStyle = .rounded }
        send.action = #selector(submit); send.keyEquivalent = "\r"; send.contentTintColor = .systemBlue
        send.setAccessibilityIdentifier("anylink.companion.send")
        stop.action = #selector(cancel); stop.setAccessibilityIdentifier("anylink.companion.cancel")
        records.action = #selector(showRecords); records.isBordered = false; records.font = .systemFont(ofSize:11)
        close.image = NSImage(systemSymbolName:"xmark",accessibilityDescription:"收起，继续陪伴"); close.isBordered = false; close.action = #selector(dismiss)
        close.setAccessibilityIdentifier("anylink.companion.dismiss")
        progress.style = .spinning; progress.controlSize = .small; progress.isDisplayedWhenStopped = false
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 8
        content.edgeInsets = NSEdgeInsets(top:4,left:0,bottom:6,right:8); content.translatesAutoresizingMaskIntoConstraints = false
        let document = NSView(); document.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(content); scroll.documentView = document
        NSLayoutConstraint.activate([
            document.widthAnchor.constraint(equalTo:scroll.contentView.widthAnchor),
            content.leadingAnchor.constraint(equalTo:document.leadingAnchor),content.trailingAnchor.constraint(equalTo:document.trailingAnchor),
            content.topAnchor.constraint(equalTo:document.topAnchor),content.bottomAnchor.constraint(equalTo:document.bottomAnchor),
        ])
        for view in [header,status,input,send,stop,records,close,progress,scroll] { background.addSubview(view) }
        layout(height:164)
    }
    func show(beside avatar: CGRect,focus: Bool = true) {
        position(beside:avatar)
        if !panel.isVisible { panel.alphaValue = 0; panel.orderFrontRegardless(); NSAnimationContext.runAnimationGroup { context in context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.18; panel.animator().alphaValue = 1 } }
        if focus && input.isEnabled { focusWasRequested = true; panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(input) }
    }
    func hide() { panel.orderOut(nil); focusWasRequested = false }
    func position(beside avatar: CGRect) {
        guard let screen = CompanionGeometry.screen(for:avatar,among:NSScreen.screens.map(\.visibleFrame)) else { return }
        panel.setFrame(CompanionSurfaceGeometry.placement(beside:avatar,size:panel.frame.size,in:screen),display:true)
    }
    func update(_ interaction: CompanionInteraction,beside avatar: CGRect) {
        status.stringValue = interaction.phase == .executing && !interaction.toolLabel.isEmpty ? interaction.toolLabel : interaction.phase.label
        input.isEnabled = !interaction.pending; send.isEnabled = !interaction.pending
        stop.isHidden = !interaction.pending; stop.isEnabled = interaction.phase != .cancelling; records.isHidden = interaction.phase == .attending || interaction.phase == .resting
        if interaction.pending { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
        let signature = interaction.phase.rawValue+interaction.answer+interaction.toolLabel+interaction.files.map(\.path).joined(separator:"\0")
        if signature != resultSignature {
            resultSignature = signature
            for view in content.arrangedSubviews { content.removeArrangedSubview(view); view.removeFromSuperview() }
            if interaction.searchReturned {
                addLabel("文件结果 \(interaction.files.count) 项"+(interaction.partial ? " · 搜索范围不完整" : ""),color:interaction.partial ? .systemOrange : .secondaryLabelColor,size:12)
                for file in interaction.files.prefix(30) { addFile(file) }
                if interaction.files.isEmpty { addLabel("这次搜索没有返回匹配文件。",color:.secondaryLabelColor,size:13) }
                if interaction.files.count>30 { addLabel("其余结果可在完整记录中查看。",color:.secondaryLabelColor,size:11) }
            }
            if !interaction.answer.isEmpty { addLabel(interaction.answer,color:.labelColor,size:13) }
            if interaction.phase == .attention && interaction.pending { addLabel("可打开完整记录处理审批；任务尚未结束。",color:.secondaryLabelColor,size:12) }
        }
        let hasContent = !content.arrangedSubviews.isEmpty
        scroll.isHidden = !hasContent
        let resultHeight: CGFloat = hasContent ? min(242,max(64,content.fittingSize.height+8)) : 0
        layout(height:164+resultHeight)
        position(beside:avatar)
        if !interaction.pending && focusWasRequested && panel.isKeyWindow { panel.makeFirstResponder(input) }
    }
    private func layout(height: CGFloat) {
        panel.setContentSize(NSSize(width:384,height:height)); let width: CGFloat = 384
        header.frame = NSRect(x:18,y:height-37,width:120,height:21)
        close.frame = NSRect(x:width-43,y:height-39,width:26,height:26)
        progress.frame = NSRect(x:18,y:height-63,width:14,height:14)
        status.frame = NSRect(x:39,y:height-66,width:width-60,height:20)
        input.frame = NSRect(x:18,y:height-109,width:width-108,height:30)
        send.frame = NSRect(x:width-85,y:height-110,width:70,height:32)
        stop.frame = NSRect(x:14,y:13,width:94,height:29)
        records.frame = NSRect(x:width-112,y:15,width:94,height:25)
        scroll.frame = NSRect(x:18,y:52,width:width-36,height:max(0,height-164))
    }
    private func addLabel(_ value: String,color: NSColor,size: CGFloat) {
        let label = NSTextField(wrappingLabelWithString:value); label.font = .systemFont(ofSize:size); label.textColor = color; label.isSelectable = true
        label.preferredMaxLayoutWidth = 326; label.widthAnchor.constraint(equalToConstant:326).isActive = true
        content.addArrangedSubview(label)
    }
    private func addFile(_ file: CompanionFileResult) {
        let row = NSStackView(); row.orientation = .vertical; row.alignment = .leading; row.spacing = 3
        let title = NSTextField(labelWithString:file.name); title.font = .systemFont(ofSize:13,weight:.medium); title.lineBreakMode = .byTruncatingMiddle
        let path = NSTextField(labelWithString:file.path); path.font = .systemFont(ofSize:10); path.textColor = .secondaryLabelColor; path.lineBreakMode = .byTruncatingMiddle; path.isSelectable = true
        title.widthAnchor.constraint(equalToConstant:326).isActive = true; path.widthAnchor.constraint(equalToConstant:326).isActive = true
        let reveal = FileResultButton(title:"在访达中显示",target:self,action:#selector(revealFile)); reveal.file = file
        let copy = FileResultButton(title:"复制路径",target:self,action:#selector(copyPath)); copy.file = file
        for button in [reveal,copy] { button.isBordered = false; button.font = .systemFont(ofSize:11); button.contentTintColor = .systemBlue }
        let actions = NSStackView(views:[reveal,copy]); actions.spacing = 12
        for view in [title,path,actions] { row.addArrangedSubview(view) }; content.addArrangedSubview(row)
    }
    @objc private func submit() {
        guard input.isEnabled else { return }; let text = input.stringValue.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !text.isEmpty,text.count<=6000 else { return }; input.stringValue = ""; onSubmit?(text)
    }
    @objc private func cancel() { onCancel?() }
    @objc private func dismiss() { onClose?() }
    @objc private func showRecords() { onRecords?() }
    @objc private func revealFile(_ sender: FileResultButton) {
        guard let file = sender.file,FileManager.default.fileExists(atPath:file.path) else { status.stringValue = "文件已移动或不可访问"; return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath:file.path)])
    }
    @objc private func copyPath(_ sender: FileResultButton) {
        guard let path = sender.file?.path else { return }; NSPasteboard.general.clearContents(); NSPasteboard.general.setString(path,forType:.string)
    }
    func control(_ control: NSControl,textView: NSTextView,doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == Selector(("cancelOperation:")) { onClose?(); return true }; return false
    }
}
private final class FileResultButton: NSButton { var file: CompanionFileResult? }
