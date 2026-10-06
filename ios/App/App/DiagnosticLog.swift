import Foundation

/// Foreground timeline the tester screenshots after a background PiP run.
/// In-memory so it survives backgrounding while the process stays alive;
/// also mirrored to UserDefaults in case iOS kills and relaunches the app.
final class DiagnosticLog {
    static let shared = DiagnosticLog()

    struct Entry {
        let date: Date
        let message: String
    }

    private let lock = NSLock()
    private let defaultsKey = "eyemouse.pip.diagLog"
    private let maxEntries = 180
    private var items: [Entry] = []
    private let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    /// Fired on the main queue after a change.
    var onChange: (() -> Void)?

    private init() {
        if let saved = UserDefaults.standard.stringArray(forKey: defaultsKey) {
            items = saved.suffix(maxEntries).map { raw in
                Entry(date: Date(), message: raw)
            }
        }
    }

    func clear(reason: String? = nil) {
        lock.lock()
        items.removeAll()
        lock.unlock()
        persist()
        if let reason {
            append(reason)
        } else {
            notify()
        }
    }

    func append(_ message: String) {
        let entry = Entry(date: Date(), message: message)
        lock.lock()
        items.append(entry)
        if items.count > maxEntries {
            items.removeFirst(items.count - maxEntries)
        }
        let snapshot = items
        lock.unlock()
        persist(snapshot)
        notify()
        NSLog("[아이마우스 PiP] %@", message)
    }

    func snapshot() -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    func renderedText() -> String {
        snapshot().map { "\(stamp.string(from: $0.date))  \($0.message)" }.joined(separator: "\n")
    }

    private func persist(_ snapshot: [Entry]? = nil) {
        let rows = (snapshot ?? self.snapshot()).suffix(maxEntries).map {
            "\(stamp.string(from: $0.date))  \($0.message)"
        }
        UserDefaults.standard.set(Array(rows), forKey: defaultsKey)
    }

    private func notify() {
        if Thread.isMainThread {
            onChange?()
        } else {
            DispatchQueue.main.async { [weak self] in self?.onChange?() }
        }
    }
}
