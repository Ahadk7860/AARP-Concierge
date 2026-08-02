// The 9:16 render. digest.v1 -> SVG -> PNG, server-side, identical for everyone.
//
// Server-side because the card is the acquisition loop: it gets screenshotted into a
// group chat, and every share has to look the same regardless of whose phone took the
// screenshot. A client-side render is a different card per device.

import { Resvg } from "@resvg/resvg-js";
import type { Digest } from "../../shared/src/index.js";
import { buildCardModel, type CardModel } from "./model.js";
import { CARD_TITLE, FOOTER, THIN_BODY, THIN_HINT, THIN_TITLE } from "./copy.js";

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1920;
/** 96px margins either side. Every wrapped line is measured against this. */
export const MARGIN = 96;
export const CONTENT_WIDTH = CARD_WIDTH - MARGIN * 2;
/** Archetype row: label left, name right, at this size with this gap between them. */
export const ROW_SIZE = 52;
export const ROW_GAP = 40;

/**
 * Fonts are the one thing that can make this non-deterministic ACROSS machines.
 *
 * Within a machine the render is byte-identical, which is what the Definition of Done
 * asks for and what `render.test.ts` asserts. Across machines it is identical only if
 * the font set is — so production must pin a container image rather than rely on
 * whatever the host happens to have installed. Recorded in NOTES.md; the fallback list
 * is ordered so a Linux image without Helvetica still lands somewhere sensible.
 */
const FONT_STACK = "Helvetica, Arial, DejaVu Sans, Liberation Sans, sans-serif";

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}

type Text = {
  x: number;
  y: number;
  size: number;
  weight?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  letterSpacing?: number;
  content: string;
};

/**
 * Greedy word wrap by estimated width.
 *
 * resvg gives no text-measurement API and SVG has no auto-wrapping, so a long line
 * simply runs off the canvas — which is what the first render of the caption did:
 * "…went quiet this yea" with the r past the right edge. Estimating from the font size
 * is crude but it is bounded and deterministic, and the alternative is shipping a
 * layout that silently truncates the one sentence the card exists to say.
 *
 * 0.52em per character is measured against Helvetica at these sizes; the constant is
 * deliberately generous so a wider fallback font still fits inside the margin.
 */
/**
 * Estimated rendered width.
 *
 * Weight matters, and getting that wrong is what produced the second bad render:
 * "one-way enthusiasm" is 18 characters, and at the regular-weight constant it was
 * estimated 487px wide when the BOLD label actually draws about 560px — so the name
 * beside it was given 70px more room than existed and printed over the last two
 * letters. Bold is roughly 0.60em per character against Helvetica at these sizes.
 */
const EM_REGULAR = 0.52;
const EM_BOLD = 0.6;

export function estimateWidth(content: string, fontSize: number, weight = 400): number {
  return content.length * fontSize * (weight >= 700 ? EM_BOLD : EM_REGULAR);
}

/**
 * Truncate to fit a width budget, with an ellipsis.
 *
 * `MAX_NAME_CHARS` in model.ts bounds a name to 18 characters, which is NOT enough on
 * its own: the row also holds a left-anchored label, and "the one you keep waiting" is
 * 24 characters. An 18-character name beside it needs 1136px of an 888px row, and the
 * first render of a 40-character name drew the name straight through the label. The
 * budget has to be computed per row, from what the label actually leaves behind.
 */
export function fitToWidth(content: string, fontSize: number, maxWidth: number): string {
  if (estimateWidth(content, fontSize) <= maxWidth) return content;
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * EM_REGULAR)) - 1);
  return `${content.slice(0, maxChars)}…`;
}

export function wrapByWidth(content: string, fontSize: number, maxWidth: number): string[] {
  const perChar = fontSize * EM_REGULAR;
  const maxChars = Math.max(1, Math.floor(maxWidth / perChar));
  const lines: string[] = [];
  let line = "";
  for (const word of content.split(/\s+/)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    line = word;
  }
  if (line !== "") lines.push(line);
  return lines;
}

function text(t: Text): string {
  const attrs = [
    `x="${t.x}"`,
    `y="${t.y}"`,
    `font-family="${FONT_STACK}"`,
    `font-size="${t.size}"`,
    `font-weight="${t.weight ?? 400}"`,
    `fill="${t.fill ?? "#f5f3ef"}"`,
    `text-anchor="${t.anchor ?? "start"}"`,
    t.letterSpacing !== undefined ? `letter-spacing="${t.letterSpacing}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text ${attrs}>${escapeXml(t.content)}</text>`;
}

/** The SVG. Exported so tests can assert on content without decoding a PNG. */
export function cardSvg(model: CardModel): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#0d0d0f"/>`,
    `<rect x="0" y="0" width="${CARD_WIDTH}" height="8" fill="#e8623c"/>`,
  ];

  if (model.kind === "refusal") {
    // The honest alternative. Same frame, no invented numbers, and it says what would
    // make it work — a reveal without a remedy is just guilt.
    parts.push(
      text({ x: 96, y: 380, size: 64, weight: 700, content: THIN_TITLE }),
      ...THIN_BODY.flatMap((line) => wrapByWidth(line, 44, CONTENT_WIDTH)).map((line, i) =>
        text({ x: 96, y: 500 + i * 64, size: 44, fill: "#b9b4ac", content: line }),
      ),
      text({ x: 96, y: 700, size: 36, fill: "#8a857e", content: THIN_HINT }),
      text({ x: 96, y: CARD_HEIGHT - 96, size: 40, weight: 700, fill: "#e8623c", content: FOOTER }),
      "</svg>",
    );
    return parts.join("");
  }

  parts.push(
    text({ x: 96, y: 220, size: 40, fill: "#8a857e", letterSpacing: 6, content: CARD_TITLE }),
    // The judgmental number, at the size that makes it the thing people quote.
    text({ x: 96, y: 620, size: 300, weight: 700, content: model.headline }),
    ...wrapByWidth(model.caption, 46, CONTENT_WIDTH).map((line, i) =>
      text({ x: 96, y: 720 + i * 60, size: 46, fill: "#b9b4ac", content: line }),
    ),
  );

  let y = 990;
  for (const a of model.archetypes) {
    // What the label leaves for the name, minus a gap so they never touch.
    // The label is bold; the name is not. Measured with the right constant for each.
    const nameBudget = CONTENT_WIDTH - estimateWidth(a.label, ROW_SIZE, 700) - ROW_GAP;
    const name = fitToWidth(a.display, ROW_SIZE, Math.max(nameBudget, ROW_SIZE));
    parts.push(
      `<rect x="${MARGIN}" y="${y - 54}" width="${CONTENT_WIDTH}" height="2" fill="#26262b"/>`,
      text({ x: MARGIN, y: y + 20, size: ROW_SIZE, weight: 700, content: a.label }),
      text({
        x: CARD_WIDTH - MARGIN,
        y: y + 20,
        size: ROW_SIZE,
        anchor: "end",
        fill: "#e8623c",
        content: name,
      }),
      text({ x: MARGIN, y: y + 76, size: 36, fill: "#8a857e", content: a.line }),
    );
    y += 195;
  }

  parts.push(
    text({ x: 96, y: CARD_HEIGHT - 96, size: 40, weight: 700, fill: "#e8623c", content: FOOTER }),
    "</svg>",
  );
  return parts.join("");
}

export type RenderResult = { png: Buffer; model: CardModel; svg: string };

export function renderCard(digest: Digest): RenderResult {
  const model = buildCardModel(digest);
  const svg = cardSvg(model);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_WIDTH },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  });
  return { png: Buffer.from(resvg.render().asPng()), model, svg };
}
