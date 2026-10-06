import AVFoundation
import Foundation

/// Keeps an audio session alive so video-call PiP is allowed to start.
/// Plays an inaudible loop (not a recording) — `audio` + `voip` UIBackgroundModes
/// are the Info.plist side of the same experiment.
final class PipKeepAlive {
    private var player: AVAudioPlayer?

    func start() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .videoChat,
                options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothHFP]
            )
            try session.setActive(true, options: [])
        } catch {
            DiagnosticLog.shared.append("오디오 playAndRecord 실패 · \(error.localizedDescription)")
            do {
                try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
                try session.setActive(true)
                DiagnosticLog.shared.append("오디오 playback으로 대체")
            } catch {
                DiagnosticLog.shared.append("오디오 세션 실패 · \(error.localizedDescription)")
            }
        }

        if player == nil {
            do {
                player = try AVAudioPlayer(data: Self.inaudibleWav())
                player?.numberOfLoops = -1
                player?.volume = 0.02
                player?.prepareToPlay()
            } catch {
                DiagnosticLog.shared.append("무음 재생 실패 · \(error.localizedDescription)")
            }
        }
        if player?.isPlaying != true {
            player?.play()
        }
    }

    func stop() {
        player?.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// 1 s mono WAV, 8 kHz, amplitude 1 LSB — inaudible but not all-zero
    /// (some iOS versions pause truly silent buffers).
    private static func inaudibleWav() -> Data {
        let sampleRate = 8000
        let samples = sampleRate
        var data = Data()
        func u32(_ v: UInt32) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 4))
        }
        func u16(_ v: UInt16) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 2))
        }
        data.append(contentsOf: Array("RIFF".utf8))
        u32(UInt32(36 + samples * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        u32(16)
        u16(1)
        u16(1)
        u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2))
        u16(2)
        u16(16)
        data.append(contentsOf: Array("data".utf8))
        u32(UInt32(samples * 2))
        var pcm = Data(count: samples * 2)
        pcm.withUnsafeMutableBytes { raw in
            let ptr = raw.bindMemory(to: Int16.self)
            for i in 0..<samples {
                ptr[i] = (i % 200 == 0) ? 1 : 0
            }
        }
        data.append(pcm)
        return data
    }
}
