import Foundation
import CoreGraphics

/// 共有シートで受け取った内容を、App Group の共有コンテナ経由で本体へ渡すための取り決め。
/// 本体（App）と共有拡張（ShareExtension）の両方のターゲットに含める。
enum Inbox {
    /// Info.plist の ItsukaAppGroup（ビルド設定 APP_GROUP_ID から展開される）
    static var groupID: String {
        (Bundle.main.object(forInfoDictionaryKey: "ItsukaAppGroup") as? String) ?? ""
    }

    static var folder: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: groupID)?
            .appendingPathComponent("Inbox", isDirectory: true)
    }

    static let payloadName = "payload.json"
    static let maxImages = 8
    static let maxEdge: CGFloat = 1400
    static let jpegQuality: CGFloat = 0.75
    /// 本体を起動する URL スキーム（Info.plist の CFBundleURLTypes と合わせる）
    static let openURL = URL(string: "itsuka://share")!
}

/// 受け取った1件。images は Inbox フォルダ内の JPEG ファイル名。
struct InboxPayload: Codable {
    var title: String
    var text: String
    var url: String
    var images: [String]
    var created: Double
}
