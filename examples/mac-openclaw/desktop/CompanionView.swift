import AppKit

@MainActor
final class CompanionView: NSView {
    let renderer: CompanionRenderer
    var emotion: CompanionEmotion = .neutral
    var speaking = false, walking = false
    var entrance = 1.0, portal = false, interactionBlocked = false
    var walkDirection = 1.0
    var activity = "resting", lookDirection = 0.0
    var onDragStart: (() -> Void)?, onStopSpeech: (() -> Void)?
    var pointerInside: Bool { window.map { $0.frame.contains(NSEvent.mouseLocation) } ?? false }
    var mood: CompanionMood = .idle { didSet { if mood != oldValue { needsDisplay = true; updateAccessibility() } } }
    var onEngage: (() -> Void)?, onMoved: (() -> Void)?
    private var press: NSPoint?, original: NSPoint?, dragged = false
    private(set) var dragging = false
    init(root: URL) {
        renderer = CompanionRenderer(root:root); super.init(frame:.zero)
        addSubview(renderer.webView)
        setAccessibilityElement(true); setAccessibilityRole(.button); updateAccessibility()
        setAccessibilityIdentifier("anylink.companion.avatar")
        setAccessibilityHelp("点击叫大肥鱼，在她身边交代事情。拖动可以移动形象，Esc 停止说话。")
    }
    required init?(coder: NSCoder) { return nil }
    override func layout() { super.layout(); renderer.webView.frame = bounds }
    override func hitTest(_ point: NSPoint) -> NSView? { bounds.contains(point) ? self : nil }
    private func updateAccessibility() { setAccessibilityLabel("AnyLink 蓝色大肥鱼 · "+mood.label); setAccessibilityValue(mood.label) }
    func animate(time: Double) {
        guard let window else { return }
        let point = convert(window.convertPoint(fromScreen:NSEvent.mouseLocation),from:nil)
        let body = renderer.webView.frame
        renderer.update(mood:mood,x:Double(point.x),y:Double(body.height-point.y),reducedMotion:NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,emotion:emotion,speaking:speaking,walking:walking,direction:walkDirection,entrance:entrance,portal:portal,activity:activity,look:lookDirection)
        let interactive = !interactionBlocked && (dragging || (body.contains(point) && renderer.hit))
        if window.ignoresMouseEvents == interactive { window.ignoresMouseEvents = !interactive }
    }
    override var acceptsFirstResponder: Bool { true }
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        onDragStart?(); press = NSEvent.mouseLocation; original = window.frame.origin; dragged = false; dragging = true
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
        else { onEngage?() }
        press = nil; original = nil
    }
    override func rightMouseDown(with event: NSEvent) { /* Conversation replaces the context menu. */ }
    override func keyDown(with event: NSEvent) { if event.keyCode == 53 { onStopSpeech?() } else { super.keyDown(with:event) } }
    override func accessibilityPerformPress() -> Bool { onEngage?(); return true }
}
