import Foundation

@main struct CompanionControlTests {
    @MainActor static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let server = CompanionControlServer(root:root); var applied = 0
        server.onCommand = { _ in applied += 1; return ["applied":true,"status":"applied"] }; server.start()
        defer { server.stop() }
        let folder = root.appendingPathComponent("data/mac/companion/control")
        let presence = try JSONSerialization.jsonObject(with:Data(contentsOf:folder.appendingPathComponent("presence.json"))) as! [String:Any]
        let epoch = presence["epoch"] as! String
        func request(_ number: Int,age: Double = 0,session: String? = nil,command: [String:Any] = ["action":"walk"]) throws -> [String:Any] {
            let id = String(format:"%064x",number),now = Date().timeIntervalSince1970*1000
            let value: [String:Any] = ["id":id,"epoch":session ?? epoch,"created_at":now-age,"expires_at":now-age+12000,"command":command]
            try JSONSerialization.data(withJSONObject:value).write(to:folder.appendingPathComponent("requests/"+id+".json"))
            server.poll()
            return try JSONSerialization.jsonObject(with:Data(contentsOf:folder.appendingPathComponent("receipts/"+id+".json"))) as! [String:Any]
        }
        func check(_ result: [String:Any],_ expected: Bool) { precondition(result["applied"] as? Bool == expected) }
        check(try request(1),true)
        _ = try request(1); precondition(applied == 1,"Duplicate tool IDs cannot execute twice")
        check(try request(2,age:13000),false)
        check(try request(3,session:"previous-process"),false)
        check(try request(4,command:["action":"resize","scale":10]),false)
        server.pause(true); check(try request(5),false)
        server.pause(false); check(try request(6,command:["action":"configure","read_aloud":true]),true)
        precondition(applied == 2)
        let permission = try FileManager.default.attributesOfItem(atPath:folder.appendingPathComponent("presence.json").path)[.posixPermissions] as! NSNumber
        precondition(permission.intValue & 0o077 == 0)
        print("PASS native command delivery, duplicate reconciliation, old-epoch and expired request rejection, bounds, sleep and private receipts")
    }
}
