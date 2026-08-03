// The edge between the brief and the card renderer.
//
// `cloud/card/` has rendered a 9:16 PNG since Track D built it, is tested against its own
// archetypes, and had never been called by anything but its own suite. `composeBrief`
// accepted `card_url` and every caller passed `null`. This is gap 3.
//
// **The rule that shapes the whole file: a renderer that is down produces a brief
// WITHOUT a card, never no brief.** The card is the acquisition loop and the brief is the
// product. `null` here is a degraded morning; a throw is a missing one, and a missing
// morning text is the thing the user actually notices.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type CardResult = {
  url: string | null;
  bytes: number;
  /** `standard` | `refusal`, from `x-boi-card-kind`. A refusal is still a real card. */
  kind: string | null;
  reason: string | null;
  durationMs: number;
  error?: string;
};

export type CardClientOptions = {
  baseUrl: string;
  /** Where the PNG is written. In production this is object storage. */
  artifactDir: string;
  timeoutMs?: number;
  log?: (event: Record<string, unknown>) => void;
};

/**
 * POSTs a digest to the renderer and writes the PNG next to the run's other artifacts.
 *
 * The returned `url` is a `file://` URL that genuinely resolves on this machine, which is
 * what the DoD means by "a `card_url` that resolves". **Production is object storage and
 * a signed HTTPS URL** — the card is the share artifact, so it has to be fetchable by
 * whoever the user sends it to, and a `file://` obviously is not. Recorded in NOTES.md;
 * the swap is one function.
 */
export async function renderCardForDigest(
  digest: unknown,
  options: CardClientOptions,
): Promise<CardResult> {
  const log = options.log ?? (() => {});
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(digest),
      signal: controller.signal,
    });

    if (!response.ok) {
      // A 400 here means the renderer rejected a digest the API accepted, which would be
      // a real disagreement between two consumers of the same zod mirror. Logged as such
      // rather than swallowed as "the card is down".
      const detail = response.status === 400 ? await response.text() : "";
      log({
        msg: "card.rejected",
        status: response.status,
        detail: detail.slice(0, 200),
        consequence: "the brief will go out with no card",
      });
      return {
        url: null,
        bytes: 0,
        kind: null,
        reason: null,
        durationMs: Date.now() - started,
        error: `http_${response.status}`,
      };
    }

    const png = Buffer.from(await response.arrayBuffer());
    await mkdir(options.artifactDir, { recursive: true });
    const file = path.join(options.artifactDir, "card.png");
    await writeFile(file, png);

    const kind = response.headers.get("x-boi-card-kind");
    const reason = response.headers.get("x-boi-card-reason") || null;
    log({
      msg: "card.rendered",
      bytes: png.length,
      kind,
      reason,
      duration_ms: Date.now() - started,
    });
    return {
      url: `file://${file}`,
      bytes: png.length,
      kind,
      reason,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // Connection refused, DNS, timeout. THE BRIEF STILL GOES.
    const error = err instanceof Error ? err.name : "unknown";
    log({
      msg: "card.unavailable",
      error,
      consequence: "the brief will go out with card_url: null, which is the point",
    });
    return {
      url: null,
      bytes: 0,
      kind: null,
      reason: null,
      durationMs: Date.now() - started,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}
