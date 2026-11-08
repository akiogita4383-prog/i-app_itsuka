import Foundation
import AuthenticationServices
import Capacitor

/// Sign in with Apple。共有帳を作る・参加するときだけ呼ぶ（起動時には求めない）。
/// 返した identityToken を Web 側が Supabase の signInWithIdToken に渡す。
@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate,
                                ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    private var pending: CAPPluginCall?

    /// options.nonce: SHA-256 済みの nonce（生の値は Web 側が持ち、Supabase に渡す）
    @objc func authorize(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pending = call
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName]
            if let nonce = call.getString("nonce") { request.nonce = nonce }
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = pending else { return }
        pending = nil
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            call.reject("no identity token")
            return
        }
        let name = [cred.fullName?.familyName, cred.fullName?.givenName]
            .compactMap { $0 }.joined(separator: " ")
        call.resolve(["identityToken": token, "user": cred.user, "name": name])
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = pending else { return }
        pending = nil
        if let e = error as? ASAuthorizationError, e.code == .canceled {
            call.reject("canceled", "CANCELED")
        } else {
            call.reject(error.localizedDescription)
        }
    }
}
