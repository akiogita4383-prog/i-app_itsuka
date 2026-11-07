import Foundation
import Capacitor

/// 共有拡張が App Group に置いた内容を Web 側へ渡す。
/// Web 側はこれを ?title=&text=&url= と同じ形に直して既存の受け取りシートを開き、開いてから clear() で破棄する。
@objc(ShareInboxPlugin)
public class ShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareInboxPlugin"
    public let jsName = "ShareInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let dir = Inbox.folder else {
                call.resolve(["found": false])
                return
            }
            let file = dir.appendingPathComponent(Inbox.payloadName)
            // payload.json は拡張が最後に書く。無ければ未着か書き込み途中なので触らない
            guard let data = try? Data(contentsOf: file),
                  let p = try? JSONDecoder().decode(InboxPayload.self, from: data) else {
                call.resolve(["found": false])
                return
            }
            let images: [String] = p.images.prefix(Inbox.maxImages).compactMap { name in
                guard let d = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
                return "data:image/jpeg;base64," + d.base64EncodedString()
            }
            call.resolve([
                "found": true,
                "title": p.title,
                "text": p.text,
                "url": p.url,
                "images": images,
            ])
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        if let dir = Inbox.folder { try? FileManager.default.removeItem(at: dir) }
        call.resolve()
    }
}
