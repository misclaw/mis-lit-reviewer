// POST /api/subscribe {email, website}
//
// Double opt-in, no database: the contact is created in Resend with
// unsubscribed=true (pending) and a confirmation email carries an HMAC token;
// /api/confirm flips unsubscribed to false. Daily broadcasts only reach
// subscribed contacts, so pending/unconfirmed addresses never get the digest.
import { resend, confirmToken, configured, fromAddr, json } from "./_resend.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  if (!configured(env)) return json({ error: "Subscriptions are not open yet." }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  if (body.website) return json({ ok: true }); // honeypot field — pretend success, store nothing

  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "That email address looks invalid." }, 400);

  // Already confirmed → done. (404 = new contact; anything else we try to create anyway.)
  const existing = await resend(env, "GET", `/contacts/${encodeURIComponent(email)}`);
  if (existing.ok && existing.data?.unsubscribed === false) return json({ ok: true, already: true });

  if (!existing.ok) {
    const created = await resend(env, "POST", "/contacts", {
      email, unsubscribed: true, segments: [env.RESEND_SEGMENT_ID],
    });
    const exists = created.status === 409 || /exist/i.test(created.data?.message || "");
    if (!created.ok && !exists) return json({ error: "Could not register the subscription — try again later." }, 502);
  }

  const t = await confirmToken(env, email);
  const confirmUrl = `${new URL(request.url).origin}/api/confirm?email=${encodeURIComponent(email)}&t=${t}`;
  const sent = await resend(env, "POST", "/emails", {
    from: fromAddr(env),
    to: email,
    subject: "Confirm your subscription — MIS daily digest",
    text: `Click to start receiving the daily digest of new IS papers:\n\n${confirmUrl}\n\n` +
      "If you didn't request this, ignore this email and nothing will be sent.",
    html:
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1d2330;">` +
      `<h2 style="margin-bottom:4px;">MIS daily digest</h2>` +
      `<p>One click left — confirm this address to start receiving the daily email of newly published IS papers.</p>` +
      `<p style="margin:24px 0;"><a href="${confirmUrl}" style="background:#2f5bd0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Confirm subscription</a></p>` +
      `<p style="color:#6b7280;font-size:12px;">If you didn't request this, ignore this email and nothing will be sent.<br>` +
      `mis-lit-reviewer.misclaw.app</p></div>`,
  });
  if (!sent.ok) return json({ error: "Could not send the confirmation email — try again later." }, 502);

  return json({ ok: true });
}
