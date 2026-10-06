import Capacitor
import Foundation

@objc(PipTestPlugin)
public class PipTestPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PipTestPlugin"
    public let jsName = "PipTest"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let host = self?.bridge?.viewController else {
                call.reject("화면을 찾지 못했습니다.")
                return
            }
            PipTestLauncher.present(from: host, webView: self?.bridge?.webView)
            call.resolve()
        }
    }
}
