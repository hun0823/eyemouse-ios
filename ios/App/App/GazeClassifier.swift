import Foundation
import Vision
import CoreVideo

enum GazeZone: String {
    case unknown
    case up
    case center
    case down

    var korean: String {
        switch self {
        case .unknown: return "없음"
        case .up: return "위"
        case .center: return "가운데"
        case .down: return "아래"
        }
    }
}

enum GazeSensitivity: String, CaseIterable {
    case high
    case medium
    case low

    var korean: String {
        switch self {
        case .high: return "상"
        case .medium: return "중"
        case .low: return "하"
        }
    }

    /// Dwell before an up/down event. 중 matches the web app (1.5s).
    var dwellSeconds: TimeInterval {
        switch self {
        case .high: return 1.0
        case .medium: return 1.5
        case .low: return 2.0
        }
    }

    /// How far from center toward the calibrated edge (0…1) before counting as that edge.
    /// 상 = closer to center (more sensitive).
    var edgeFraction: Double {
        switch self {
        case .high: return 0.35
        case .medium: return 0.50
        case .low: return 0.70
        }
    }

    static func fromKorean(_ text: String) -> GazeSensitivity {
        switch text {
        case "상": return .high
        case "하": return .low
        default: return .medium
        }
    }
}

struct GazeCalibration: Codable {
    var center: Double
    var top: Double
    var bottom: Double
    var savedAt: Date
}

/// Coarse up / center / down from Vision face landmarks (pupils vs eye contour)
/// plus head pitch. No paid entitlement, no ARKit.
final class GazeClassifier {
    static let cooldownSeconds: TimeInterval = 1.5

    private let defaultsCalibKey = "eyemouse.pip.calib.v1"
    private let defaultsSensKey = "eyemouse.pip.sensitivity"

    private(set) var calibration: GazeCalibration?
    var sensitivity: GazeSensitivity {
        didSet { UserDefaults.standard.set(sensitivity.rawValue, forKey: defaultsSensKey) }
    }

    private(set) var lastScore: Double?
    private(set) var lastZone: GazeZone = .unknown
    private(set) var dwellProgress: Double = 0
    private(set) var dwellZone: GazeZone = .center
    private(set) var facePresent = false

    /// While true, frames are recorded into `calibSamples` instead of dwelling.
    var isCalibrating = false
    private var calibSamples: [Double] = []

    private var dwellStartedAt: Date?
    private var cooldownUntil: Date = .distantPast
    private var lastFrameAt: Date?

    weak var swipeOutput: SwipeOutput?
    var onEvent: ((SwipeDirection) -> Void)?
    var onFlash: ((SwipeDirection) -> Void)?
    private let lock = NSLock()

    struct Live {
        var lastScore: Double?
        var lastZone: GazeZone
        var dwellProgress: Double
        var dwellZone: GazeZone
        var facePresent: Bool
    }

    func liveSnapshot() -> Live {
        lock.lock()
        defer { lock.unlock() }
        return Live(
            lastScore: lastScore,
            lastZone: lastZone,
            dwellProgress: dwellProgress,
            dwellZone: dwellZone,
            facePresent: facePresent
        )
    }

    init() {
        if let raw = UserDefaults.standard.string(forKey: defaultsSensKey),
           let s = GazeSensitivity(rawValue: raw) {
            sensitivity = s
        } else {
            sensitivity = .medium
        }
        calibration = loadCalibration()
    }

    var isCalibrated: Bool { calibration != nil }

    func beginCalibCollection() {
        lock.lock()
        calibSamples.removeAll()
        isCalibrating = true
        lock.unlock()
    }

    func endCalibCollection() -> Double? {
        lock.lock()
        isCalibrating = false
        let values = calibSamples
        calibSamples.removeAll()
        lock.unlock()
        guard !values.isEmpty else { return nil }
        return median(values)
    }

    func storeCalibration(center: Double, top: Double, bottom: Double) {
        let cal = GazeCalibration(center: center, top: top, bottom: bottom, savedAt: Date())
        calibration = cal
        if let data = try? JSONEncoder().encode(cal) {
            UserDefaults.standard.set(data, forKey: defaultsCalibKey)
        }
        DiagnosticLog.shared.append(String(
            format: "맞춤 저장 · 가운데 %.2f · 위 %.2f · 아래 %.2f",
            center, top, bottom
        ))
    }

    func resetDwell() {
        lock.lock()
        resetDwellLocked()
        lock.unlock()
    }

    private func resetDwellLocked() {
        dwellStartedAt = nil
        dwellProgress = 0
        dwellZone = .center
    }

    /// Run on a serial queue. Pixel buffer must still be valid (same callback / retained).
    func ingest(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
        let request = VNDetectFaceLandmarksRequest()
        request.revision = VNDetectFaceLandmarksRequestRevision3
        // usesCPUOnly is deprecated; skip it so Xcode 16 / iOS 18.5 does not fail the build.
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
        do {
            try handler.perform([request])
        } catch {
            lock.lock()
            facePresent = false
            lastZone = .unknown
            lock.unlock()
            return
        }
        let faces = request.results ?? []
        guard let face = faces.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height })
        else {
            lock.lock()
            facePresent = false
            lastZone = .unknown
            lastScore = nil
            resetDwellLocked()
            lock.unlock()
            return
        }
        guard let score = verticalScore(from: face) else {
            lock.lock()
            facePresent = true
            lastZone = .unknown
            lastScore = nil
            lock.unlock()
            return
        }
        lock.lock()
        facePresent = true
        lastScore = score
        if isCalibrating {
            calibSamples.append(score)
            lastZone = .center
            lock.unlock()
            return
        }
        let zone = classify(score)
        lastZone = zone
        updateDwell(zone: zone)
        lock.unlock()
    }

    // MARK: - Score

    /// Larger ≈ looking down. Mix of pupil-in-eye and head pitch.
    private func verticalScore(from face: VNFaceObservation) -> Double? {
        var parts: [Double] = []
        if let landmarks = face.landmarks {
            if let s = eyeVertical(pupil: landmarks.leftPupil, eye: landmarks.leftEye) { parts.append(s) }
            if let s = eyeVertical(pupil: landmarks.rightPupil, eye: landmarks.rightEye) { parts.append(s) }
        }
        if #available(iOS 15.0, *), let pitch = face.pitch?.doubleValue {
            // Positive pitch ≈ chin down. Map roughly −0.5…0.5 rad → 0…1.
            let n = min(1, max(0, (pitch + 0.5) / 1.0))
            parts.append(n)
        }
        guard !parts.isEmpty else { return nil }
        return parts.reduce(0, +) / Double(parts.count)
    }

    /// 0 = pupil at top of eye (looking up), 1 = at bottom (looking down).
    /// Landmark points are in the face box, origin lower-left, y up.
    private func eyeVertical(pupil: VNFaceLandmarkRegion2D?, eye: VNFaceLandmarkRegion2D?) -> Double? {
        guard let pupil, let eye, pupil.pointCount > 0, eye.pointCount > 0 else { return nil }
        let pupilY = pupil.normalizedPoints[0].y
        let ys = eye.normalizedPoints.map(\.y)
        guard let minY = ys.min(), let maxY = ys.max(), maxY - minY > 0.001 else { return nil }
        return min(1, max(0, Double((maxY - pupilY) / (maxY - minY))))
    }

    private func classify(_ score: Double) -> GazeZone {
        if let cal = calibration {
            let upSpan = cal.top - cal.center
            let downSpan = cal.bottom - cal.center
            let frac = sensitivity.edgeFraction
            let towardUp: Double
            if abs(upSpan) > 0.01 {
                towardUp = (score - cal.center) / upSpan
            } else {
                towardUp = 0
            }
            let towardDown: Double
            if abs(downSpan) > 0.01 {
                towardDown = (score - cal.center) / downSpan
            } else {
                towardDown = 0
            }
            if towardUp >= frac && towardUp >= towardDown {
                return .up
            }
            if towardDown >= frac && towardDown >= towardUp {
                return .down
            }
            return .center
        }
        // Uncalibrated heuristic (score ~0.5 at rest).
        let extra: Double
        switch sensitivity {
        case .high: extra = 0.06
        case .medium: extra = 0.10
        case .low: extra = 0.14
        }
        if score < 0.5 - extra { return .up }
        if score > 0.5 + extra { return .down }
        return .center
    }

    private func updateDwell(zone: GazeZone) {
        let now = Date()
        if now < cooldownUntil {
            dwellProgress = 0
            dwellStartedAt = nil
            dwellZone = .center
            return
        }
        if zone == .up || zone == .down {
            if dwellZone != zone {
                dwellZone = zone
                dwellStartedAt = now
                dwellProgress = 0
            } else if let start = dwellStartedAt {
                let elapsed = now.timeIntervalSince(start)
                let need = sensitivity.dwellSeconds
                dwellProgress = min(1, elapsed / need)
                if elapsed >= need {
                    fire(zone == .up ? .up : .down, at: now)
                }
            }
        } else {
            dwellZone = .center
            dwellStartedAt = nil
            dwellProgress = 0
        }
    }

    private func fire(_ direction: SwipeDirection, at now: Date) {
        resetDwellLocked()
        cooldownUntil = now.addingTimeInterval(Self.cooldownSeconds)
        let output = swipeOutput
        let event = onEvent
        let flash = onFlash
        lock.unlock()
        output?.sendSwipe(direction)
        event?(direction)
        flash?(direction)
        lock.lock()
    }

    private func loadCalibration() -> GazeCalibration? {
        guard let data = UserDefaults.standard.data(forKey: defaultsCalibKey) else { return nil }
        return try? JSONDecoder().decode(GazeCalibration.self, from: data)
    }

    private func median(_ values: [Double]) -> Double {
        let s = values.sorted()
        let m = s.count / 2
        if s.count % 2 == 0 {
            return (s[m - 1] + s[m]) / 2
        }
        return s[m]
    }
}
