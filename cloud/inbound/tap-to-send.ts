/** Local mirror of frozen `draft_delivery.v1`; Track I must not widen the shared contract. */
export type DraftDelivery = {
  schema_version: "draft_delivery.v1";
  contact_id: string;
  text: string;
  recipient: { kind: "resolved"; handle: string } | { kind: "unavailable" };
};

export type ComposedDraftDelivery = {
  /** Always renderable/copyable, including degraded recipient resolution. */
  text: string;
  recipient_state: "resolved" | "unavailable";
  /** A tap-to-send URL only when the frozen delivery has a resolved recipient. */
  sms_link: string | null;
};

/**
 * Produces a user-mediated Messages action. This never sends, queues, logs, or stores the
 * draft. The validated recipient remains byte-for-byte raw to preserve the pinned Apple
 * `sms:<handle>&body=` shape (especially E.164's leading `+`); only the body is encoded.
 */
export function composeTapToSend(delivery: DraftDelivery): ComposedDraftDelivery {
  const { text } = delivery;
  if (delivery.recipient.kind !== "resolved" || !isUsableMessageHandle(delivery.recipient.handle)) {
    return { text, recipient_state: "unavailable", sms_link: null };
  }
  return {
    text,
    recipient_state: "resolved",
    sms_link: `sms:${delivery.recipient.handle}&body=${encodeURIComponent(text)}`,
  };
}

function isUsableMessageHandle(handle: string): boolean {
  if (handle.length === 0 || handle.length > 254 || handle.trim() !== handle) return false;
  // Delimiters could escape the recipient position even if a future URI encoder changes.
  // Keep this punctuation boundary aligned with Swift's `ThreadHandoff.isUsable`.
  if (/[\u0000-\u001f\u007f\s&#?/\\<>"']/u.test(handle)) return false;
  if (/^\+[1-9][0-9]{7,14}$/u.test(handle)) return true;
  const parts = handle.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local === undefined || domain === undefined || local.length === 0 || local.length > 64) return false;
  if (!/^[A-Za-z0-9.!$%*+\-=_^`{|}~]+$/u.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (domain.length > 253 || !domain.includes(".")) return false;
  return domain.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label));
}
