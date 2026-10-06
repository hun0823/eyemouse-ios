import UIKit
import Capacitor
import WebKit

/// WKWebView host for the bundled WebGazer wg12-ud page (up/down only).
/// Capacitor already grants iOS 15+ media-capture prompts; this subclass
/// only tunes the web view so the front camera can play inline.
final class EyeMouseViewController: CAPBridgeViewController {
    private var didAddPipHandler = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 14 / 255, green: 20 / 255, blue: 27 / 255, alpha: 1)
        applyWebViewTweaks()
        addPipTestEntry()
    }

    @objc private func openPipTest() {
        PipTestLauncher.present(from: self, webView: webView)
    }

    private func addPipTestEntry() {
        var cfg = UIButton.Configuration.filled()
        cfg.title = "PiP 시험"
        cfg.cornerStyle = .capsule
        cfg.baseBackgroundColor = UIColor(red: 142 / 255, green: 224 / 255, blue: 194 / 255, alpha: 0.94)
        cfg.baseForegroundColor = UIColor(red: 14 / 255, green: 20 / 255, blue: 27 / 255, alpha: 1)
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 12, bottom: 7, trailing: 12)
        let button = UIButton(configuration: cfg)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addTarget(self, action: #selector(openPipTest), for: .touchUpInside)
        button.layer.zPosition = 50
        view.addSubview(button)
        NSLayoutConstraint.activate([
            button.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
        ])
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        applyWebViewTweaks()
    }

    private func applyWebViewTweaks() {
        guard let webView else { return }
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 14 / 255, green: 20 / 255, blue: 27 / 255, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.configuration.allowsInlineMediaPlayback = true
        webView.configuration.mediaTypesRequiringUserActionForPlayback = []
        if #available(iOS 15.4, *) {
            webView.configuration.preferences.isElementFullscreenEnabled = true
        }
        if !didAddPipHandler {
            webView.configuration.userContentController.add(self, name: "eyemousePipTest")
            didAddPipHandler = true
        }
    }
}

extension EyeMouseViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "eyemousePipTest" {
            openPipTest()
        }
    }
}
