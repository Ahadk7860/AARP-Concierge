// Buy It For Me — proposals, authorizations, orders (PRD §§3-6, 17-21, 27-28).
//
// THE NON-NEGOTIABLE RULE, ENFORCED IN THE PLATFORM, NOT THE PROMPT:
//   - An authorization is created ONLY by the runtime, from the member's actual
//     message, and ONLY when that message is an explicit approval (§4).
//   - submitCheckout() requires a valid, unused authorization bound to that exact
//     proposal. No authorization → PURCHASE_NOT_AUTHORIZED. The LLM cannot mint
//     one: invokeTool reads authorizations from the store, which only the runtime
//     writes on inbound messages.
//   - A proposal is immutable. Any material change = a NEW proposal, which the old
//     authorization does not cover (§5-6).
import { randomUUID } from "node:crypto";

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

// §28 — categories the agent must never transact in (MVP).
const BLOCKED = [
  [/\b(wine|beer|whisk(?:y|ey)?|vodka|gin|rum|tequila|liquor|alcohol|champagne|prosecco|spirits|cabernet|merlot|rioja|chardonnay|pinot|sauvignon|bordeaux|ros[ée])\b/i, "alcohol"],
  [/\b(cig|tobacco|vape|cannabis|cbd|thc)\b/i, "regulated products"],
  [/\b(prescription|pharmacy rx|medication)\b/i, "prescription drugs"],
  [/\b(gun|firearm|ammo|weapon|knife)\b/i, "weapons"],
  [/\b(casino|lottery|betting|gambl)\b/i, "gambling"],
  [/\b(bitcoin|crypto|ethereum)\b/i, "cryptocurrency"],
  [/\b(gift card|prepaid card|visa card|cash)\b/i, "gift cards / cash equivalents"],
  [/\b(subscription|monthly plan)\b/i, "subscriptions"],
  [/\b(loan|insurance policy|annuity|investment)\b/i, "financial products"],
];

export function blockedCategory(text) {
  for (const [re, label] of BLOCKED) if (re.test(text || "")) return label;
  return null;
}

/** §4 — what counts as permission. Strict by design; "yes"/"sounds good" never do. */
export function isExplicitApproval(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^buy$/.test(t)) return true;
  if (/^place the order$/.test(t)) return true;
  if (/^confirm purchase$/.test(t)) return true;
  if (/^yes,? buy (that|it)( for \$?\d+(\.\d{2})?)?$/.test(t)) return true;
  return false;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** Create an immutable proposal (§5, §18). Throws on blocked categories. */
export function createProposal(store, input, now = new Date().toISOString()) {
  const blocked = blockedCategory(`${input.product_name} ${input.merchant} ${input.category || ""}`);
  if (blocked) throw new Error(`BLOCKED_CATEGORY: agent purchasing is not available for ${blocked}`);
  const subtotal = round2(Number(input.subtotal));
  const discount = round2(Number(input.discount || 0));
  const shipping = round2(Number(input.shipping || 0));
  const tax = round2(Number(input.tax ?? (subtotal - discount) * 0.0825));
  const total = round2(subtotal - discount + shipping + tax);
  if (!(subtotal > 0) || !(total > 0)) throw new Error("invalid amounts");
  const pm = (store.state.payment_methods || []).find((p) => p.id === input.payment_method_id)
    || (store.state.payment_methods || []).find((p) => p.is_default);
  if (!pm) throw new Error("NO_PAYMENT_METHOD: the member has not set up purchasing yet — send them their wallet link");
  const addr = (store.state.addresses || []).find((a) => a.id === input.shipping_address_id || a.label === input.ship_to)
    || (store.state.addresses || []).find((a) => a.is_default);
  if (!addr) throw new Error("NO_ADDRESS: the member has no saved shipping address — send them their wallet link");
  // Any prior pending proposal dies the moment a new one is prepared (§6).
  for (const p of store.state.purchase_proposals || []) {
    if (p.status === "ready_for_confirmation") p.status = "cancelled";
  }
  const prop = {
    id: "prop_" + randomUUID().slice(0, 8),
    merchant: input.merchant, product_name: input.product_name,
    product_url: input.product_url || null, variant: input.variant || null,
    quantity: Math.max(1, Math.floor(input.quantity || 1)),
    subtotal, discount, shipping, tax, total,
    payment_method_id: pm.id, payment_method_display: pm.display,
    shipping_address_id: addr.id, ship_to: addr.label || addr.recipient_name,
    status: "ready_for_confirmation",
    created_at: now, expires_at: new Date(new Date(now).getTime() + PROPOSAL_TTL_MS).toISOString(),
  };
  store.state.purchase_proposals = [...(store.state.purchase_proposals || []), prop].slice(-20);
  store.save();
  return prop;
}

export function pendingProposal(store, now = new Date().toISOString()) {
  return (store.state.purchase_proposals || []).find(
    (p) => p.status === "ready_for_confirmation" && p.expires_at > now) || null;
}

/** RUNTIME-ONLY: called from the inbound path with the member's raw message. */
export function recordAuthorization(store, messageText, now = new Date().toISOString()) {
  if (!isExplicitApproval(messageText)) return null;
  const prop = pendingProposal(store, now);
  if (!prop) return null;
  const auth = {
    id: "auth_" + randomUUID().slice(0, 8),
    proposal_id: prop.id,
    authorization_text: String(messageText).trim(),
    authorized_at: now, used_at: null, status: "valid",
  };
  prop.status = "approved";
  store.state.purchase_authorizations = [...(store.state.purchase_authorizations || []), auth].slice(-20);
  store.save();
  return auth;
}

/** §21 — hard gate. Executes over the simulated rail (real merchant rails at pilot). */
export function submitCheckout(store, proposalId, now = new Date().toISOString()) {
  const prop = (store.state.purchase_proposals || []).find((p) => p.id === proposalId);
  if (!prop) return { error: "PURCHASE_NOT_AUTHORIZED", detail: "unknown proposal" };
  const auth = (store.state.purchase_authorizations || []).find(
    (a) => a.proposal_id === proposalId && a.status === "valid" && !a.used_at);
  if (!auth) return { error: "PURCHASE_NOT_AUTHORIZED",
    detail: "No valid authorization for this proposal. Show the exact order and ask the member to reply BUY." };
  if (prop.expires_at <= now) { prop.status = "expired"; store.save();
    return { error: "PROPOSAL_EXPIRED", detail: "Prepare a fresh checkout and re-confirm." }; }
  if (prop.status !== "approved") return { error: "PURCHASE_NOT_AUTHORIZED", detail: `proposal is ${prop.status}` };

  auth.status = "used"; auth.used_at = now;
  prop.status = "executed";
  const deliveryDays = 3 + Math.floor(3 * ((prop.id.charCodeAt(5) || 0) % 2));
  const order = {
    id: "ord_" + randomUUID().slice(0, 8),
    proposal_id: prop.id, merchant: prop.merchant,
    merchant_order_id: "SIM-" + randomUUID().slice(0, 6).toUpperCase(),
    product_name: prop.product_name, quantity: prop.quantity,
    subtotal: prop.subtotal, discount: prop.discount, shipping: prop.shipping,
    tax: prop.tax, total: prop.total,
    payment_method_display: prop.payment_method_display, ship_to: prop.ship_to,
    status: "purchased", rail: "simulated",
    tracking_number: null,
    estimated_delivery: new Date(new Date(now).getTime() + deliveryDays * 86400000).toISOString().slice(0, 10),
    created_at: now, updated_at: now,
  };
  store.state.orders = [...(store.state.orders || []), order].slice(-50);
  // §26 savings + §23 memory
  if (prop.discount > 0) store.recordSavings(`purchase:${order.id}`, prop.discount, prop.total, now);
  store.remember({ kind: "behavioral", key: "purchase",
    value: `${prop.product_name} from ${prop.merchant} ($${prop.total.toFixed(2)}, saved $${prop.discount.toFixed(2)}) shipped to ${prop.ship_to}`,
    source: "explicit", confidence: 1, now });
  store.save();
  return { order };
}

/** Display block the agent must show before asking for BUY (§3). */
export function proposalDisplay(p) {
  return [
    `Ready to order`,
    `${p.product_name}${p.variant ? ` (${p.variant})` : ""}${p.quantity > 1 ? ` × ${p.quantity}` : ""}`,
    p.merchant,
    `Item: $${p.subtotal.toFixed(2)}`,
    ...(p.discount ? [`AARP savings: −$${p.discount.toFixed(2)}`] : []),
    `Shipping: ${p.shipping ? "$" + p.shipping.toFixed(2) : "Free"}`,
    `Tax: $${p.tax.toFixed(2)}`,
    `Final total: $${p.total.toFixed(2)}`,
    `Card: ${p.payment_method_display}`,
    `Ship to: ${p.ship_to}`,
    ``,
    `Reply BUY to place this exact order.`,
  ].join("\n");
}
