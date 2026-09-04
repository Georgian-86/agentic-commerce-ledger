// Razorpay test-mode integration. The ONLY file that talks to Razorpay.
//
// Two things worth knowing before editing this:
//
// 1. The browser redirect callback is not the source of truth. A user
//    who closes the tab after paying never triggers it, and one who
//    presses F5 triggers it twice. Webhooks are the authoritative
//    signal; the redirect is a UX nicety. Both paths are implemented,
//    both are signature-verified, and both are idempotent.
//
// 2. Webhook signatures are computed over the RAW request body. Parse
//    the JSON first and the bytes change (key order, whitespace,
//    unicode escapes) and every signature fails. That's why index.js
//    mounts express.raw() on the webhook route specifically.
//
// DEMO_MODE short-circuits the network call only. Signature
// verification, gating, ledger holds and audit writes all run exactly
// as they do against the live API, and the mock path is labelled
// everywhere it surfaces.
import Razorpay from "razorpay";
import { createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || KEY_SECRET;
const DEMO_MODE = String(process.env.DEMO_MODE).toLowerCase() === "true";

const hasRealCreds = Boolean(KEY_ID && KEY_SECRET && !KEY_ID.includes("xxxx"));
const live = hasRealCreds && !DEMO_MODE ? new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET }) : null;

export const isDemoMode = () => DEMO_MODE || !hasRealCreds;
export const rail = () => (isDemoMode() ? "razorpay_test_simulated" : "razorpay_test_mode");

/** Constant-time compare, so signature checking doesn't leak timing. */
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf-8");
  const bufB = Buffer.from(String(b || ""), "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hmac(payload, secret) {
  return createHmac("sha256", secret || "dev-only-insecure-secret").update(payload).digest("hex");
}

/**
 * Create a Razorpay Payment Link (test mode). Payment Links keep the
 * dashboard a single static page: the presenter opens the short_url,
 * pays with a Razorpay test card, and gets redirected back to
 * callback_url with signed parameters we verify server-side.
 */
export async function createPaymentLink({ amount_paise, description, reference_id, callback_url, notes = {} }) {
  if (isDemoMode()) {
    const id = `plink_demo_${randomUUID().slice(0, 12)}`;
    return {
      id,
      short_url: `${callback_url.replace(/\/payment-callback.*/, "")}/demo-pay?link_id=${id}&ref=${reference_id}`,
      status: "created",
      amount: amount_paise,
      reference_id,
      demo: true,
    };
  }
  const link = await live.paymentLink.create({
    amount: amount_paise,
    currency: "INR",
    description: description.slice(0, 250),
    reference_id,
    callback_url,
    callback_method: "get",
    notes,
  });
  return { ...link, demo: false };
}

/**
 * Refund a captured payment. Razorpay supports idempotency keys on
 * refunds; we pass the order id as the receipt so a retried refund is
 * traceable to exactly one order.
 */
export async function createRefund({ payment_id, amount_paise, order_draft_id, reason }) {
  if (isDemoMode()) {
    return {
      id: `rfnd_demo_${randomBytes(6).toString("hex")}`,
      payment_id,
      amount: amount_paise,
      status: "processed",
      speed_processed: "normal",
      notes: { order_draft_id, reason },
      demo: true,
    };
  }
  const refund = await live.payments.refund(payment_id, {
    amount: amount_paise,
    speed: "normal",
    receipt: order_draft_id,
    notes: { order_draft_id, reason: String(reason || "").slice(0, 250) },
  });
  return { ...refund, demo: false };
}

/** Verify a Payment Link redirect-callback signature. Fails closed. */
export function verifyPaymentLinkSignature({ payment_link_id, payment_link_reference_id, payment_link_status, payment_id, signature }) {
  if (!payment_link_id || !payment_link_reference_id || !payment_link_status || !payment_id || !signature) return false;
  const payload = `${payment_link_id}|${payment_link_reference_id}|${payment_link_status}|${payment_id}`;
  return safeEqualHex(hmac(payload, KEY_SECRET), signature);
}

/** Verify a standard Orders + Checkout.js signature (alternate flow). */
export function verifyOrderSignature({ order_id, payment_id, signature }) {
  if (!order_id || !payment_id || !signature) return false;
  return safeEqualHex(hmac(`${order_id}|${payment_id}`, KEY_SECRET), signature);
}

/**
 * Verify an X-Razorpay-Signature webhook header.
 * `rawBody` MUST be the untouched request bytes — see the note at the
 * top of this file.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf-8") : String(rawBody);
  return safeEqualHex(hmac(body, WEBHOOK_SECRET), signature);
}

/**
 * Build a signed demo-mode success callback, so DEMO_MODE exercises the
 * identical verification path a real payment does. Nothing about
 * signature checking is skipped in demo mode — only the network call.
 */
export function buildDemoCallback({ payment_link_id, reference_id }) {
  const payment_id = `pay_demo_${randomBytes(6).toString("hex")}`;
  const payment_link_status = "paid";
  const payload = `${payment_link_id}|${reference_id}|${payment_link_status}|${payment_id}`;
  return {
    razorpay_payment_id: payment_id,
    razorpay_payment_link_id: payment_link_id,
    razorpay_payment_link_reference_id: reference_id,
    razorpay_payment_link_status: payment_link_status,
    razorpay_signature: hmac(payload, KEY_SECRET),
  };
}

/** Build a signed demo webhook envelope, for rehearsing the webhook path. */
export function buildDemoWebhook({ payment_link_id, reference_id, amount_paise }) {
  const payment_id = `pay_demo_${randomBytes(6).toString("hex")}`;
  const event = {
    entity: "event",
    account_id: "acc_demo",
    event: "payment_link.paid",
    contains: ["payment_link", "payment"],
    payload: {
      payment_link: {
        entity: {
          id: payment_link_id,
          reference_id,
          status: "paid",
          amount: amount_paise,
          amount_paid: amount_paise,
          currency: "INR",
        },
      },
      payment: { entity: { id: payment_id, status: "captured", amount: amount_paise, method: "upi" } },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
  const raw = JSON.stringify(event);
  return {
    raw,
    event_id: `evt_demo_${randomBytes(8).toString("hex")}`,
    signature: hmac(raw, WEBHOOK_SECRET),
  };
}

/**
 * Pull the fields we care about out of a payment_link.paid webhook.
 * Path per Razorpay's docs: payload.payment_link.entity.{id,reference_id,status}
 * and payload.payment.entity.id.
 */
export function parsePaymentLinkWebhook(event) {
  const link = event?.payload?.payment_link?.entity;
  const payment = event?.payload?.payment?.entity;
  if (!link) return null;
  return {
    event_type: event.event,
    payment_link_id: link.id,
    reference_id: link.reference_id,
    status: link.status,
    amount_paise: link.amount,
    payment_id: payment?.id || null,
    method: payment?.method || null,
  };
}
