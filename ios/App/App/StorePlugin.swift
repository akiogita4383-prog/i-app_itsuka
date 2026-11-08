import Foundation
import StoreKit
import Capacitor

/// いつか帳プラス（自動更新サブスクリプション）。StoreKit 2。
/// 購入結果は署名付き（jws）のまま Web 側へ返し、Web 側が Supabase の Edge Function で検証して会員状態を決める。
@objc(StorePlugin)
public class StorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StorePlugin"
    public let jsName = "Store"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "entitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manage", returnType: CAPPluginReturnPromise),
    ]

    private var updates: Task<Void, Never>?

    override public func load() {
        // 更新・家族共有・ほかの端末での購入などは、アプリの外で起きても届く
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                if case .verified(let t) = result { await t.finish() }
                self?.notifyListeners("transaction", data: ["jws": result.jwsRepresentation], retainUntilConsumed: true)
            }
        }
    }

    deinit { updates?.cancel() }

    @objc func products(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        Task {
            do {
                let list = try await Product.products(for: ids)
                call.resolve(["products": list.map { p -> [String: Any] in
                    var o: [String: Any] = [
                        "id": p.id, "title": p.displayName, "description": p.description,
                        "price": p.displayPrice,
                    ]
                    if let s = p.subscription {
                        o["unit"] = Self.unit(s.subscriptionPeriod.unit)
                        o["value"] = s.subscriptionPeriod.value
                    }
                    return o
                }])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// options.id: 商品ID / options.accountToken: ログイン中のユーザーID（UUID）。誰の購入かをサーバーで照合する
    @objc func purchase(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id required") }
        Task {
            do {
                guard let product = try await Product.products(for: [id]).first else {
                    return call.reject("product not found")
                }
                var options: Set<Product.PurchaseOption> = []
                if let s = call.getString("accountToken"), let u = UUID(uuidString: s) {
                    options.insert(.appAccountToken(u))
                }
                switch try await product.purchase(options: options) {
                case .success(let result):
                    if case .verified(let t) = result { await t.finish() }
                    call.resolve(["status": "purchased", "jws": result.jwsRepresentation])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                case .pending:
                    call.resolve(["status": "pending"])
                @unknown default:
                    call.resolve(["status": "unknown"])
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func entitlements(_ call: CAPPluginCall) {
        Task { call.resolve(["jws": await Self.currentJWS()]) }
    }

    /// 購入を復元（審査で必須のボタン）
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do { try await AppStore.sync() } catch { /* キャンセルでも手元の分は返す */ }
            call.resolve(["jws": await Self.currentJWS()])
        }
    }

    /// サブスクリプションの管理（解約・プラン変更）を開く
    @objc func manage(_ call: CAPPluginCall) {
        Task { @MainActor in
            if let scene = self.bridge?.viewController?.view.window?.windowScene {
                try? await AppStore.showManageSubscriptions(in: scene)
            } else if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
                _ = await UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }

    private static func currentJWS() async -> [String] {
        var out: [String] = []
        for await result in Transaction.currentEntitlements { out.append(result.jwsRepresentation) }
        return out
    }

    private static func unit(_ u: Product.SubscriptionPeriod.Unit) -> String {
        switch u {
        case .day: return "day"
        case .week: return "week"
        case .month: return "month"
        case .year: return "year"
        @unknown default: return "unknown"
        }
    }
}
