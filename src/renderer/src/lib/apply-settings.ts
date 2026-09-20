import { useSyncExternalStore } from "react";
import { resolveTheme, type ResolvedTheme } from "../../../shared/contracts";
import {
  diffLineHeightPx,
  SETTINGS_DEFAULTS,
  type ResolvedSettings,
} from "../../../shared/settings";

// Where settings meet the document. The store decides *what* the settings are; this module is
// the one place that turns a resolved record into DOM state — the theme attributes on <html>
// and the custom properties the diff's shadow roots read — so nothing else in the renderer
// touches either. Every line here is a DOM write, or a read of what was written ("Reading it
// back", below), which is why it is untested (the suite has no DOM) and why the store takes
// `applySettings` as an injected function rather than importing it.

/** Apply the resolved theme to <html>: `data-theme` selects the chrome + diff-signal token block,
 * the `.dark` class drives Tailwind's dark variant, color-scheme, and the shadow-DOM diff consumers.
 * Instant by design — transitions are suppressed around the swap so a theme change never animates. */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.add("no-transitions");
  root.dataset.theme = resolved.id;
  root.classList.toggle("dark", resolved.appearance === "dark");
  // Resolve styles now so the swap is committed before transitions come back.
  void getComputedStyle(root).backgroundColor;
  requestAnimationFrame(() => root.classList.remove("no-transitions"));
}

/** The diff's typography, as custom properties on <html>. Pierre's shadow roots inherit them
 * (`--diffs-*`, see index.css), and `--code-font` is the hook `design/globals.css` leaves in the
 * `--font-mono` token so every `font-mono` surface follows the same choice.
 *
 * Set as inline style rather than a stylesheet because inline is what outranks the `:root`
 * declarations in index.css without a specificity contest. The font family is *removed* rather
 * than set when it is the default: the token's own fallback is Geist Mono already, and leaving
 * the property absent is what keeps a fresh install's rendering byte-identical to before. */
function applyTypography(resolved: ResolvedSettings): void {
  const style = document.documentElement.style;
  if (resolved.diffFontFamily === SETTINGS_DEFAULTS.diffFontFamily) {
    style.removeProperty("--code-font");
  } else {
    style.setProperty("--code-font", resolved.diffFontFamily);
  }
  style.setProperty("--diffs-font-size", `${resolved.diffFontSize}px`);
  style.setProperty("--diffs-line-height", `${diffLineHeightPx(resolved)}px`);
  style.setProperty("--diffs-tab-size", String(resolved.diffTabSize));
  // `normal` is the browser's own default (liga and calt on); the off form names both
  // features, since a font may put its joins under either.
  style.setProperty(
    "--diffs-font-features",
    resolved.diffLigatures ? "normal" : '"liga" 0, "calt" 0',
  );
}

/** Everything the document has to reflect. The theme is only touched when it changed: its
 * apply suppresses transitions for a frame, which a font-size change has no reason to do. */
export function applySettings(next: ResolvedSettings, previous: ResolvedSettings | null): void {
  if (previous === null || previous.theme !== next.theme) {
    applyResolvedTheme(resolveTheme(next.theme));
  }
  applyTypography(next);
}

// ── Reading it back ─────────────────────────────────────────────────────────────────────
// A consumer that cannot inherit CSS has to be *told* the palette: mermaid computes a
// diagram's colours in JavaScript and bakes them into the SVG's own <style>, so `var(--border)`
// is no use to it. Those consumers read what this module applied, from here, rather than
// keeping a palette of their own — the write and the read-back are one module so that "which
// theme is in force" has one answer.

/** The theme id on <html> right now — what `applyResolvedTheme` last wrote. Empty before the
 * first apply, which `main.tsx` runs ahead of the first render. */
export function appliedThemeId(): string {
  return document.documentElement.dataset.theme ?? "";
}

/** Whether the document renders dark right now. The non-hook form of `useEffectiveDark`. */
export function appliedDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Palette tokens (`design/globals.css` names, without the `--`) as `#rrggbb`, whatever they
 * were written as. Half the palette is `oklch()`, and neither route that looks cheaper gives
 * a plain colour back: `getPropertyValue` answers the token's text as authored, and a probe
 * element's computed `color` keeps the colour space (`oklch(0.97 0 0)` again). So each token
 * is painted onto one canvas pixel and the pixel is read — the browser's own parser and its
 * own gamut mapping, in sRGB bytes.
 *
 * A token is left out of the answer rather than guessed at when it is missing, when the
 * canvas declines it (an invalid `fillStyle` assignment is *silently ignored*, so it is
 * assigned over two different sentinels: a real colour reads back the same both times, a
 * rejected one reads back each sentinel), or when it is not opaque, since a translucent
 * token has no single colour to report. */
export function readPalette<T extends string>(tokens: readonly T[]): Partial<Record<T, string>> {
  const context = document
    .createElement("canvas")
    // Read back four bytes at a time: keep the pixel on the CPU.
    .getContext("2d", { willReadFrequently: true });
  const colors: Partial<Record<T, string>> = {};
  if (context === null) {
    return colors;
  }
  const computed = getComputedStyle(document.documentElement);
  for (const token of tokens) {
    const authored = computed.getPropertyValue(`--${token}`).trim();
    context.fillStyle = "#000000";
    context.fillStyle = authored;
    const overBlack = context.fillStyle;
    context.fillStyle = "#ffffff";
    context.fillStyle = authored;
    if (authored === "" || context.fillStyle !== overBlack) {
      continue;
    }
    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    if (alpha === 255) {
      colors[token] =
        `#${[red, green, blue].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return colors;
}

/** The OS's light/dark preference right now — the seed for the theme until one is chosen. */
export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function subscribeToRootClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** True while the shell renders dark. The `.dark` class is the single render-side truth (applied by
 * `applySettings` in both the Electron and browser-gate paths), so consumers that cannot inherit
 * CSS — the shadow-DOM diff surface — follow it here. */
export function useEffectiveDark(): boolean {
  return useSyncExternalStore(subscribeToRootClass, () =>
    document.documentElement.classList.contains("dark"),
  );
}
