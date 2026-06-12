// Shared helpers for the subscription endpoints (Cloudflare Pages Functions).
//
// Required Pages project environment variables (set once, see README):
//   RESEND_API_KEY    — Resend API key (secret)
//   RESEND_SEGMENT_ID — segment that receives the daily digest broadcast
//   CONFIRM_SECRET    — random string; HMAC key for double-opt-in links
// Optional:
//   DIGEST_FROM       — sender, defaults to the misclaw digest address

export async function resend(env, method, path, body) {
  const res = await fetch("https://api.resend.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function confirmToken(env, email) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.CONFIRM_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(email));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare (both hex, same charset).
export function tokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const configured = (env) => !!(env.RESEND_API_KEY && env.RESEND_SEGMENT_ID && env.CONFIRM_SECRET);

export const fromAddr = (env) => env.DIGEST_FROM || "MIS Lit Reviewer <digest@misclaw.app>";

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
