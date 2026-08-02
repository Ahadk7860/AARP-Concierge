// Real text measurement, from the renderer that will draw it.
//
// WHY THIS REPLACED AN ESTIMATE.
//
// The first version of this card computed width as `length × fontSize × constant` and
// tested the layout by recomputing that same formula. `fitToWidth` truncated to fit the
// budget the estimate produced, and the test asserted the result fit that budget — so
// the inequality held by construction and the test could not fail. It stayed green
// while "the one you keep waiting" left 99px for the name and the flagship card
// rendered `Ma… — the one you keep waiting`.
//
// An estimate also cannot be right for text it has never seen. `length × constant`
// treats one CJK glyph as one Latin character and all-caps as lowercase, so both
// overflow silently rather than truncating.
//
// So: rasterise a probe and measure the ink. resvg exposes neither `getBBox` nor a
// text-metrics API — both return `{}` — but `render().pixels` is the real RGBA buffer,
// and the rightmost non-transparent column is the real advance width, in the real font,
// at the real weight.

import { Resvg } from "@resvg/resvg-js";

export const FONT_STACK = "Helvetica, Arial, DejaVu Sans, Liberation Sans, sans-serif";

/** Wide enough that nothing the card draws can reach the edge and be clipped. */
const PROBE_WIDTH = 4000;

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}

const cache = new Map<string, number>();

/**
 * The rendered width of `content`, in pixels, measured rather than guessed.
 *
 * Memoised: the card draws a dozen strings and a probe costs a small raster, but the
 * name-overflow tests measure hundreds, so the cache is what keeps this cheap.
 */
export function measureTextWidth(content: string, fontSize: number, weight = 400): number {
  if (content.length === 0) return 0;
  const key = `${weight}|${fontSize}|${content}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const height = Math.ceil(fontSize * 2);
  const baseline = Math.ceil(fontSize * 1.4);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PROBE_WIDTH}" height="${height}">` +
    `<text x="0" y="${baseline}" font-family="${FONT_STACK}" font-size="${fontSize}" ` +
    `font-weight="${weight}" fill="#ffffff">${escapeXml(content)}</text></svg>`;

  const image = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  }).render();

  const { pixels, width: w, height: h } = { pixels: image.pixels, width: image.width, height: image.height };
  let rightmost = -1;
  // Alpha is every fourth byte. Scanning right-to-left and stopping at the first row
  // that has ink at column x would be faster, but this runs a dozen times per card.
  for (let y = 0; y < h; y += 1) {
    for (let x = w - 1; x > rightmost; x -= 1) {
      if (pixels[(y * w + x) * 4 + 3]! > 0) {
        rightmost = x;
        break;
      }
    }
  }

  const measured = rightmost + 1;
  cache.set(key, measured);
  return measured;
}

/**
 * Truncate until it MEASURES within `maxWidth`, ellipsis included.
 *
 * Binary search on the character count, then a linear walk back, because the ellipsis
 * itself has width and a proportional font gives no closed form for "how many
 * characters fit". Slicing by code point rather than by UTF-16 unit, so a truncated
 * emoji or a surrogate pair cannot become half a character.
 */
export function fitToMeasuredWidth(
  content: string,
  fontSize: number,
  maxWidth: number,
  weight = 400,
): string {
  if (measureTextWidth(content, fontSize, weight) <= maxWidth) return content;

  const chars = [...content];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join("")}…`;
    if (measureTextWidth(candidate, fontSize, weight) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  // Even a bare ellipsis may not fit. Returning it anyway would draw outside the
  // margin, so an empty string is the honest answer — and the layout is wrong if it
  // ever happens, which is what `card.test.ts` asserts.
  if (lo === 0) return measureTextWidth("…", fontSize, weight) <= maxWidth ? "…" : "";
  return `${chars.slice(0, lo).join("")}…`;
}

/** Greedy word wrap, measured. Words longer than the line are truncated, not spilled. */
export function wrapMeasured(
  content: string,
  fontSize: number,
  maxWidth: number,
  weight = 400,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of content.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (measureTextWidth(candidate, fontSize, weight) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    line = measureTextWidth(word, fontSize, weight) <= maxWidth
      ? word
      : fitToMeasuredWidth(word, fontSize, maxWidth, weight);
  }
  if (line !== "") lines.push(line);
  return lines;
}
