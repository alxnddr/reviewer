import { describe, expect, it } from "vitest";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { bundledLanguages } from "shiki";
import {
  activeDiffThemePair,
  ALL_DIFF_THEMES,
  CORE_HIGHLIGHT_LANGUAGES,
  DEFAULT_DIFF_THEME,
  HIGHLIGHT_ENGINE,
} from "./highlight-warmup";
import { THEMES } from "../../../../shared/themes";
import { ThemeId } from "../../../../shared/contracts";

// One representative file per format Reviewer's own diffs surface. `.ts` leads: it is
// the reported "no highlighting" symptom — the root cause was never that `.ts` fails to
// resolve (it maps to a real, bundled `typescript` grammar, asserted below) but that the
// pool booted knowing only `text`, so the warm set must actually contain what these map to.
const APP_SURFACE_FILES = [
  { name: "src/lib/diff/patch.ts", grammar: "typescript" },
  { name: "src/components/DiffView.tsx", grammar: "tsx" },
  { name: "electron.vite.config.js", grammar: "javascript" },
  { name: "src/legacy/widget.jsx", grammar: "jsx" },
  { name: "package.json", grammar: "json" },
  { name: "src/renderer/assets/main.css", grammar: "css" },
  { name: "README.md", grammar: "markdown" },
];

describe("highlight warm-up set", () => {
  it("resolves every app-surface file to a real, bundled shiki grammar", () => {
    for (const { name, grammar } of APP_SURFACE_FILES) {
      expect(getFiletypeFromFileName(name)).toBe(grammar);
      expect(Object.prototype.hasOwnProperty.call(bundledLanguages, grammar)).toBe(true);
    }
  });

  it("warms exactly the grammars those files map to — no missing surface, no dead breadth", () => {
    const surfaceGrammars = new Set(APP_SURFACE_FILES.map(({ grammar }) => grammar));
    expect(new Set(CORE_HIGHLIGHT_LANGUAGES)).toEqual(surfaceGrammars);
  });

  it("lists each core grammar once and as a genuinely bundled language", () => {
    expect(new Set(CORE_HIGHLIGHT_LANGUAGES).size).toBe(CORE_HIGHLIGHT_LANGUAGES.length);
    for (const lang of CORE_HIGHLIGHT_LANGUAGES) {
      expect(Object.prototype.hasOwnProperty.call(bundledLanguages, lang)).toBe(true);
    }
  });

  it("boots on the Pierre default pair and the pure-JS engine", () => {
    expect(DEFAULT_DIFF_THEME).toEqual({ light: "pierre-light", dark: "pierre-dark" });
    expect(HIGHLIGHT_ENGINE).toBe("shiki-js");
  });

  it("preloads every curated theme's diff surface once — the switch cache is warm, no dead breadth", () => {
    expect(new Set(ALL_DIFF_THEMES)).toEqual(new Set(THEMES.map((theme) => theme.shikiTheme)));
    expect(new Set(ALL_DIFF_THEMES).size).toBe(ALL_DIFF_THEMES.length);
  });
});

describe("activeDiffThemePair", () => {
  it("boots on the default pair before a theme is chosen", () => {
    expect(activeDiffThemePair(null)).toEqual(DEFAULT_DIFF_THEME);
  });

  it("sets both sides to a chosen theme's own shiki theme, so themeType lands on it either way", () => {
    for (const theme of THEMES) {
      expect(activeDiffThemePair(theme.id)).toEqual({
        light: theme.shikiTheme,
        dark: theme.shikiTheme,
      });
    }
  });

  // The crux of the same-appearance switch fix: distinct themes must yield distinct pairs so
  // CodeView's per-view options compare unequal and the mounted view re-renders. Two dark themes
  // (identical themeType) is exactly the case Pierre's onThemeChange fails to repaint on its own.
  it("gives distinct same-appearance themes distinct pairs", () => {
    const dark = THEMES.filter((theme) => theme.appearance === "dark");
    expect(dark.length).toBeGreaterThanOrEqual(2);
    const pairs = dark.map((theme) => activeDiffThemePair(theme.id).dark);
    expect(new Set(pairs).size).toBe(dark.length);
  });

  it("falls back to the default pair for an id outside the curated set", () => {
    expect(activeDiffThemePair("not-a-theme" as ThemeId)).toEqual(DEFAULT_DIFF_THEME);
  });
});
