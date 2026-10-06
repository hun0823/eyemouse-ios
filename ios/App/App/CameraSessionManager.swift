import AVFoundation
import UIKit

protocol CameraSessionManagerDelegate: AnyObject {
    func cameraDidOutputFrame(_ manager: CameraSessionManager, pixelBuffer: CVPixelBuffer, sampleBuffer: CMSampleBuffer)
    func cameraDidInterrupt(_ manager: CameraSessionManager, reason: String, rawValue: Int?)
    func cameraDidEndInterruption(_ manager: CameraSessionManager)
    func cameraRuntimeError(_ manager: CameraSessionManager, message: String)
}

/// Front-camera `AVCaptureSession` with iOS 16+ multitasking camera when the OS allows it.
final class CameraSessionManager: NSObject {
    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.zio.eyemouse.camera")
    private let output = AVCaptureVideoDataOutput()
    private var input: AVCaptureDeviceInput?
    private var observers: [NSObjectProtocol] = []

    private(set) var framesReceived: Int = 0
    private(set) var lastFrameAt: Date?
    private(set) var fps: Double = 0
    private var fpsWindowStart = Date()
    private var fpsWindowCount = 0
    private var framesAtBackground: Int = 0

    private(set) var multitaskingSupported = false
    private(set) var multitaskingEnabled = false
    private(set) var isRunning = false
    private(set) var lastInterruption: String?

    weak var delegate: CameraSessionManagerDelegate?

    var secondsSinceLastFrame: TimeInterval? {
        guard let lastFrameAt else { return nil }
        return Date().timeIntervalSince(lastFrameAt)
    }

    var framesWhileBackgrounded: Int {
        max(0, framesReceived - framesAtBackground)
    }

    func markBackground() {
        framesAtBackground = framesReceived
    }

    func makePreviewLayer() -> AVCaptureVideoPreviewLayer {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        return layer
    }

    func start(completion: @escaping (Error?) -> Void) {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            if !granted {
                DispatchQueue.main.async {
                    completion(NSError(
                        domain: "EyeMouse",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "설정에서 아이마우스 카메라를 켜 주세요."]
                    ))
                }
                return
            }
            self.sessionQueue.async {
                do {
                    try self.configureIfNeeded()
                    self.enableMultitaskingIfPossible()
                    if !self.session.isRunning {
                        self.session.startRunning()
                    }
                    self.isRunning = self.session.isRunning
                    DispatchQueue.main.async { completion(nil) }
                } catch {
                    DispatchQueue.main.async { completion(error) }
                }
            }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning {
                self.session.stopRunning()
            }
            self.isRunning = false
        }
    }

    func resumeIfNeeded() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.enableMultitaskingIfPossible()
            if !self.session.isRunning {
                self.session.startRunning()
            }
            self.isRunning = self.session.isRunning
        }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    private func configureIfNeeded() throws {
        if input != nil { return }

        session.beginConfiguration()
        session.sessionPreset = .vga640x480
        session.automaticallyConfiguresApplicationAudioSession = false

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            session.commitConfiguration()
            throw NSError(domain: "EyeMouse", code: 2, userInfo: [NSLocalizedDescriptionKey: "전면 카메라를 찾지 못했습니다."])
        }
        let deviceInput = try AVCaptureDeviceInput(device: device)
        if session.canAddInput(deviceInput) {
            session.addInput(deviceInput)
            input = deviceInput
        } else {
            session.commitConfiguration()
            throw NSError(domain: "EyeMouse", code: 3, userInfo: [NSLocalizedDescriptionKey: "카메라 입력을 넣을 수 없습니다."])
        }

        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: sessionQueue)
        if session.canAddOutput(output) {
            session.addOutput(output)
        }

        if let connection = output.connection(with: .video) {
            if #available(iOS 17.0, *) {
                if connection.isVideoRotationAngleSupported(90) {
                    connection.videoRotationAngle = 90
                }
            } else if connection.isVideoOrientationSupported {
                connection.videoOrientation = .portrait
            }
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = true
            }
        }

        try lockFrameRate(device, fps: 15)
        enableMultitaskingIfPossible()
        session.commitConfiguration()
        enableMultitaskingIfPossible()
        installObservers()
    }

    private func enableMultitaskingIfPossible() {
        if #available(iOS 16.0, *) {
            multitaskingSupported = session.isMultitaskingCameraAccessSupported
            if multitaskingSupported {
                session.isMultitaskingCameraAccessEnabled = true
                multitaskingEnabled = session.isMultitaskingCameraAccessEnabled
            } else {
                multitaskingEnabled = false
            }
        } else {
            multitaskingSupported = false
            multitaskingEnabled = false
        }
    }

    private func lockFrameRate(_ device: AVCaptureDevice, fps: Int32) throws {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        let wanted = Float64(fps)
        let supported = device.activeFormat.videoSupportedFrameRateRanges.contains {
            $0.minFrameRate <= wanted && wanted <= $0.maxFrameRate
        }
        if supported {
            let duration = CMTime(value: 1, timescale: fps)
            device.activeVideoMinFrameDuration = duration
            device.activeVideoMaxFrameDuration = duration
        }

    private func installObservers() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .AVCaptureSessionWasInterrupted,
            object: session,
            queue: .main
        ) { [weak self] note in
            guard let self else { return }
            var raw: Int?
            var text = "카메라 중단"
            if let value = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int,
               let reason = AVCaptureSession.InterruptionReason(rawValue: value) {
                raw = value
                text = Self.describe(reason)
            }
            self.lastInterruption = text
            DiagnosticLog.shared.append("중단 · \(text)")
            self.delegate?.cameraDidInterrupt(self, reason: text, rawValue: raw)
        })
        observers.append(center.addObserver(
            forName: .AVCaptureSessionInterruptionEnded,
            object: session,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            DiagnosticLog.shared.append("중단 끝 · 카메라 재개 시도")
            self.delegate?.cameraDidEndInterruption(self)
            self.resumeIfNeeded()
        })
        observers.append(center.addObserver(
            forName: .AVCaptureSessionRuntimeError,
            object: session,
            queue: .main
        ) { [weak self] note in
            guard let self else { return }
            let err = note.userInfo?[AVCaptureSessionErrorKey] as? Error
            let message = err?.localizedDescription ?? "알 수 없는 오류"
            DiagnosticLog.shared.append("카메라 오류 · \(message)")
            self.delegate?.cameraRuntimeError(self, message: message)
        })
    }

    static func describe(_ reason: AVCaptureSession.InterruptionReason) -> String {
        switch reason {
        case .videoDeviceNotAvailableInBackground:
            return "백그라운드에서 카메라 사용 불가"
        case .audioDeviceInUseByAnotherClient:
            return "다른 앱이 마이크 사용 중"
        case .videoDeviceInUseByAnotherClient:
            return "다른 앱이 카메라 사용 중"
        case .videoDeviceNotAvailableWithMultipleForegroundApps:
            return "분할 화면에서 카메라 사용 불가"
        case .videoDeviceNotAvailableDueToSystemPressure:
            return "시스템 부하로 카메라 중단"
        default:
            if #available(iOS 16.0, *), reason == .videoDeviceNotAvailableDueToSystemPressure {
                return "시스템 부하로 카메라 중단"
            }
            return "카메라 중단 (코드 \(reason.rawValue))"
        }
    }
}

extension CameraSessionManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        framesReceived += 1
        lastFrameAt = Date()
        fpsWindowCount += 1
        let elapsed = Date().timeIntervalSince(fpsWindowStart)
        if elapsed >= 1 {
            fps = Double(fpsWindowCount) / elapsed
            fpsWindowCount = 0
            fpsWindowStart = Date()
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        delegate?.cameraDidOutputFrame(self, pixelBuffer: pixelBuffer, sampleBuffer: sampleBuffer)
    }
}
