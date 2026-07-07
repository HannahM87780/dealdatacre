/**
 * Cloudflare Pages Function — POST /api/create-checkout-session
 * ------------------------------------------------------------------
 * Creates a Stripe Checkout Session for "The One Pager" and returns
 * the hosted Checkout URL for the browser to redirect to.
 *
 * No npm dependency / no build step: we call the Stripe REST API
 * directly with fetch(). The secret key NEVER leaves the server.
 *
 * Required Cloudflare environment variables:
 *   STRIPE_SECRET_KEY        sk_live_... / sk_test_...   (SECRET)
 *   STRIPE_PRICE_ONE_PAGER   price_...                   (the One Pager price ID)
 *   SITE_URL                 https://dealdatacre.com     (no trailing slash)
 *
 * Optional (admin email notification — dormant until set):
 *   RESEND_API_KEY           re_...        enables an intake email to ADMIN_EMAIL
 *   ADMIN_EMAIL              admin@dealdatacre.com   (defaults to this)
 *   MAIL_FROM                DealDataCRE <noreply@dealdatacre.com>
 */

const ADMIN_FALLBACK = "admin@dealdatacre.com";

// Fields the customer must provide. Server-side mirror of the form's
// client-side validation — never trust the browser alone.
// Phone, company, description and goal are optional by design — an assistant
// placing the order can pay without knowing the investor's goals.
const REQUIRED = [
  "name",
  "email",
  "property_address",
  "property_type",
];

// Human labels for metadata keys + the admin email body.
const FIELD_LABELS = {
  product: "Product",
  name: "Name",
  email: "Email",
  phone: "Phone",
  company: "Company",
  property_address: "Property address",
  property_type: "Property type",
  description: "Property description",
  goal: "What they want to accomplish",
  deadline: "Target deadline",
  price: "Purchase / asking price",
  building_size: "Building size",
  land_size: "Land size",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Stripe metadata caps: <=500 chars per value, <=50 keys. Truncate safely.
function clip(value, max = 480) {
  const s = (value == null ? "" : String(value)).trim();
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- config guard -------------------------------------------------
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ONE_PAGER) {
    return json(
      { error: "Payments are not configured yet. Please contact admin@dealdatacre.com." },
      500
    );
  }

  // ---- parse body ---------------------------------------------------
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // ---- server-side validation --------------------------------------
  const missing = REQUIRED.filter((k) => !data[k] || !String(data[k]).trim());
  if (missing.length) {
    return json({ error: "Missing required fields.", fields: missing }, 400);
  }
  const email = String(data.email).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "Please enter a valid email address.", fields: ["email"] }, 400);
  }

  const siteUrl = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, "");

  // ---- build Stripe Checkout Session params (form-urlencoded) ------
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price]", env.STRIPE_PRICE_ONE_PAGER);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${siteUrl}/cancel.html`);
  params.set("customer_email", email);
  params.set("client_reference_id", clip(`onepager:${data.company || data.name}`, 200));
  params.set("submit_type", "pay");
  params.set("billing_address_collection", "auto");

  // Pack every intake field into session metadata so the full order shows
  // up attached to the payment in the Stripe Dashboard.
  const meta = { product: "The One Pager" };
  for (const key of Object.keys(FIELD_LABELS)) {
    if (key === "product") continue;
    if (data[key]) meta[key] = clip(data[key]);
  }
  for (const [k, v] of Object.entries(meta)) {
    params.set(`metadata[${k}]`, v);
    params.set(`payment_intent_data[metadata][${k}]`, v);
  }

  // ---- create the session ------------------------------------------
  let session;
  try {
    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    session = await resp.json();
    if (!resp.ok) {
      const msg = session && session.error && session.error.message;
      return json({ error: msg || "Could not start checkout." }, 502);
    }
  } catch (err) {
    return json({ error: "Could not reach the payment processor. Try again." }, 502);
  }

  // ---- admin notification (dormant until RESEND_API_KEY is set) -----
  // Does NOT block or fail checkout — fire and forget, swallow errors.
  context.waitUntil(notifyAdmin(env, data, session));

  return json({ url: session.url, id: session.id });
}

/**
 * Sends the full intake to the admin inbox via Resend.
 * No-op (logs and returns) until RESEND_API_KEY is set in Cloudflare,
 * so today nothing is sent and nothing breaks — flip it on later with
 * one env var, no code change.
 */
async function notifyAdmin(env, data, session) {
  if (!env.RESEND_API_KEY) return; // dormant — see Stripe metadata for now

  const to = env.ADMIN_EMAIL || ADMIN_FALLBACK;
  const from = env.MAIL_FROM || `DealDataCRE <noreply@dealdatacre.com>`;

  const lines = [
    "New One Pager order — payment started.",
    "",
    `Stripe session: ${session.id}`,
    `Amount: ${session.amount_total ? "$" + (session.amount_total / 100).toFixed(2) : "$200.00"}`,
    "",
    "— Intake —",
  ];
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const val = key === "product" ? "The One Pager" : data[key];
    if (val) lines.push(`${label}: ${val}`);
  }
  lines.push("", "Reminder: customer was asked to email supporting documents to " + to + ".");
  const text = lines.join("\n");

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: data.email,
        subject: `One Pager order — ${data.name} · ${data.property_address || ""}`.trim(),
        text,
      }),
    });
  } catch (err) {
    // Intentionally swallowed — the order is already in Stripe metadata.
  }
}
