import UIKit
import ImageIO
import UniformTypeIdentifiers

/// 共有シートの「いつか帳」。
/// 受け取った URL・テキスト・画像を App Group の共有コンテナに書き、URL スキームで本体を開く。
/// 編集 UI は持たず、カテゴリ選択などは本体の受け取りシートで行う。
final class ShareViewController: UIViewController {

    private let card = UIView()
    private let label = UILabel()
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.2)

        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 18
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        label.text = "いつか帳に送っています…"
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(label)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
            card.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            label.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
            label.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -22),
            label.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 22),
            label.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -22),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { await run() }
    }

    // MARK: - 受け取り

    @MainActor
    private func run() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var title = ""
        var text = ""
        var url = ""
        var jpegs: [Data] = []

        for item in items {
            if title.isEmpty, let t = item.attributedContentText?.string {
                title = t.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            for provider in item.attachments ?? [] {
                // 画像（写真App・スクリーンショットなど）
                if jpegs.count < Inbox.maxImages,
                   provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    if let obj = try? await load(provider, UTType.image.identifier),
                       let data = Self.jpeg(from: obj) {
                        jpegs.append(data)
                    }
                    continue
                }
                // URL（Safari など）
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let obj = try? await load(provider, UTType.url.identifier) {
                        let u = (obj as? URL) ?? (obj as? String).flatMap(URL.init(string:))
                        if let u, !u.isFileURL, url.isEmpty { url = u.absoluteString }
                    }
                    continue
                }
                // テキスト（選択した文字列、メモ App など）
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let obj = try? await load(provider, UTType.plainText.identifier) {
                        let s = (obj as? String) ?? (obj as? NSAttributedString)?.string ?? ""
                        if !s.isEmpty { text = text.isEmpty ? s : text + "\n" + s }
                    }
                }
            }
        }

        let saved = save(InboxPayload(title: title, text: text, url: url,
                                      images: [], created: Date().timeIntervalSince1970 * 1000),
                         jpegs: jpegs)
        guard saved else {
            await finish(message: "送れませんでした。もう一度お試しください")
            return
        }

        if openContainingApp(Inbox.openURL) {
            try? await Task.sleep(nanoseconds: 300_000_000)
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            // 本体を開けなかった場合も、次にいつか帳を開いたときに受け取りシートが出る
            await finish(message: "受け取りました。\nいつか帳を開くと追加できます")
        }
    }

    @MainActor
    private func finish(message: String) async {
        label.text = message
        try? await Task.sleep(nanoseconds: 1_400_000_000)
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func load(_ provider: NSItemProvider, _ type: String) async throws -> NSSecureCoding? {
        try await withCheckedThrowingContinuation { cont in
            provider.loadItem(forTypeIdentifier: type, options: nil) { obj, err in
                if let err { cont.resume(throwing: err) } else { cont.resume(returning: obj) }
            }
        }
    }

    // MARK: - 共有コンテナへ書き込み

    private func save(_ payload: InboxPayload, jpegs: [Data]) -> Bool {
        guard let dir = Inbox.folder else { return false }
        let fm = FileManager.default
        do {
            // 前回の未処理分は上書きする（受け取りシートは1件ずつ）
            if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) }
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            var p = payload
            for (i, data) in jpegs.enumerated() {
                let name = "img-\(i).jpg"
                try data.write(to: dir.appendingPathComponent(name), options: .atomic)
                p.images.append(name)
            }
            // payload.json は最後に書く。本体はこれがあるときだけ読む
            let json = try JSONEncoder().encode(p)
            try json.write(to: dir.appendingPathComponent(Inbox.payloadName), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    // MARK: - 画像の縮小（長辺1400px・JPEG 0.75。本体と同じ基準）

    private static func jpeg(from obj: NSSecureCoding) -> Data? {
        if let u = obj as? URL, let src = CGImageSourceCreateWithURL(u as CFURL, nil) {
            return thumbnail(src)
        }
        if let d = obj as? Data, let src = CGImageSourceCreateWithData(d as CFData, nil) {
            return thumbnail(src)
        }
        if let img = obj as? UIImage {
            let s = min(1, Inbox.maxEdge / max(img.size.width, img.size.height))
            let size = CGSize(width: (img.size.width * s).rounded(), height: (img.size.height * s).rounded())
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let out = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
                UIColor.white.setFill()
                ctx.fill(CGRect(origin: .zero, size: size))
                img.draw(in: CGRect(origin: .zero, size: size))
            }
            return out.jpegData(compressionQuality: Inbox.jpegQuality)
        }
        return nil
    }

    private static func thumbnail(_ src: CGImageSource) -> Data? {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Inbox.maxEdge,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg).jpegData(compressionQuality: Inbox.jpegQuality)
    }

    // MARK: - 本体を開く

    /// 拡張からは UIApplication.shared が使えないため、レスポンダチェーンをたどって開く。
    /// 失敗しても共有コンテナに残した内容は、本体の起動時・復帰時に読まれる。
    private func openContainingApp(_ url: URL) -> Bool {
        let sel = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication, app.responds(to: sel) {
                typealias OpenFn = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
                let fn = unsafeBitCast(app.method(for: sel), to: OpenFn.self)
                fn(app, sel, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = r.next
        }
        return false
    }
}
