import AVKit
import AVFoundation
import UIKit

enum EyeTheme {
    static let bg = UIColor(red: 14 / 255, green: 20 / 255, blue: 27 / 255, alpha: 1)
    static let card = UIColor(red: 26 / 255, green: 36 / 255, blue: 49 / 255, alpha: 1)
    static let ink = UIColor(red: 244 / 255, green: 247 / 255, blue: 251 / 255, alpha: 1)
    static let muted = UIColor(red: 183 / 255, green: 195 / 255, blue: 209 / 255, alpha: 1)
    static let accent = UIColor(red: 142 / 255, green: 224 / 255, blue: 194 / 255, alpha: 1)
    static let warn = UIColor(red: 255 / 255, green: 155 / 255, blue: 142 / 255, alpha: 1)
    static let charge = UIColor(red: 255 / 255, green: 213 / 255, blue: 106 / 255, alpha: 1)
}

struct PipHudSnapshot {
    var fps: Double = 0
    var frames: Int = 0
    var lastFrameAge: TimeInterval?
    var zone: GazeZone = .unknown
    var dwell: Double = 0
    var dwellZone: GazeZone = .center
    var flash: SwipeDirection?
    var upCount: Int = 0
    var downCount: Int = 0
    var cameraOn: Bool = false
    var pipOn: Bool = false
    var face: Bool = false
    var score: Double?
}

/// Compact dashboard drawn inside the PiP window (and mirrored on the test screen).
final class PipDashboardView: UIView {
    private let fpsLabel = UILabel()
    private let framesLabel = UILabel()
    private let lastLabel = UILabel()
    private let gazeLabel = UILabel()
    private let countsLabel = UILabel()
    private let topGlow = UIView()
    private let bottomGlow = UIView()
    private let topFill = UIView()
    private let bottomFill = UIView()
    private var flashWork: DispatchWorkItem?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = EyeTheme.bg
        layer.cornerRadius = 10
        clipsToBounds = true

        [topGlow, bottomGlow].forEach {
            $0.backgroundColor = UIColor.white.withAlphaComponent(0.08)
            $0.translatesAutoresizingMaskIntoConstraints = false
            addSubview($0)
        }
        topFill.backgroundColor = EyeTheme.charge
        bottomFill.backgroundColor = EyeTheme.charge
        topFill.translatesAutoresizingMaskIntoConstraints = false
        bottomFill.translatesAutoresizingMaskIntoConstraints = false
        topGlow.addSubview(topFill)
        bottomGlow.addSubview(bottomFill)

        let stack = UIStackView(arrangedSubviews: [fpsLabel, framesLabel, lastLabel, gazeLabel, countsLabel])
        stack.axis = .vertical
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        for label in [fpsLabel, framesLabel, lastLabel, gazeLabel, countsLabel] {
            label.textColor = EyeTheme.ink
            label.font = .systemFont(ofSize: 12, weight: .semibold)
            label.adjustsFontSizeToFitWidth = true
            label.minimumScaleFactor = 0.7
            label.numberOfLines = 1
        }
        lastLabel.font = .systemFont(ofSize: 13, weight: .heavy)
        gazeLabel.font = .systemFont(ofSize: 16, weight: .heavy)

        NSLayoutConstraint.activate([
            topGlow.leadingAnchor.constraint(equalTo: leadingAnchor),
            topGlow.trailingAnchor.constraint(equalTo: trailingAnchor),
            topGlow.topAnchor.constraint(equalTo: topAnchor),
            topGlow.heightAnchor.constraint(equalToConstant: 8),
            bottomGlow.leadingAnchor.constraint(equalTo: leadingAnchor),
            bottomGlow.trailingAnchor.constraint(equalTo: trailingAnchor),
            bottomGlow.bottomAnchor.constraint(equalTo: bottomAnchor),
            bottomGlow.heightAnchor.constraint(equalToConstant: 8),
            topFill.leadingAnchor.constraint(equalTo: topGlow.leadingAnchor),
            topFill.topAnchor.constraint(equalTo: topGlow.topAnchor),
            topFill.bottomAnchor.constraint(equalTo: topGlow.bottomAnchor),
            bottomFill.leadingAnchor.constraint(equalTo: bottomGlow.leadingAnchor),
            bottomFill.topAnchor.constraint(equalTo: bottomGlow.topAnchor),
            bottomFill.bottomAnchor.constraint(equalTo: bottomGlow.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: topGlow.bottomAnchor, constant: 6),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomGlow.topAnchor, constant: -4),
        ])
        topFillWidth = topFill.widthAnchor.constraint(equalTo: topGlow.widthAnchor, multiplier: 0.01)
        bottomFillWidth = bottomFill.widthAnchor.constraint(equalTo: bottomGlow.widthAnchor, multiplier: 0.01)
        topFillWidth.isActive = true
        bottomFillWidth.isActive = true
        apply(PipHudSnapshot())
    }

    required init?(coder: NSCoder) { nil }

    private var topFillWidth: NSLayoutConstraint!
    private var bottomFillWidth: NSLayoutConstraint!

    func apply(_ s: PipHudSnapshot) {
        fpsLabel.text = String(format: "FPS %.1f", s.fps)
        framesLabel.text = "프레임 \(s.frames)"
        if let age = s.lastFrameAge {
            lastLabel.text = String(format: "마지막 %.1f초 전", age)
            lastLabel.textColor = age > 1.2 ? EyeTheme.warn : EyeTheme.accent
        } else {
            lastLabel.text = "마지막 — 프레임 없음"
            lastLabel.textColor = EyeTheme.warn
        }
        let face = s.face ? "" : " · 얼굴 없음"
        gazeLabel.text = "시선 \(s.zone.korean)\(face)"
        countsLabel.text = "위 \(s.upCount)  아래 \(s.downCount)"

        let upAmount = (s.dwellZone == .up) ? CGFloat(max(0.02, s.dwell)) : 0.02
        let downAmount = (s.dwellZone == .down) ? CGFloat(max(0.02, s.dwell)) : 0.02
        replaceMultiplier(on: topGlow, fill: topFill, constraint: &topFillWidth, multiplier: upAmount)
        replaceMultiplier(on: bottomGlow, fill: bottomFill, constraint: &bottomFillWidth, multiplier: downAmount)
        topGlow.alpha = s.dwellZone == .up || s.flash == .up ? 1 : 0.35
        bottomGlow.alpha = s.dwellZone == .down || s.flash == .down ? 1 : 0.35

        if let flash = s.flash {
            pulse(flash)
        }
    }

    private func replaceMultiplier(on bar: UIView, fill: UIView, constraint: inout NSLayoutConstraint, multiplier: CGFloat) {
        constraint.isActive = false
        constraint = fill.widthAnchor.constraint(equalTo: bar.widthAnchor, multiplier: min(1, max(0.01, multiplier)))
        constraint.isActive = true
    }

    private func pulse(_ direction: SwipeDirection) {
        let bar = direction == .up ? topGlow : bottomGlow
        let fill = direction == .up ? topFill : bottomFill
        fill.backgroundColor = .white
        bar.backgroundColor = EyeTheme.accent
        flashWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            fill.backgroundColor = EyeTheme.charge
            bar.backgroundColor = UIColor.white.withAlphaComponent(0.08)
            self?.flashWork = nil
        }
        flashWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: work)
    }
}

/// Video-call PiP content (iOS 15+). Tiny camera layer + dashboard.
final class PipDashboardViewController: AVPictureInPictureVideoCallViewController {
    let dashboard = PipDashboardView()
    let previewHost = UIView()
    private(set) var previewLayer: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = CGSize(width: 180, height: 320)
        view.backgroundColor = EyeTheme.bg
        previewHost.translatesAutoresizingMaskIntoConstraints = false
        previewHost.backgroundColor = UIColor.black
        previewHost.layer.cornerRadius = 8
        previewHost.clipsToBounds = true
        dashboard.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(previewHost)
        view.addSubview(dashboard)
        NSLayoutConstraint.activate([
            previewHost.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            previewHost.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            previewHost.topAnchor.constraint(equalTo: view.topAnchor, constant: 6),
            previewHost.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.32),
            dashboard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            dashboard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            dashboard.topAnchor.constraint(equalTo: previewHost.bottomAnchor, constant: 6),
            dashboard.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -6),
        ])
    }

    func attachPreview(_ layer: AVCaptureVideoPreviewLayer) {
        previewLayer?.removeFromSuperlayer()
        previewLayer = layer
        layer.videoGravity = .resizeAspectFill
        previewHost.layer.addSublayer(layer)
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = previewHost.bounds
    }

    func apply(_ snapshot: PipHudSnapshot) {
        dashboard.apply(snapshot)
    }
}
