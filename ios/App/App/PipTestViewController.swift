import AVKit
import AVFoundation
import UIKit
import WebKit

enum PipTestLauncher {
    static let stopWebCameraJS = """
    (function(){
      try { if (window.webgazer && webgazer.pause) webgazer.pause(); } catch(e) {}
      try { if (window.webgazer && webgazer.end) webgazer.end(); } catch(e) {}
      try {
        document.querySelectorAll('video').forEach(function(v){
          var s = v.srcObject; if (!s) return;
          s.getTracks().forEach(function(t){ try { t.stop(); } catch(e) {} });
          v.srcObject = null;
        });
      } catch(e) {}
    })();
    """

    static func present(from host: UIViewController, webView: WKWebView?) {
        if host.presentedViewController is PipTestViewController { return }
        let show = {
            let vc = PipTestViewController()
            vc.modalPresentationStyle = .fullScreen
            vc.onDismiss = { [weak webView] in
                webView?.reload()
            }
            host.present(vc, animated: true)
        }
        if let webView {
            webView.evaluateJavaScript(stopWebCameraJS) { _, _ in
                DispatchQueue.main.async(execute: show)
            }
        } else {
            show()
        }
    }
}

final class PipTestViewController: UIViewController {
    var onDismiss: (() -> Void)?

    private let camera = CameraSessionManager()
    private let classifier = GazeClassifier()
    private let swipeOut = LoggingSwipeOutput()
    private let keepAlive = PipKeepAlive()
    private let pipContent = PipDashboardViewController()
    private var pipController: AVPictureInPictureController?
    private var sourcePreview: AVCaptureVideoPreviewLayer?
    private var hudTimer: Timer?
    private var flashUntil: Date?
    private var lastFlash: SwipeDirection?
    private var isInBackground = false
    private var didStartCamera = false
    private var observers: [NSObjectProtocol] = []

    private let sourceView = UIView()
    private let inlineHud = PipDashboardView()
    private let logView = UITextView()
    private let chipMulti = PipTestViewController.chip(title: "멀티태스킹 카메라")
    private let chipPipSupport = PipTestViewController.chip(title: "PiP 지원")
    private let chipPipPossible = PipTestViewController.chip(title: "PiP 가능")
    private let chipPipActive = PipTestViewController.chip(title: "PiP")
    private let pipButton = PipTestViewController.actionButton(title: "PiP 시작", filled: true)
    private let calibButton = PipTestViewController.actionButton(title: "맞춤", filled: false)
    private let sensitivity = UISegmentedControl(items: ["상", "중", "하"])
    private let statusLabel = UILabel()

    private let calibOverlay = UIView()
    private let calibTitle = UILabel()
    private let calibCount = UILabel()
    private let calibDot = UIView()
    private var calibDotCenterY: NSLayoutConstraint?
    private var calibRunning = false

    private var didTeardown = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = EyeTheme.bg
        camera.delegate = self
        classifier.swipeOutput = swipeOut
        classifier.onFlash = { [weak self] dir in
            DispatchQueue.main.async {
                self?.lastFlash = dir
                self?.flashUntil = Date().addingTimeInterval(0.45)
            }
        }
        swipeOut.onChange = { [weak self] in self?.refreshLog() }
        DiagnosticLog.shared.onChange = { [weak self] in self?.refreshLog() }
        DiagnosticLog.shared.append("PiP 시험 화면")
        buildUI()
        observeAppLife()
        refreshLog()
        applySensitivityIndex()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !didStartCamera {
            didStartCamera = true
            startCameraAndPip()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        sourcePreview?.frame = sourceView.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed {
            teardown()
        }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        DiagnosticLog.shared.onChange = nil
    }

    private func teardown() {
        guard !didTeardown else { return }
        didTeardown = true
        hudTimer?.invalidate()
        hudTimer = nil
        pipController?.stopPictureInPicture()
        pipController?.contentSource = nil
        pipController = nil
        camera.stop()
        keepAlive.stop()
        DiagnosticLog.shared.append("시험 화면 닫음")
        onDismiss?()
    }

    // MARK: - UI

    private func buildUI() {
        let close = UIButton(type: .system)
        close.setTitle("닫기", for: .normal)
        close.setTitleColor(EyeTheme.accent, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        let title = UILabel()
        title.text = "PiP 카메라 시험"
        title.textColor = EyeTheme.ink
        title.font = .systemFont(ofSize: 20, weight: .heavy)

        let hint = UILabel()
        hint.text = "다른 앱을 연 뒤 작은 창에서 카메라가 살아 있는지 봅니다. 다른 앱을 조작하지 않습니다. 초록 카메라 점이 켜질 수 있습니다."
        hint.textColor = EyeTheme.muted
        hint.font = .systemFont(ofSize: 13, weight: .regular)
        hint.numberOfLines = 0

        sourceView.backgroundColor = .black
        sourceView.layer.cornerRadius = 12
        sourceView.clipsToBounds = true
        sourceView.translatesAutoresizingMaskIntoConstraints = false

        inlineHud.translatesAutoresizingMaskIntoConstraints = false
        sourceView.addSubview(inlineHud)

        statusLabel.textColor = EyeTheme.muted
        statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
        statusLabel.numberOfLines = 2
        statusLabel.text = "카메라를 켜는 중…"

        let chips = UIStackView(arrangedSubviews: [chipMulti, chipPipSupport, chipPipPossible, chipPipActive])
        chips.axis = .vertical
        chips.spacing = 4

        pipButton.addTarget(self, action: #selector(pipTapped), for: .touchUpInside)
        calibButton.addTarget(self, action: #selector(calibTapped), for: .touchUpInside)

        sensitivity.selectedSegmentIndex = {
            switch classifier.sensitivity {
            case .high: return 0
            case .medium: return 1
            case .low: return 2
            }
        }()
        sensitivity.selectedSegmentTintColor = EyeTheme.accent
        sensitivity.setTitleTextAttributes([.foregroundColor: EyeTheme.bg], for: .selected)
        sensitivity.setTitleTextAttributes([.foregroundColor: EyeTheme.ink], for: .normal)
        sensitivity.addTarget(self, action: #selector(sensitivityChanged), for: .valueChanged)

        let sensCaption = UILabel()
        sensCaption.text = "민감도  상=1.0초  중=1.5초  하=2.0초"
        sensCaption.textColor = EyeTheme.muted
        sensCaption.font = .systemFont(ofSize: 11, weight: .regular)

        let actions = UIStackView(arrangedSubviews: [pipButton, calibButton])
        actions.axis = .horizontal
        actions.spacing = 8
        actions.distribution = .fillEqually

        let logTitle = UILabel()
        logTitle.text = "기록 · 돌아와서 이 화면을 찍어 주세요"
        logTitle.textColor = EyeTheme.ink
        logTitle.font = .systemFont(ofSize: 14, weight: .bold)

        logView.backgroundColor = UIColor(white: 0, alpha: 0.35)
        logView.textColor = EyeTheme.ink
        logView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        logView.isEditable = false
        logView.isSelectable = true
        logView.layer.cornerRadius = 10
        logView.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)

        let top = UIStackView(arrangedSubviews: [close, title])
        top.axis = .horizontal
        top.alignment = .center
        top.distribution = .equalSpacing

        let stack = UIStackView(arrangedSubviews: [
            top, hint, sourceView, statusLabel, chips, actions, sensitivity, sensCaption, logTitle, logView
        ])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: guide.topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -8),
            sourceView.heightAnchor.constraint(equalToConstant: 168),
            logView.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
            inlineHud.leadingAnchor.constraint(equalTo: sourceView.leadingAnchor, constant: 6),
            inlineHud.trailingAnchor.constraint(equalTo: sourceView.trailingAnchor, constant: -6),
            inlineHud.bottomAnchor.constraint(equalTo: sourceView.bottomAnchor, constant: -6),
            inlineHud.heightAnchor.constraint(equalToConstant: 108),
        ])

        buildCalibOverlay()
    }

    private func buildCalibOverlay() {
        calibOverlay.backgroundColor = UIColor(white: 0, alpha: 0.82)
        calibOverlay.isHidden = true
        calibOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(calibOverlay)

        calibDot.backgroundColor = EyeTheme.accent
        calibDot.layer.cornerRadius = 18
        calibDot.translatesAutoresizingMaskIntoConstraints = false

        calibTitle.textColor = EyeTheme.ink
        calibTitle.font = .systemFont(ofSize: 22, weight: .heavy)
        calibTitle.textAlignment = .center
        calibTitle.numberOfLines = 0
        calibTitle.translatesAutoresizingMaskIntoConstraints = false

        calibCount.textColor = EyeTheme.charge
        calibCount.font = .systemFont(ofSize: 64, weight: .heavy)
        calibCount.textAlignment = .center
        calibCount.translatesAutoresizingMaskIntoConstraints = false

        calibOverlay.addSubview(calibDot)
        calibOverlay.addSubview(calibTitle)
        calibOverlay.addSubview(calibCount)

        let y = calibDot.centerYAnchor.constraint(equalTo: calibOverlay.centerYAnchor)
        calibDotCenterY = y
        NSLayoutConstraint.activate([
            calibOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            calibOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            calibOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            calibOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            calibDot.centerXAnchor.constraint(equalTo: calibOverlay.centerXAnchor),
            y,
            calibDot.widthAnchor.constraint(equalToConstant: 36),
            calibDot.heightAnchor.constraint(equalToConstant: 36),
            calibTitle.leadingAnchor.constraint(equalTo: calibOverlay.leadingAnchor, constant: 20),
            calibTitle.trailingAnchor.constraint(equalTo: calibOverlay.trailingAnchor, constant: -20),
            calibTitle.centerYAnchor.constraint(equalTo: calibOverlay.centerYAnchor, constant: 48),
            calibCount.centerXAnchor.constraint(equalTo: calibOverlay.centerXAnchor),
            calibCount.bottomAnchor.constraint(equalTo: calibTitle.topAnchor, constant: -12),
        ])
    }

    // MARK: - Camera / PiP

    private func startCameraAndPip() {
        keepAlive.start()
        DiagnosticLog.shared.append("오디오 세션 · playAndRecord/videoChat")
        camera.start { [weak self] error in
            guard let self else { return }
            if let error {
                self.statusLabel.text = error.localizedDescription
                DiagnosticLog.shared.append("카메라 실패 · \(error.localizedDescription)")
                return
            }
            let mt = self.camera.multitaskingSupported
            let en = self.camera.multitaskingEnabled
            DiagnosticLog.shared.append(
                "카메라 시작 · 멀티태스킹 지원=\(mt ? "예" : "아니오") · 켜짐=\(en ? "예" : "아니오")"
            )
            if #available(iOS 16.0, *), !mt {
                DiagnosticLog.shared.append("주의: 무료 Apple ID는 카메라 백그라운드 entitlement가 없습니다. voip 모드로 우회를 시도합니다.")
            }
            self.attachPreviews()
            self.setupPip()
            self.startHudTimer()
            self.updateChips()
            self.statusLabel.text = mt
                ? "카메라 켜짐 · 멀티태스킹 지원됨"
                : "카메라 켜짐 · 멀티태스킹 미지원(백그라운드에서 끊길 수 있음)"
        }
    }

    private func attachPreviews() {
        let inline = camera.makePreviewLayer()
        sourcePreview = inline
        inline.frame = sourceView.bounds
        sourceView.layer.insertSublayer(inline, at: 0)
        let pipPreview = camera.makePreviewLayer()
        pipContent.attachPreview(pipPreview)
    }

    private func setupPip() {
        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            DiagnosticLog.shared.append("PiP 미지원 기기")
            pipButton.isEnabled = false
            pipButton.setTitle("PiP 없음", for: .normal)
            return
        }
        // Video-call PiP (iOS 15+): custom dashboard in the floating window,
        // auto-start when the app backgrounds if the source view is visible.
        _ = pipContent.view
        let source = AVPictureInPictureController.ContentSource(
            activeVideoCallSourceView: sourceView,
            contentViewController: pipContent
        )
        let pip = AVPictureInPictureController(contentSource: source)
        pip.delegate = self
        pip.canStartPictureInPictureAutomaticallyFromInline = true
        pipController = pip
        DiagnosticLog.shared.append(
            "PiP 준비 · 지원=예 · 가능=\(pip.isPictureInPicturePossible ? "예" : "아니오") · 자동시작=켜짐"
        )
        updateChips()
    }

    private func startHudTimer() {
        hudTimer?.invalidate()
        hudTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.tickHud()
        }
        RunLoop.main.add(hudTimer!, forMode: .common)
    }

    private func tickHud() {
        var snap = PipHudSnapshot()
        snap.fps = camera.fps
        snap.frames = camera.framesReceived
        snap.lastFrameAge = camera.secondsSinceLastFrame
        let gaze = classifier.liveSnapshot()
        snap.zone = gaze.lastZone
        snap.dwell = gaze.dwellProgress
        snap.dwellZone = gaze.dwellZone
        snap.upCount = swipeOut.upCount
        snap.downCount = swipeOut.downCount
        snap.cameraOn = camera.isRunning
        snap.pipOn = pipController?.isPictureInPictureActive ?? false
        snap.face = gaze.facePresent
        snap.score = gaze.lastScore
        if let until = flashUntil, until > Date() {
            snap.flash = lastFlash
        } else {
            lastFlash = nil
        }
        inlineHud.apply(snap)
        pipContent.apply(snap)
        updateChips()
        if isInBackground, let age = snap.lastFrameAge, Int(age * 5) % 25 == 0 {
            // periodic-ish; real trail is in the log on background/foreground edges
        }
    }

    private func updateChips() {
        setChip(chipMulti, on: camera.multitaskingSupported, onText: "멀티태스킹 카메라 예", offText: "멀티태스킹 카메라 아니오")
        let supported = AVPictureInPictureController.isPictureInPictureSupported()
        setChip(chipPipSupport, on: supported, onText: "PiP 지원 예", offText: "PiP 지원 아니오")
        let possible = pipController?.isPictureInPicturePossible ?? false
        setChip(chipPipPossible, on: possible, onText: "PiP 가능 예", offText: "PiP 가능 아니오")
        let active = pipController?.isPictureInPictureActive ?? false
        setChip(chipPipActive, on: active, onText: "PiP 켜짐", offText: "PiP 꺼짐")
    }

    private func setChip(_ label: UILabel, on: Bool, onText: String, offText: String) {
        label.text = on ? "  \(onText)  " : "  \(offText)  "
        label.backgroundColor = on ? EyeTheme.accent.withAlphaComponent(0.25) : EyeTheme.warn.withAlphaComponent(0.18)
        label.textColor = on ? EyeTheme.accent : EyeTheme.warn
    }

    // MARK: - Actions

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    @objc private func pipTapped() {
        guard let pip = pipController else {
            DiagnosticLog.shared.append("PiP 컨트롤러 없음")
            return
        }
        DiagnosticLog.shared.append(
            "PiP 버튼 · 가능=\(pip.isPictureInPicturePossible ? "예" : "아니오") · 활성=\(pip.isPictureInPictureActive ? "예" : "아니오")"
        )
        if pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
            pipButton.setTitle("PiP 시작", for: .normal)
        } else {
            pip.startPictureInPicture()
        }
    }

    @objc private func calibTapped() {
        guard !calibRunning else { return }
        runCalibration()
    }

    @objc private func sensitivityChanged() {
        applySensitivityIndex()
    }

    private func applySensitivityIndex() {
        let s: GazeSensitivity
        switch sensitivity.selectedSegmentIndex {
        case 0: s = .high
        case 2: s = .low
        default: s = .medium
        }
        classifier.sensitivity = s
        DiagnosticLog.shared.append("민감도 \(s.korean) · 머무름 \(s.dwellSeconds)초")
    }

    // MARK: - Calibration

    private func runCalibration() {
        calibRunning = true
        calibOverlay.isHidden = false
        DiagnosticLog.shared.append("맞춤 시작 · 가운데 → 위 → 아래 (각 2초)")
        let steps: [(String, CGFloat)] = [
            ("가운데를 보세요", 0),
            ("화면 위쪽을 보세요", -0.38),
            ("화면 아래쪽을 보세요", 0.38),
        ]
        collect(steps: steps, index: 0, collected: [])
    }

    private func collect(steps: [(String, CGFloat)], index: Int, collected: [Double]) {
        if index >= steps.count {
            calibOverlay.isHidden = true
            calibRunning = false
            guard collected.count == 3 else {
                DiagnosticLog.shared.append("맞춤 실패 · 얼굴이 안 잡혔습니다")
                statusLabel.text = "맞춤 실패 · 얼굴을 비추고 다시 눌러 주세요"
                return
            }
            classifier.storeCalibration(center: collected[0], top: collected[1], bottom: collected[2])
            statusLabel.text = String(format: "맞춤 끝 · 가운데 %.2f  위 %.2f  아래 %.2f", collected[0], collected[1], collected[2])
            return
        }
        let step = steps[index]
        calibTitle.text = step.0
        calibDotCenterY?.constant = step.1 * view.bounds.height
        view.layoutIfNeeded()
        classifier.resetDwell()
        tickCalibCount(2)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.classifier.beginCalibCollection()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.05) { [weak self] in
            guard let self else { return }
            let value = self.classifier.endCalibCollection()
            var next = collected
            if let value {
                next.append(value)
                DiagnosticLog.shared.append(String(format: "맞춤 %d/3 \(step.0) · %.2f", index + 1, value))
            } else {
                DiagnosticLog.shared.append(String(format: "맞춤 %d/3 샘플 없음", index + 1))
            }
            self.collect(steps: steps, index: index + 1, collected: next)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.tickCalibCount(1) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.7) { [weak self] in self?.tickCalibCount(0) }
    }

    private func tickCalibCount(_ n: Int) {
        calibCount.text = n == 0 ? "✓" : "\(n)"
    }

    // MARK: - Log / life cycle

    private func refreshLog() {
        logView.text = DiagnosticLog.shared.renderedText()
        if logView.text.count > 0 {
            let end = NSRange(location: max(0, (logView.text as NSString).length - 1), length: 1)
            logView.scrollRangeToVisible(end)
        }
    }

    private func observeAppLife() {
        let c = NotificationCenter.default
        observers.append(c.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.handleBackground()
        })
        observers.append(c.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            DiagnosticLog.shared.append("비활성(다른 앱·제어센터 등)")
            self?.updateChips()
        })
        observers.append(c.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.handleForeground()
        })
        observers.append(c.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.camera.resumeIfNeeded()
            self?.keepAlive.start()
            self?.updateChips()
        })
    }

    private func handleBackground() {
        isInBackground = true
        camera.markBackground()
        let possible = pipController?.isPictureInPicturePossible ?? false
        let active = pipController?.isPictureInPictureActive ?? false
        DiagnosticLog.shared.append(
            "백그라운드 진입 · 프레임 \(camera.framesReceived) · PiP가능=\(possible ? "예" : "아니오") · PiP=\(active ? "켜짐" : "꺼짐")"
        )
        if let pip = pipController, !pip.isPictureInPictureActive {
            if pip.isPictureInPicturePossible {
                pip.startPictureInPicture()
                DiagnosticLog.shared.append("백그라운드에서 PiP 시작 시도")
            } else {
                DiagnosticLog.shared.append("백그라운드 · PiP가 아직 불가 — 자동시작이 켜져 있으면 시스템이 띄울 수 있음")
            }
        }
    }

    private func handleForeground() {
        let extra = camera.framesWhileBackgrounded
        let age = camera.secondsSinceLastFrame.map { String(format: "%.1f초 전", $0) } ?? "없음"
        DiagnosticLog.shared.append("포그라운드 복귀 · 백그라운드 동안 프레임 +\(extra) · 마지막 \(age)")
        isInBackground = false
        camera.resumeIfNeeded()
        keepAlive.start()
        updateChips()
        if extra == 0 {
            statusLabel.text = "복귀 · 백그라운드에서 프레임이 없었습니다"
        } else {
            statusLabel.text = "복귀 · 백그라운드 프레임 +\(extra)"
        }
    }

    // MARK: - Factories

    private static func actionButton(title: String, filled: Bool) -> UIButton {
        var cfg = UIButton.Configuration.filled()
        cfg.title = title
        cfg.cornerStyle = .medium
        cfg.baseForegroundColor = filled ? EyeTheme.bg : EyeTheme.accent
        cfg.baseBackgroundColor = filled ? EyeTheme.accent : EyeTheme.card
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 8, bottom: 12, trailing: 8)
        let b = UIButton(configuration: cfg)
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
        return b
    }

    private static func chip(title: String) -> UILabel {
        let l = UILabel()
        l.text = "  \(title)  "
        l.font = .systemFont(ofSize: 12, weight: .semibold)
        l.textColor = EyeTheme.muted
        l.backgroundColor = EyeTheme.card
        l.layer.cornerRadius = 8
        l.clipsToBounds = true
        return l
    }
}

extension PipTestViewController: CameraSessionManagerDelegate {
    func cameraDidOutputFrame(_ manager: CameraSessionManager, pixelBuffer: CVPixelBuffer, sampleBuffer: CMSampleBuffer) {
        // Same capture queue: buffer is valid here. Mirrored portrait → .upMirrored.
        classifier.ingest(pixelBuffer: pixelBuffer, orientation: .upMirrored)
        if isInBackground, manager.framesWhileBackgrounded == 1 {
            DispatchQueue.main.async {
                DiagnosticLog.shared.append("백그라운드에서 첫 프레임 도착")
            }
        }
        if isInBackground, manager.framesWhileBackgrounded > 0, manager.framesWhileBackgrounded % 75 == 0 {
            let n = manager.framesWhileBackgrounded
            let fps = manager.fps
            DispatchQueue.main.async {
                DiagnosticLog.shared.append(String(format: "백그라운드 프레임 +%d · FPS %.1f", n, fps))
            }
        }
    }

    func cameraDidInterrupt(_ manager: CameraSessionManager, reason: String, rawValue: Int?) {
        statusLabel.text = "중단 · \(reason)"
        updateChips()
    }

    func cameraDidEndInterruption(_ manager: CameraSessionManager) {
        statusLabel.text = "카메라 중단 끝"
        updateChips()
    }

    func cameraRuntimeError(_ manager: CameraSessionManager, message: String) {
        statusLabel.text = "오류 · \(message)"
    }
}

extension PipTestViewController: AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerWillStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        DiagnosticLog.shared.append("PiP 시작 직전")
    }

    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        DiagnosticLog.shared.append("PiP 시작됨")
        pipButton.setTitle("PiP 끄기", for: .normal)
        updateChips()
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        DiagnosticLog.shared.append("PiP 시작 실패 · \(error.localizedDescription)")
        statusLabel.text = "PiP 실패 · \(error.localizedDescription)"
        updateChips()
    }

    func pictureInPictureControllerWillStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        DiagnosticLog.shared.append("PiP 종료 직전")
    }

    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        DiagnosticLog.shared.append("PiP 종료됨")
        pipButton.setTitle("PiP 시작", for: .normal)
        updateChips()
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(true)
    }
}
