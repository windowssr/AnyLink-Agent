import Foundation
import CoreGraphics

enum CompanionEmotion: String, CaseIterable, Decodable { case neutral, happy, excited, comfort, curious, apologetic }

struct CompanionProjection: Decodable {
    let id: String, type: String
    let created_at: Double, expires_at: Double
    let agentId: String, sessionId: String, sessionKey: String, runId: String
    let emotion: CompanionEmotion?
    let gesture: String?, text: String?, caption: String?
    let explicit_expression: Bool?
    func valid(now: Double,started: Double) -> Bool {
        ["user","reply","expression","error"].contains(type) && created_at >= started && created_at <= now+5000 && expires_at >= now && expires_at-created_at <= 120000
    }
}

enum CompanionPolicy {
    static func quiet(hour: Int) -> Bool { hour >= 23 || hour < 8 }
    static func canInitiate(enabled: Bool,quiet: Bool,away: Bool,busy: Bool,speaking: Bool,paused: Bool,lastAttempt: Double,now: Double,daily: Int) -> Bool {
        enabled && !quiet && !away && !busy && !speaking && !paused && daily < 6 && now-lastAttempt >= 1200
    }
    static func cleanSpeech(_ value: String,limit: Int = 1400) -> String {
        let cleaned = value.replacingOccurrences(of:"```[\\s\\S]*?(?:```|$)",with:"",options:.regularExpression)
            .replacingOccurrences(of:"<think>[\\s\\S]*?</think>",with:"",options:.regularExpression)
            .replacingOccurrences(of:"!?\\[([^\\]]*)\\]\\([^)]*\\)",with:"$1",options:.regularExpression)
            .replacingOccurrences(of:"https?://\\S+",with:"",options:.regularExpression)
            .replacingOccurrences(of:"[#*_>`|]",with:"",options:.regularExpression)
        return String(cleaned.prefix(limit)).trimmingCharacters(in:.whitespacesAndNewlines)
    }
    static func normalizedSession(_ value: String) -> String { value.replacingOccurrences(of:"-",with:"").lowercased() }
}

struct CompanionWalk {
    let from: CGPoint, to: CGPoint, started: Double, duration: Double
    var direction: Double { to.x >= from.x ? 1 : -1 }
    func position(at now: Double) -> CGPoint {
        let progress = min(1,max(0,(now-started)/duration)), eased = progress*progress*(3-2*progress)
        return CGPoint(x:from.x+(to.x-from.x)*eased,y:from.y+(to.y-from.y)*eased)
    }
    func finished(at now: Double) -> Bool { now >= started+duration }
}

struct CompanionEntrance {
    let from: CGRect, to: CGRect, started: Double, reducedMotion: Bool
    var duration: Double { reducedMotion ? 0.25 : 3.2 }
    private func ease(_ value: Double) -> Double { let t = min(1,max(0,value)); return t*t*(3-2*t) }
    func appearance(at now: Double) -> Double { ease((now-started)/(reducedMotion ? 0.25 : 1.5)) }
    func portal(at now: Double) -> Bool { !reducedMotion && now-started<1.85 }
    func frame(at now: Double) -> CGRect {
        let t = reducedMotion ? 1 : ease((now-started-1.8)/1.4)
        return CGRect(x:from.minX+(to.minX-from.minX)*t,y:from.minY+(to.minY-from.minY)*t,width:from.width+(to.width-from.width)*t,height:from.height+(to.height-from.height)*t)
    }
    func phase(at now: Double) -> String { now>=started+duration ? "finished" : (now-started<1.8 ? "emerging" : "settling") }
    func finished(at now: Double) -> Bool { now>=started+duration }
}
