import Foundation

enum SwipeDirection: String {
    case up
    case down

    var korean: String {
        switch self {
        case .up: return "위"
        case .down: return "아래"
        }
    }
}

/// Phase-2 hook: a future BLE HID / ESP32 mouse would implement this.
/// Phase 1 only logs and counts.
protocol SwipeOutput: AnyObject {
    func sendSwipe(_ direction: SwipeDirection)
}

final class LoggingSwipeOutput: SwipeOutput {
    private(set) var upCount = 0
    private(set) var downCount = 0
    var onChange: (() -> Void)?

    func sendSwipe(_ direction: SwipeDirection) {
        switch direction {
        case .up: upCount += 1
        case .down: downCount += 1
        }
        let n = direction == .up ? upCount : downCount
        DiagnosticLog.shared.append("스와이프 \(direction.korean) (#\(n)) · 출력=로그(BLE 없음)")
        NSLog("[SwipeOutput] %@ up=%d down=%d", direction.rawValue, upCount, downCount)
        if Thread.isMainThread {
            onChange?()
        } else {
            DispatchQueue.main.async { [weak self] in self?.onChange?() }
        }
    }
}
