import Foundation
import CoreGraphics

enum CompanionMood: String, CaseIterable {
    case idle, thinking, working, attention, finished, offline, happy, sleepy
    var caption: String {
        switch self {
        case .idle: return "我在，随时叫我。"
        case .thinking: return "任务在排队，我陪你等。"
        case .working: return "正在帮你处理…"
        case .attention: return "有件事需要你看看。"
        case .finished: return "这轮结束了，点我看结果。"
        case .offline: return "暂时连不上助理，我还在。"
        case .happy: return "收到你的摸摸啦。"
        case .sleepy: return "安静陪你一会儿。"
        }
    }
    var label: String {
        switch self { case .idle: return "待命"; case .thinking: return "排队中"; case .working: return "忙碌中"; case .attention: return "需要查看"; case .finished: return "本轮结束"; case .offline: return "连接中"; case .happy: return "开心"; case .sleepy: return "安静陪伴" }
    }
}

struct CompanionSnapshot {
    let mood: CompanionMood
    let activeKeys: Set<String>
    static func decode(_ result: [String:Any]) -> CompanionSnapshot {
        let shared = result["sharedFacts"] as? [[String:Any]] ?? []
        let rows = (result["sessions"] as? [[String:Any]] ?? []).map { row -> [String:Any] in
            var expanded: [String:Any] = [:]
            for index in row["sharedFacts"] as? [Int] ?? [] where index >= 0 && index < shared.count { expanded.merge(shared[index]) { _,new in new } }
            expanded.merge(row) { _,new in new }; return expanded
        }
        let active = rows.filter { row in
            let status = row["status"] as? String
            if let status, !["running","queued"].contains(status) { return false }
            return row["hasActiveRun"] as? Bool == true || ["running","queued"].contains(status ?? "")
        }
        let keys = Set(active.compactMap { $0["key"] as? String })
        if active.contains(where:{ row in
            guard let value = row["agentStatus"] as? [String:Any], let icon = value["attention"] as? String else { return false }
            let expires = (value["expiresAt"] as? NSNumber)?.doubleValue ?? 0
            return ["hand","key","lock","alert","flag"].contains(icon) && expires > Date().timeIntervalSince1970*1000
        }) { return CompanionSnapshot(mood:.attention,activeKeys:keys) }
        if active.contains(where:{ $0["status"] as? String != "queued" }) { return CompanionSnapshot(mood:.working,activeKeys:keys) }
        if !active.isEmpty { return CompanionSnapshot(mood:.thinking,activeKeys:keys) }
        return CompanionSnapshot(mood:.idle,activeKeys:keys)
    }
}

enum CompanionGeometry {
    static func contain(_ frame: CGRect,in visible: CGRect) -> CGRect {
        var result = frame
        result.origin.x = max(visible.minX,min(frame.minX,visible.maxX-frame.width))
        result.origin.y = max(visible.minY,min(frame.minY,visible.maxY-frame.height))
        return result
    }
    static func screen(for frame: CGRect,among screens: [CGRect]) -> CGRect? {
        screens.max { a,b in a.intersection(frame).area < b.intersection(frame).area }
    }
}
private extension CGRect { var area: CGFloat { isNull ? 0 : width*height } }
