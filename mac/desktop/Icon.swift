import AppKit

// Code-native vector artwork; all icon sizes derive from this one drawing.
let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let tile = NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 214, yRadius: 214)
let gradient = NSGradient(starting: NSColor(calibratedRed: 0.06, green: 0.38, blue: 0.40, alpha: 1), ending: NSColor(calibratedRed: 0.04, green: 0.17, blue: 0.24, alpha: 1))!
gradient.draw(in: tile, angle: -65)
let connection = NSBezierPath()
connection.move(to: NSPoint(x: 305, y: 320)); connection.line(to: NSPoint(x: 513, y: 718)); connection.line(to: NSPoint(x: 720, y: 320))
connection.lineWidth = 58; connection.lineCapStyle = .round; connection.lineJoinStyle = .round
NSColor(calibratedRed: 0.85, green: 0.99, blue: 0.95, alpha: 1).setStroke(); connection.stroke()
let bridge = NSBezierPath(); bridge.move(to: NSPoint(x: 390, y: 467)); bridge.line(to: NSPoint(x: 632, y: 467))
bridge.lineWidth = 44; bridge.lineCapStyle = .round
NSColor(calibratedRed: 0.35, green: 0.90, blue: 0.73, alpha: 1).setStroke(); bridge.stroke()
for point in [NSPoint(x: 305, y: 320), NSPoint(x: 513, y: 718), NSPoint(x: 720, y: 320)] {
    NSColor(calibratedRed: 0.38, green: 0.94, blue: 0.77, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: point.x - 48, y: point.y - 48, width: 96, height: 96)).fill()
}
image.unlockFocus()
guard CommandLine.arguments.count == 2, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
