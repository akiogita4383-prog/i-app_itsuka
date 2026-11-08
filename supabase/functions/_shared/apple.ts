// App Store のレシート（StoreKit 2 の署名付きトランザクション）を検証して、profiles.plan を書く。
// 端末の自己申告は信じない。Apple の署名を検証できたものだけを反映する。
import { Buffer } from "node:buffer";
import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
} from "npm:@apple/app-store-server-library@3.1.0";
import { createClient } from "npm:@supabase/supabase-js@2";

export const BUNDLE_ID = Deno.env.get("APPLE_BUNDLE_ID") ?? "com.akioyamamoto.itsuka";
const APP_APPLE_ID = Number(Deno.env.get("APPLE_APP_ID") ?? "6831889070");
export const PRODUCT_IDS = (Deno.env.get("PLUS_PRODUCT_IDS") ?? "itsuka.plus.monthly,itsuka.plus.yearly")
  .split(",").map((s) => s.trim());

const ROOT_CERT_URLS = [
  "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer",
  "https://www.apple.com/appleca/AppleIncRootCertificate.cer",
];

let verifiers: SignedDataVerifier[] | null = null;
async function getVerifiers(): Promise<SignedDataVerifier[]> {
  if (verifiers) return verifiers;
  const roots = await Promise.all(ROOT_CERT_URLS.map(async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`root cert ${u}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }));
  // 本番と Sandbox（TestFlight・審査）の両方を受け付ける
  verifiers = [
    new SignedDataVerifier(roots, false, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID),
    new SignedDataVerifier(roots, false, Environment.SANDBOX, BUNDLE_ID),
  ];
  return verifiers;
}

export async function verifyTransaction(jws: string): Promise<JWSTransactionDecodedPayload> {
  let last: unknown;
  for (const v of await getVerifiers()) {
    try { return await v.verifyAndDecodeTransaction(jws); } catch (e) { last = e; }
  }
  throw last ?? new Error("verify failed");
}

export async function verifyNotification(signedPayload: string) {
  let last: unknown;
  for (const v of await getVerifiers()) {
    try { return await v.verifyAndDecodeNotification(signedPayload); } catch (e) { last = e; }
  }
  throw last ?? new Error("verify failed");
}

export function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/** 呼び出した人（アプリでログイン中のユーザー）を確かめる */
export async function callerId(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

/** トランザクションから会員状態を決めて profiles に書く。書いた状態を返す */
export async function applyTransaction(t: JWSTransactionDecodedPayload, userId: string) {
  const expires = t.expiresDate ? new Date(t.expiresDate) : null;
  const active = !!t.productId && PRODUCT_IDS.includes(t.productId) && t.bundleId === BUNDLE_ID &&
    !t.revocationDate && !!expires && expires.getTime() > Date.now();
  const row = active
    ? { plan: "plus", plan_expires_at: expires!.toISOString() }
    : { plan: "free", plan_expires_at: expires ? expires.toISOString() : null };
  const { error } = await admin().from("profiles").update(row).eq("id", userId);
  if (error) throw error;
  return row;
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
