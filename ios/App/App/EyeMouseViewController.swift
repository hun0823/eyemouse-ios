import UIKit
import Capacitor
import WebKit

/// WKWebView host for the bundled WebGazer wg12-ud page (up/down only).
/// Capacitor already grants iOS 15+ media-capture prompts; this subclass
/// only tunes the web view so the front camera can play inline.
final class EyeMouseViewController: CAPBridgeViewController {
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 14 / 255, green: 20 / 255, blue: 27 / 255, alpha: 1)
        applyWebViewTweaks()
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
    }
}
