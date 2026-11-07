import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    /// index.html の --bg と同じ色。起動直後やスクロールの端で白が見えないようにする
    private static let pageBackground = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x17 / 255, green: 0x1B / 255, blue: 0x24 / 255, alpha: 1)
            : UIColor(red: 0xE9 / 255, green: 0xEC / 255, blue: 0xF1 / 255, alpha: 1)
    }

    override func capacitorDidLoad() {
        // アプリ内に置いた独自プラグイン（共有シートの受け取り口）
        bridge?.registerPluginInstance(ShareInboxPlugin())

        view.backgroundColor = Self.pageBackground
        webView?.isOpaque = false
        webView?.backgroundColor = Self.pageBackground
        webView?.scrollView.backgroundColor = Self.pageBackground
        // 長押しのリンクプレビューは Web ページらしさが出るので切る
        webView?.allowsLinkPreview = false
    }
}
