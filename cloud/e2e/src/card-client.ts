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
  /** Cards are stored per user, and deleted per user. */
  userId: string;
  /** Where the PNG is written. In production this is object storage. */
  artifactDir: string;
  timeoutMs?: number;
  log?: (event: Record<string, unknown>) => void;
};

/**
 * POSTs a digest to the renderer, which stores the card and hands back a signed URL.
 *
 * **This used to return a `file://` URL and that was the finding.** It "resolved" — the
 * DoD's word — on the machine that rendered it, and no transport on earth can fetch it,
 * so the acquisition loop was wired end to end and still could not reach a phone. It now
 * calls `POST /cards/:user_id`, and the URL that comes back is an HTTP one somebody else
 * can GET.
 *
 * The PNG is still written to the artifact directory, because the artifact directory is
 * how a human reads a run — but that copy is evidence, not the address.
 */
export async function renderCardForDigest(
  digest: unknown,
  options: CardClientOptions,
): Promise<CardResult> {
  const userId = options.userId;
  const log = options.log ?? (() => {});
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

  try {
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, "")}/internal/cards/${encodeURIComponent(userId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The write route is authenticated as well as being off the public prefix.
        "x-boi-card-write": process.env["BOI_CARD_WRITE_SECRET"] ?? "",
      },
      body: JSON.stringify(digest),
      signal: controller.signal,
    },
    );

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

    const body = (await response.json()) as {
      kind: "standard" | "refusal";
      reason: string | null;
      url: string | null;
      card_id: string | null;
      bytes: number;
    };

    // A refusal card is rendered and NOT stored, so there is no URL and nothing to
    // attach. That is the policy, not a failure: honest once on the onboarding surface,
    // a reproach every morning in a brief.
    if (body.kind === "refusal" || body.url === null) {
      log({
        msg: "card.refused",
        reason: body.reason,
        consequence: "the brief goes out with no image block, which is the policy",
      });
      return {
        url: null, bytes: body.bytes, kind: body.kind, reason: body.reason,
        durationMs: Date.now() - started,
      };
    }

    // Fetch it back over HTTP and write THOSE bytes to the artifact directory. Writing
    // the render response instead would prove only that the renderer can render; this
    // proves the URL in the brief resolves, which is the thing that was false before.
    const fetched = await fetch(body.url);
    if (!fetched.ok) {
      log({ msg: "card.unfetchable", status: fetched.status, url_host: hostOf(body.url) });
      return {
        url: null, bytes: 0, kind: body.kind, reason: body.reason,
        durationMs: Date.now() - started, error: `fetch_${fetched.status}`,
      };
    }
    const png = Buffer.from(await fetched.arrayBuffer());
    await mkdir(options.artifactDir, { recursive: true });
    await writeFile(path.join(options.artifactDir, "card.png"), png);

    log({
      msg: "card.rendered",
      bytes: png.length,
      kind: body.kind,
      card_id: body.card_id,
      duration_ms: Date.now() - started,
    });
    return {
      url: body.url,
      bytes: png.length,
      kind: body.kind,
      reason: body.reason,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // Connection refused, DNS, timeout. THE BRIEF STILL GOES.
    const error = err instanceof Error ? err.name : "unknown";
    log({
      msg: "card.unavailable",
      error,
      detail: err instanceof Error ? err.message : String(err),
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

/** Host only — a signed card URL carries a signature nobody needs in a log line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unparseable";
  }
}
