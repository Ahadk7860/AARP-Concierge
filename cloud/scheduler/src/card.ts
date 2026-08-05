// The scheduler's card edge.
//
// Without this the daemon would send card-less briefs forever and the acquisition loop
// would exist only inside `npm run e2e` — which is the "three components, each correct
// about its own half" failure this track was formed to find, reproduced one more time.
// Prompt 05 made the card real; a scheduler that does not ask for one un-makes it.
//
// Deliberately NOT `cloud/e2e/src/card-client.ts`: that one writes the PNG into the run's
// artifact directory, which is an evidence-gathering concern and has no place in a
// long-running process.

import type { UserScope } from "../../db/src/index.js";

export type CardFor = (
  scope: UserScope,
  digest: unknown,
) => Promise<{ url: string | null; kind: "standard" | "refusal" | null }>;

/** No renderer configured is a legitimate deployment; it costs the card, not the brief. */
export function cardForFromEnvironment(
  log: (event: Record<string, unknown>) => void = () => {},
): CardFor | undefined {
  const base = process.env["BOI_CARD_BASE"];
  if (base === undefined || base === "") return undefined;
  return cardFor(base, log);
}

export function cardFor(
  baseUrl: string,
  log: (event: Record<string, unknown>) => void = () => {},
  timeoutMs = 20_000,
): CardFor {
  return async (scope, digest) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/internal/cards/${encodeURIComponent(scope.user_id)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-boi-card-write": process.env["BOI_CARD_WRITE_SECRET"] ?? "",
          },
          body: JSON.stringify(digest),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        log({ msg: "card.rejected", status: response.status, user_id: scope.user_id });
        return { url: null, kind: null };
      }
      const body = (await response.json()) as {
        kind: "standard" | "refusal";
        url: string | null;
      };
      return { url: body.url, kind: body.kind };
    } catch (err) {
      // Connection refused, DNS, timeout. THE BRIEF STILL GOES — a renderer that is down
      // is a degraded morning, and throwing here would make it a missing one.
      log({
        msg: "card.unavailable",
        user_id: scope.user_id,
        error: err instanceof Error ? err.name : "unknown",
        consequence: "the brief goes out with card_url: null, which is the point",
      });
      return { url: null, kind: null };
    } finally {
      clearTimeout(timer);
    }
  };
}
