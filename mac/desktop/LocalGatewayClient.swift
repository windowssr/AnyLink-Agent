import Foundation
import CryptoKit

enum LocalGatewayFailure: LocalizedError {
    case unavailable(String)
    var errorDescription: String? { if case let .unavailable(message) = self { return message }; return nil }
}

@MainActor
final class LocalGatewayClient {
    private let root: URL
    private let key: Curve25519.Signing.PrivateKey
    private var token = ""
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void,Never>?
    private var pending: [String: CheckedContinuation<[String:Any],Error>] = [:]
    private var connectWaiter: CheckedContinuation<Void,Error>?
    private var ready = false
    var onEvent: ((String,[String:Any]) -> Void)?
    var onDisconnect: (() -> Void)?
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral; config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }()
    init(root: URL) throws {
        self.root = root
        let directory = root.appendingPathComponent("data/mac/desktop",isDirectory:true)
        try FileManager.default.createDirectory(at: directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let file = directory.appendingPathComponent("device-key")
        if FileManager.default.fileExists(atPath:file.path) {
            let attrs = try FileManager.default.attributesOfItem(atPath:file.path)
            guard ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0, (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw LocalGatewayFailure.unavailable("桌面设备凭据权限不正确。") }
            key = try Curve25519.Signing.PrivateKey(rawRepresentation:Data(contentsOf:file))
        } else {
            key = Curve25519.Signing.PrivateKey()
            try key.rawRepresentation.write(to:file,options:.atomic)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        }
    }
    func connect() async throws {
        if ready { return }
        disconnect()
        let credential = root.appendingPathComponent("secrets/mac-gateway-token")
        let attributes = try FileManager.default.attributesOfItem(atPath:credential.path)
        guard ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0, (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw LocalGatewayFailure.unavailable("本机 Gateway 凭据权限不正确。") }
        token = try String(contentsOf:credential,encoding:.utf8).trimmingCharacters(in:.whitespacesAndNewlines)
        let ws = session.webSocketTask(with:URL(string:"ws://127.0.0.1:18791/")!); socket = ws; ws.resume()
        reader = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await ws.receive()
                    let data: Data
                    switch message { case .string(let text): data = Data(text.utf8); case .data(let bytes): data = bytes; @unknown default: continue }
                    guard let frame = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { continue }
                    guard let self, self.socket === ws else { return }
                    await self.receive(frame)
                }
            } catch { if let self, self.socket === ws { self.failConnection() } }
        }
        try await withCheckedThrowingContinuation { continuation in
            connectWaiter = continuation
            Task { [weak self] in
                try? await Task.sleep(nanoseconds:30_000_000_000)
                if let self, self.socket === ws, !self.ready { self.failConnection() }
            }
        }
    }
    private func base64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"") }
    private func receive(_ frame: [String:Any]) async {
        if frame["type"] as? String == "res", let id = frame["id"] as? String, let waiter = pending.removeValue(forKey:id) {
            if frame["ok"] as? Bool == true { waiter.resume(returning:frame["payload"] as? [String:Any] ?? [:]) }
            else {
                let error = frame["error"] as? [String:Any], details = error?["details"] as? [String:Any]
                let code = details?["code"] as? String ?? error?["code"] as? String ?? "RPC_ERROR"
                waiter.resume(throwing:LocalGatewayFailure.unavailable("本机 Agent 拒绝请求（\(code)）。请检查连接或审批。"))
            }
            return
        }
        guard frame["type"] as? String == "event", let name = frame["event"] as? String, let payload = frame["payload"] as? [String:Any] else { return }
        if name == "connect.challenge" {
            guard let nonce = payload["nonce"] as? String, let ts = payload["ts"] as? NSNumber else { failConnection(); return }
            let publicKey = key.publicKey.rawRepresentation
            let id = SHA256.hash(data:publicKey).map { String(format:"%02x",$0) }.joined()
            let scopes = ["operator.read"]
            let signed = ["v3",id,"openclaw-macos","ui","operator",scopes.joined(separator:","),ts.stringValue,token,nonce,"macos","mac"].joined(separator:"|")
            let connection = socket
            Task { do {
                let hello = try await call("connect",[
                    "minProtocol":4,"maxProtocol":4,"client":["id":"openclaw-macos","displayName":"AnyLink Desktop","version":"0.5.0","platform":"macos","deviceFamily":"mac","mode":"ui"],
                    "role":"operator","scopes":scopes,"caps":["session-scoped-events","roster-message-bodies-optional"],"includeSessionMessageBodies":false,"auth":["token":token],"locale":"zh-CN",
                    "device":["id":id,"publicKey":base64(publicKey),"signature":base64(try key.signature(for:Data(signed.utf8))),"signedAt":ts,"nonce":nonce]
                ],requiresReady:false)
                guard self.socket === connection else { return }
                let auth = hello["auth"] as? [String:Any], granted = auth?["scopes"] as? [String] ?? []
                guard scopes.allSatisfy({ granted.contains($0) }) else { throw LocalGatewayFailure.unavailable("桌面状态连接没有读取权限。") }
                ready = true; connectWaiter?.resume(); connectWaiter = nil
            } catch { guard self.socket === connection else { return }; connectWaiter?.resume(throwing:error); connectWaiter = nil; disconnect() } }
        } else if ready { onEvent?(name,payload) }
    }
    func call(_ method: String,_ params: [String:Any],requiresReady: Bool = true) async throws -> [String:Any] {
        guard ["connect","sessions.list"].contains(method) else { throw LocalGatewayFailure.unavailable("桌面伙伴只允许读取 Agent 状态。") }
        guard let ws = socket, !requiresReady || ready else { throw LocalGatewayFailure.unavailable("本机状态连接未就绪。") }
        let id = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject:["type":"req","id":id,"method":method,"params":params])
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task { [weak self] in
                do { try await ws.send(.string(String(decoding:data,as:UTF8.self))) }
                catch { self?.pending.removeValue(forKey:id)?.resume(throwing:LocalGatewayFailure.unavailable("发送结果未确认；不会自动重发。")) }
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds:20_000_000_000)
                self?.pending.removeValue(forKey:id)?.resume(throwing:LocalGatewayFailure.unavailable("本机请求超时，结果待确认；不会自动重发。"))
            }
        }
    }
    func disconnect() {
        ready = false; reader?.cancel(); reader = nil; socket?.cancel(with:.goingAway,reason:nil); socket = nil
        connectWaiter?.resume(throwing:CancellationError()); connectWaiter = nil
        let waiters = pending.values; pending.removeAll(); for waiter in waiters { waiter.resume(throwing:CancellationError()) }
    }
    private func failConnection() { disconnect(); onDisconnect?() }
}
