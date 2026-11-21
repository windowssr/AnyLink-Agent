import AppKit

@MainActor
final class CompanionView: NSView {
    let renderer: CompanionRenderer
    var mood: CompanionMood = .idle { didSet { if mood != oldValue { needsDisplay = true; updateAccessibility() } } }
    var onTap: (() -> Void)?, onOpenChat: (() -> Void)?, onMoved: (() -> Void)?, onMenu: (() -> NSMenu)?
    private var press: NSPoint?, original: NSPoint?, dragged = false
    private(set) var dragging = false
    init(root: URL) {
        renderer = CompanionRenderer(root:root); super.init(frame:.zero)
        addSubview(renderer.webView)
        setAccessibilityElement(true); setAccessibilityRole(.button); updateAccessibility()
        setAccessibilityHelp("蓝色大肥鱼；拖动移动；单击举手；双击打开聊天；右键选择动作和大小。")
    }
    required init?(coder: NSCoder) { return nil }
    override func layout() { super.layout(); renderer.webView.frame = NSRect(x:0,y:0,width:bounds.width,height:max(1,bounds.height-78)) }
    override func hitTest(_ point: NSPoint) -> NSView? { bounds.contains(point) ? self : nil }
    private func updateAccessibility() { setAccessibilityLabel("AnyLink 蓝色大肥鱼 · "+mood.label); setAccessibilityValue(mood.caption) }
    private var bubbleRect: NSRect { NSRect(x:8,y:bounds.height-73,width:bounds.width-16,height:60) }
    func animate(time: Double) {
        guard let window else { return }
        let point = convert(window.convertPoint(fromScreen:NSEvent.mouseLocation),from:nil)
        let body = renderer.webView.frame
        renderer.update(mood:mood,x:Double(point.x),y:Double(body.height-point.y),reducedMotion:NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        let interactive = dragging || bubbleRect.contains(point) || (body.contains(point) && renderer.hit)
        if window.ignoresMouseEvents == interactive { window.ignoresMouseEvents = !interactive }
    }
    override var acceptsFirstResponder: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let bubble = NSBezierPath(roundedRect:bubbleRect,xRadius:15,yRadius:15)
        NSColor(calibratedRed:0.96,green:0.99,blue:1,alpha:0.96).setFill(); bubble.fill()
        NSColor(calibratedRed:0.37,green:0.72,blue:0.78,alpha:0.30).setStroke(); bubble.lineWidth = 1; bubble.stroke()
        let text = bubbleRect.insetBy(dx:12,dy:8)
        ("AnyLink · 蓝色大肥鱼" as NSString).draw(at:NSPoint(x:text.minX,y:text.maxY-12),withAttributes:[.font:NSFont.systemFont(ofSize:10,weight:.semibold),.foregroundColor:NSColor(calibratedRed:0.20,green:0.49,blue:0.56,alpha:1)])
        let caption = renderer.status == "ready" ? mood.caption : (["load_failed","assets_missing"].contains(renderer.status) ? "形象加载失败，请检查本地素材。" : "大肥鱼正在来到桌面…")
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
        (caption as NSString).draw(in:NSRect(x:text.minX,y:text.minY-1,width:text.width,height:22),withAttributes:[.font:NSFont.systemFont(ofSize:11.5,weight:.medium),.foregroundColor:NSColor(calibratedWhite:0.18,alpha:1),.paragraphStyle:paragraph])
    }
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        press = NSEvent.mouseLocation; original = window.frame.origin; dragged = false; dragging = true
        window.ignoresMouseEvents = false; NSCursor.closedHand.push()
    }
    override func mouseDragged(with event: NSEvent) {
        guard let press,let original,let window else { return }
        let mouse = NSEvent.mouseLocation, dx = mouse.x-press.x, dy = mouse.y-press.y
        if hypot(dx,dy)>4 { dragged = true; window.setFrameOrigin(NSPoint(x:original.x+dx,y:original.y+dy)) }
    }
    override func mouseUp(with event: NSEvent) {
        dragging = false; NSCursor.pop()
        if dragged { onMoved?() }
        else if event.clickCount>=2 || bubbleRect.contains(convert(event.locationInWindow,from:nil)) { onOpenChat?() }
        else { onTap?() }
        press = nil; original = nil
    }
    override func rightMouseDown(with event: NSEvent) { if let menu = onMenu?() { NSMenu.popUpContextMenu(menu,with:event,for:self) } }
    override func accessibilityPerformPress() -> Bool { onOpenChat?(); return true }
}
