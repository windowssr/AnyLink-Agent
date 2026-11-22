import Foundation
import CoreGraphics

@main struct CompanionTests {
    static func main() {
        func snapshot(_ rows: [[String:Any]],_ shared: [[String:Any]] = []) -> CompanionSnapshot { CompanionSnapshot.decode(["sessions":rows,"sharedFacts":shared]) }
        precondition(snapshot([]).mood == .idle)
        precondition(snapshot([["key":"a","status":"running","hasActiveRun":true]]).mood == .working)
        precondition(snapshot([["key":"a","status":"queued"]]).mood == .thinking)
        precondition(snapshot([["key":"a","status":"killed","hasActiveRun":true]]).activeKeys.isEmpty,"Historic killed runs cannot appear busy")
        precondition(snapshot([["key":"a","sharedFacts":[0]]],[["hasActiveRun":true,"status":"running"]]).mood == .working,"Sidebar shared facts carry active state")
        precondition(snapshot([["key":"a","hasActiveRun":false,"sharedFacts":[0]]],[["hasActiveRun":true]]).mood == .idle,"The row overrides shared fields")
        let waiting: [String:Any] = ["key":"a","status":"running","agentStatus":["attention":"hand","expiresAt":Date().timeIntervalSince1970*1000+30000]]
        precondition(snapshot([waiting]).mood == .attention)
        precondition(snapshot([["key":"a","status":"running","agentStatus":["attention":"hand","expiresAt":1]]]).mood == .working,"Expired attention is not current")
        precondition(snapshot([["key":"a","status":"queued"],["key":"b","status":"running"]]).activeKeys == Set(["a","b"]))
        let display = CGRect(x:-1920,y:0,width:1920,height:1080), off = CGRect(x:-2200,y:-200,width:224,height:320)
        precondition(CompanionGeometry.contain(off,in:display).origin == CGPoint(x:-1920,y:0))
        let right = CompanionGeometry.contain(CGRect(x:1900,y:1000,width:224,height:320),in:CGRect(x:0,y:24,width:1920,height:1056))
        precondition(right.maxX == 1920 && right.maxY == 1080)
        precondition(CompanionGeometry.screen(for:CGRect(x:-1000,y:0,width:224,height:320),among:[display,CGRect(x:0,y:0,width:1920,height:1080)]) == display)
        let cardSize = CGSize(width:384,height:406)
        let besideRight = CompanionSurfaceGeometry.placement(beside:CGRect(x:1600,y:0,width:280,height:440),size:cardSize,in:CGRect(x:0,y:0,width:1920,height:1080))
        precondition(besideRight.maxX<1600 && besideRight.minY>=12)
        let besideLeft = CompanionSurfaceGeometry.placement(beside:CGRect(x:-1900,y:0,width:280,height:440),size:cardSize,in:display)
        precondition(besideLeft.minX > -1620 && besideLeft.maxX<=display.maxX-12)
        let above = CompanionSurfaceGeometry.placement(beside:CGRect(x:900,y:850,width:280,height:440),size:cardSize,in:CGRect(x:0,y:0,width:1920,height:1080))
        precondition(above.maxY<=1068 && above.minY>=12)
        print("PASS: 12 companion state, privacy projection and multi-display geometry checks")
    }
}
