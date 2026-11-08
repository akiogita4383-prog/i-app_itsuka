// アプリ内の「アカウントを削除」から呼ぶ（App Store の審査要件）。
// 自分が作った共有帳（と写真）を消し、ほかの帳に書いたメモは「退会したメンバー」として残してから、ログイン情報を消す。
import { admin, callerId, cors, json } from "../_shared/apple.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const uid = await callerId(req);
  if (!uid) return json({ error: "unauthorized" }, 401);
  const db = admin();
  try {
    const { data: owned } = await db.from("notebooks").select("id").eq("owner_id", uid);
    for (const nb of owned ?? []) {
      // <notebook_id>/<item_id>/<photo>.jpg を全部消す
      const { data: dirs } = await db.storage.from("photos").list(nb.id, { limit: 1000 });
      for (const d of dirs ?? []) {
        const { data: files } = await db.storage.from("photos").list(`${nb.id}/${d.name}`, { limit: 1000 });
        const paths = (files ?? []).map((f) => `${nb.id}/${d.name}/${f.name}`);
        if (paths.length) await db.storage.from("photos").remove(paths);
      }
      await db.from("notebooks").delete().eq("id", nb.id);
    }
    const { error } = await db.auth.admin.deleteUser(uid);
    if (error) throw error;
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "delete failed" }, 500);
  }
});
