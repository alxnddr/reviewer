import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_IDS, THEMES } from "./themes";

// Guards the seam between design/globals.css (chrome + diff-signal CSS) and themes.ts
// (runtime metadata): a theme the menu offers but the CSS can't paint fails here instead of shipping.
// Nothing generates either file, so this test is the only thing holding the two halves together.
const GLOBALS = readFileSync(
  fileURLToPath(new URL("../../design/globals.css", import.meta.url)),
  "utf8",
);

const DIFF_TOKENS = [
  "--diff-surface",
  "--diff-add-bg",
  "--diff-del-bg",
  "--diff-add-fg",
  "--diff-del-fg",
];

const THEME_BLOCK_HEAD = /^html\[data-theme="(?<id>[^"]+)"\] \{/gmu;
const BACKGROUND_DECL = /^\s*--background:\s*(?<value>[^;]+);/mu;
const HEX_COLOR = /^#(?<digits>[\da-f]{6})$/iu;
const OKLCH_COLOR = /^oklch\(\s*(?<l>[\d.]+)(?<pct>%?)\s+(?<c>[\d.]+)\s+(?<h>[\d.]+)\s*\)$/u;

/** The body of a theme's `html[data-theme]` block, up to its closing brace. */
function themeBlock(id: string): string {
  const start = GLOBALS.indexOf(`html[data-theme="${id}"] {`);
  expect(start, `no html[data-theme="${id}"] block`).not.toBe(-1);
  return GLOBALS.slice(start, GLOBALS.indexOf("\n}", start));
}

/** oklch → sRGB hex, per CSS Color 4 (OKLab's own matrices, then the sRGB transfer function).
 * Only the test needs this: the app never converts, it only needs to know that the hex it is
 * forced to duplicate (see src/main/theme.ts) is the colour the CSS actually paints. */
function oklchToHex(l: number, c: number, hueDegrees: number): string {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
  const digits = linear.map((channel) => {
    // Clamp before the transfer function, not after: a negative channel (out of the sRGB gamut)
    // would come back NaN from the fractional exponent instead of clipping to black.
    const clipped = Math.min(Math.max(channel, 0), 1);
    const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${digits.join("")}`;
}

/** The sRGB hex a `--background` declaration resolves to — the two colour forms globals.css uses. */
function cssColorToHex(css: string): string {
  const hex = HEX_COLOR.exec(css);
  if (hex !== null) {
    return `#${hex.groups!.digits!.toLowerCase()}`;
  }
  const oklch = OKLCH_COLOR.exec(css);
  if (oklch === null) {
    throw new Error(`--background is in a form this test cannot convert: ${css}`);
  }
  const { l, pct, c, h } = oklch.groups!;
  return oklchToHex(Number(l) / (pct === "%" ? 100 : 1), Number(c), Number(h));
}

describe("globals.css and themes.ts", () => {
  it("carries exactly one html[data-theme] block per curated theme, and none besides", () => {
    const inCss = [...GLOBALS.matchAll(THEME_BLOCK_HEAD)].map((match) => match.groups!.id!);
    expect(inCss.toSorted()).toEqual([...THEME_IDS].toSorted());
  });

  it("gives every id in THEME_IDS exactly one THEMES entry", () => {
    // THEME_IDS is what zod's ThemeId enum accepts off disk; THEMES is what every lookup reads.
    // An id in the first with no row in the second validates fine and then throws from
    // getWindowBackground, mid-createMainWindow — one list short of the CSS check above.
    expect(THEMES.map((theme) => theme.id).toSorted()).toEqual([...THEME_IDS].toSorted());
  });

  it("defines the full diff-signal set inside every theme block", () => {
    for (const theme of THEMES) {
      const block = themeBlock(theme.id);
      for (const token of DIFF_TOKENS) {
        expect(block).toContain(`${token}:`);
      }
      expect(block).toContain("--background:");
    }
  });

  it("pins every windowBackground to the --background its theme block paints", () => {
    // The flash-of-wrong-colour guard: Electron gets `windowBackground` before the first paint and
    // the CSS gets `--background` after it, so a drift between them is visible on every launch.
    for (const theme of THEMES) {
      const declared = BACKGROUND_DECL.exec(themeBlock(theme.id))?.groups?.value?.trim();
      expect(declared, `no --background in the ${theme.id} block`).toBeDefined();
      expect(cssColorToHex(declared!), theme.id).toBe(theme.windowBackground.toLowerCase());
    }
  });

  it("emits the shared Tailwind color mapping exactly once", () => {
    expect(GLOBALS.match(/^@theme inline \{/gmu)?.length).toBe(1);
  });
});
