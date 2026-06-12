// GET /api/confirm?email=…&t=…  — second half of the double opt-in.
// Verifies the HMAC token from the confirmation email and flips the Resend
// contact to subscribed. Returns a tiny standalone HTML page.
import { resend, confirmToken, tokenEqual, configured } from "./_resend.js";

const page = (title, msg, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;color:#1d2330;` +
  `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">` +
  `<div style="background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:32px 36px;max-width:480px;text-align:center;">` +
  `<h2 style="margin-top:0;">${title}</h2><p style="color:#6b7280;line-height:1.6;">${msg}</p>` +
  `<p style="margin-top:24px;"><a href="/#browse" style="color:#2f5bd0;text-decoration:none;font-weight:600;">→ Browse today's papers</a></p>` +
  `</div></body></html>`,
  { status, headers: { "content-type": "text/html;charset=utf-8" } });

export async function onRequestGet({ request, env }) {
  if (!configured(env)) return page("Not available", "Subscriptions are not open yet.", 503);

  const url = new URL(request.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const t = url.searchParams.get("t") || "";
  if (!email || !tokenEqual(t, await confirmToken(env, email))) {
    return page("Link not valid", "This confirmation link is invalid or was altered. " +
      "Re-enter your email on the site to get a fresh one.", 400);
  }

  const upd = await resend(env, "PATCH", `/contacts/${encodeURIComponent(email)}`, { unsubscribed: false });
  if (!upd.ok) return page("Something went wrong", "We couldn't confirm the subscription just now — try the link again in a minute.", 502);

  return page("You're subscribed ✓",
    `The daily digest of new IS papers will arrive at <strong>${email}</strong> every morning (09:00 KST). ` +
    "Every email has a one-click unsubscribe link.");
}
