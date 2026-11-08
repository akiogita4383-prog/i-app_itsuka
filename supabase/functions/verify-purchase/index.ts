// アプリが購入・復元したときに呼ぶ。署名付きトランザクションを検証して、呼び出した本人の profiles.plan を更新する。
//   POST { jws: string[] }  ← StoreKit 2 の jwsRepresentation（複数可）
import { applyTransaction, callerId, cors, json, verifyTransaction } from "../_shared/apple.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const uid = await callerId(req);
  if (!uid) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const list: string[] = Array.isArray(body.jws) ? body.jws : body.jws ? [body.jws] : [];
  if (!list.length) return json({ error: "no transaction" }, 400);

  // いちばん先まで有効なものを採用する
  let best: Awaited<ReturnType<typeof verifyTransaction>> | null = null;
  for (const jws of list) {
    try {
      const t = await verifyTransaction(jws);
      // 購入時に appAccountToken へログイン中のユーザーIDを入れている。他人の購入は受け付けない
      if (t.appAccountToken && t.appAccountToken.toLowerCase() !== uid.toLowerCase()) continue;
      if (!best || (t.expiresDate ?? 0) > (best.expiresDate ?? 0)) best = t;
    } catch (e) {
      console.error("verify failed", e);
    }
  }
  if (!best) return json({ error: "invalid transaction" }, 400);
  try {
    return json(await applyTransaction(best, uid));
  } catch (e) {
    console.error(e);
    return json({ error: "update failed" }, 500);
  }
});
