// The 9:16 render. digest.v1 -> SVG -> PNG, server-side, identical for everyone.
//
// Server-side because the card is the acquisition loop: it gets screenshotted into a
// group chat, and every share has to look the same regardless of whose phone took the
// screenshot. A client-side render is a different card per device.
//
// EVERY WIDTH HERE IS MEASURED, NOT ESTIMATED. See measure.ts for why. The short
// version: the previous layout put a bold label and a name on one line, budgeted the
// name from `length × constant`, and rendered `Ma… — the one you keep waiting` on the
// project's own reference fixture while the test passed. The row is now stacked, so the
// name gets the full content width and nothing competes with it.

import { Resvg } from "@resvg/resvg-js";
import type { Digest } from "../../shared/src/index.js";
import { buildCardModel, type CardModel } from "./model.js";
import { CARD_TITLE, FOOTER, THIN_BODY, THIN_HINT, THIN_TITLE } from "./copy.js";
import { FONT_STACK, fitToMeasuredWidth, measureTextWidth, wrapMeasured } from "./measure.js";

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1920;
/** 96px margins either side. Every line is measured against this. */
export const MARGIN = 96;
export const CONTENT_WIDTH = CARD_WIDTH - MARGIN * 2;

export const NAME_SIZE = 56;
export const LABEL_SIZE = 40;
export const LINE_SIZE = 34;
export const CAPTION_SIZE = 46;
/** Starting size for the judgmental number. Stepped down if it ever fails to fit. */
export const HEADLINE_SIZE = 300;

const ROW_TOP = 900;
const ROW_PITCH = 215;

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
  letterSpacing?: number;
  content: string;
};

function text(t: Text): string {
  const attrs = [
    `x="${t.x}"`,
    `y="${t.y}"`,
    `font-family="${FONT_STACK}"`,
    `font-size="${t.size}"`,
    `font-weight="${t.weight ?? 400}"`,
    `fill="${t.fill ?? "#f5f3ef"}"`,
    t.letterSpacing !== undefined ? `letter-spacing="${t.letterSpacing}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text ${attrs}>${escapeXml(t.content)}</text>`;
}

/**
 * The judgmental number, at the largest size that fits.
 *
 * `40%` fits at 300 and so does `100%`, so this never fires today — but it was drawn at
 * a hard-coded 300 with no budget at all, which is the same class of bug as the row
 * that broke. A single number is the one thing on this card that must never be clipped.
 */
export function fitHeadline(content: string): { content: string; size: number } {
  let size = HEADLINE_SIZE;
  while (size > 80 && measureTextWidth(content, size, 700) > CONTENT_WIDTH) {
    size -= 10;
  }
  return { content, size };
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
    const body = THIN_BODY.flatMap((line) => wrapMeasured(line, 44, CONTENT_WIDTH));
    parts.push(
      ...wrapMeasured(THIN_TITLE, 64, CONTENT_WIDTH, 700).map((line, i) =>
        text({ x: MARGIN, y: 380 + i * 76, size: 64, weight: 700, content: line }),
      ),
      ...body.map((line, i) =>
        text({ x: MARGIN, y: 500 + i * 64, size: 44, fill: "#b9b4ac", content: line }),
      ),
      ...wrapMeasured(THIN_HINT, 36, CONTENT_WIDTH).map((line, i) =>
        text({ x: MARGIN, y: 700 + i * 48, size: 36, fill: "#8a857e", content: line }),
      ),
      text({ x: MARGIN, y: CARD_HEIGHT - 96, size: 40, weight: 700, fill: "#e8623c", content: FOOTER }),
      "</svg>",
    );
    return parts.join("");
  }

  const headline = fitHeadline(model.headline);
  parts.push(
    text({ x: MARGIN, y: 220, size: 40, fill: "#8a857e", letterSpacing: 6, content: CARD_TITLE }),
    text({ x: MARGIN, y: 620, size: headline.size, weight: 700, content: headline.content }),
    ...wrapMeasured(model.caption, CAPTION_SIZE, CONTENT_WIDTH).map((line, i) =>
      text({ x: MARGIN, y: 720 + i * 60, size: CAPTION_SIZE, fill: "#b9b4ac", content: line }),
    ),
  );

  // STACKED, not side by side. The name is the person and gets the whole width; the
  // archetype sits under it. Nothing on a row competes with anything else for space,
  // so a long label can no longer squeeze a name down to two characters.
  model.archetypes.forEach((a, i) => {
    const top = ROW_TOP + i * ROW_PITCH;
    parts.push(
      `<rect x="${MARGIN}" y="${top}" width="${CONTENT_WIDTH}" height="2" fill="#26262b"/>`,
      text({
        x: MARGIN,
        y: top + 72,
        size: NAME_SIZE,
        weight: 700,
        content: fitToMeasuredWidth(a.display, NAME_SIZE, CONTENT_WIDTH, 700),
      }),
      text({
        x: MARGIN,
        y: top + 128,
        size: LABEL_SIZE,
        fill: "#e8623c",
        content: fitToMeasuredWidth(a.label, LABEL_SIZE, CONTENT_WIDTH),
      }),
      text({
        x: MARGIN,
        y: top + 176,
        size: LINE_SIZE,
        fill: "#8a857e",
        content: fitToMeasuredWidth(a.line, LINE_SIZE, CONTENT_WIDTH),
      }),
    );
  });

  parts.push(
    text({ x: MARGIN, y: CARD_HEIGHT - 96, size: 40, weight: 700, fill: "#e8623c", content: FOOTER }),
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
