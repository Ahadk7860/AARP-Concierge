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
 * draft. `encodeURIComponent` is required for both recipient and body: `+`, `&`, emoji,
 * and punctuation otherwise change the URI's recipient or truncate its prefilled text.
 */
export function composeTapToSend(delivery: DraftDelivery): ComposedDraftDelivery {
  const { text } = delivery;
  if (delivery.recipient.kind !== "resolved" || delivery.recipient.handle.length === 0) {
    return { text, recipient_state: "unavailable", sms_link: null };
  }
  return {
    text,
    recipient_state: "resolved",
    sms_link: `sms:${encodeURIComponent(delivery.recipient.handle)}&body=${encodeURIComponent(text)}`,
  };
}
