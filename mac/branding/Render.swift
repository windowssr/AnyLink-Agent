import AppKit
import WebKit

@MainActor final class PortraitRenderer: NSObject,NSApplicationDelegate,WKScriptMessageHandler,WKNavigationDelegate {
    private var web: WKWebView!
    private var timeout: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.prohibited)
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        if #available(macOS 14.0, *) { config.preferences.inactiveSchedulingPolicy = .none }
        config.userContentController.add(self,name:"brand")
        web = WKWebView(frame:NSRect(x:0,y:0,width:1024,height:2048),configuration:config)
        web.navigationDelegate = self
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let value = String(data:data,encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines),let url = URL(string:value),url.host == "127.0.0.1" else { exit(1) }
        web.load(URLRequest(url:url))
        timeout = Timer.scheduledTimer(withTimeInterval:40,repeats:false) { _ in fputs("Local portrait rendering timed out.\n",stderr);exit(1) }
    }
    func userContentController(_ userContentController: WKUserContentController,didReceive message: WKScriptMessage) {
        if let value = message.body as? [String:String],value["type"] == "stage" { print("Portrait stage: "+(value["stage"] ?? "loading"));return }
        guard let value = message.body as? [String:String],value["type"] == "portrait",let encoded = value["png"],let data = Data(base64Encoded:encoded),let source = NSImage(data:data) else { fputs("Local portrait rendering failed.\n",stderr);exit(1) }
        let output = URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        do {
            try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            for (name,size) in [("avatar.png",512),("favicon-32.png",32),("apple-touch-icon.png",180)] {
                guard let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0),let context = NSGraphicsContext(bitmapImageRep:bitmap) else { exit(1) }
                NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current = context
                source.draw(in:NSRect(x:0,y:0,width:size,height:size));NSGraphicsContext.restoreGraphicsState()
                guard let png = bitmap.representation(using:.png,properties:[:]) else { exit(1) }
                try png.write(to:output.appendingPathComponent(name),options:.atomic)
            }
            timeout?.invalidate(); print("Rendered the local DaFeiYu portrait and page icons.");exit(0)
        } catch { fputs("Could not save local portrait.\n",stderr);exit(1) }
    }
    func webView(_ webView: WKWebView,didFailProvisionalNavigation navigation: WKNavigation!,withError error: Error) { fputs("Local portrait navigation failed (\((error as NSError).code)).\n",stderr);exit(1) }
}
@main struct RenderMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let renderer = PortraitRenderer();application.delegate = renderer;application.run()
    }
}
