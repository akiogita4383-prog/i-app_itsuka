// App Store Server Notifications V2 の受け口。更新・解約・返金などを profiles.plan に反映する。
// App Store Connect → アプリ → App 情報 →「App Store サーバ通知」に、この関数の URL を本番・Sandbox とも登録する。
// Apple から直接呼ばれるので、Supabase の JWT 検証はオフにしてデプロイする（--no-verify-jwt）。署名は Apple の証明書で検証する。
import { admin, applyTransaction, verifyNotification, verifyTransaction } from "../_shared/apple.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  try {
    const { signedPayload } = await req.json();
    const n = await verifyNotification(signedPayload);
    const signedTx = n.data?.signedTransactionInfo;
    if (!signedTx) return new Response("ok");
    const t = await verifyTransaction(signedTx);
    const uid = t.appAccountToken;
    if (!uid) return new Response("ok");
    const { data } = await admin().from("profiles").select("id").eq("id", uid).maybeSingle();
    if (data) await applyTransaction(t, uid);
    return new Response("ok");
  } catch (e) {
    console.error(e);
    // 検証に失敗したものは受け取らない（Apple は再送してくる）
    return new Response("bad request", { status: 400 });
  }
});
