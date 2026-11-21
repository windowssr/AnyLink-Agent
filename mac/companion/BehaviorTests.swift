import Foundation
import CoreGraphics
@main struct BehaviorTests {
    static func main() {
        precondition(CompanionPolicy.quiet(hour:23));precondition(CompanionPolicy.quiet(hour:7));precondition(!CompanionPolicy.quiet(hour:8))
        func allowed(quiet: Bool = false,away: Bool = false,busy: Bool = false,paused: Bool = false,daily: Int = 0,last: Double = 0) -> Bool {
            CompanionPolicy.canInitiate(enabled:true,quiet:quiet,away:away,busy:busy,speaking:false,paused:paused,lastAttempt:last,now:10000,daily:daily)
        }
        precondition(allowed());precondition(!allowed(quiet:true));precondition(!allowed(away:true));precondition(!allowed(busy:true));precondition(!allowed(paused:true));precondition(!allowed(daily:6));precondition(!allowed(last:9500))
        let walk = CompanionWalk(from:CGPoint(x:-900,y:40),to:CGPoint(x:-700,y:40),started:10,duration:5)
        precondition(walk.position(at:0).x == -900);precondition(walk.position(at:12.5).x == -800);precondition(walk.position(at:20).x == -700);precondition(walk.finished(at:15))
        let data = Data("{\"id\":\"x\",\"type\":\"reply\",\"created_at\":1000,\"expires_at\":5000,\"agentId\":\"main\",\"sessionId\":\"s\",\"sessionKey\":\"k\",\"runId\":\"r\",\"emotion\":\"happy\"}".utf8)
        let event = try! JSONDecoder().decode(CompanionProjection.self,from:data)
        precondition(event.valid(now:2000,started:900));precondition(!event.valid(now:2000,started:1100));precondition(!event.valid(now:6000,started:900))
        precondition(CompanionPolicy.cleanSpeech("你好。```js\nsecret\n``` 再见。") == "你好。 再见。")
        print("PASS: 18 proactive policy, stale event, speech sanitation and bounded walk checks")
    }
}
