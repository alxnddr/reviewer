import {
  preloadHighlighter,
  type DiffsThemeNames,
  type HighlighterTypes,
  type SupportedLanguages,
  type ThemesType,
} from "@pierre/diffs";
import type { ThemeId } from "../../../../shared/contracts";
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES } from "../../../../shared/themes.generated";

function shikiThemeFor(id: string): DiffsThemeNames {
  const meta = THEMES.find((theme) => theme.id === id);
  if (meta === undefined) {
    throw new Error(`no curated theme "${id}" in the generated set`);
  }
  return meta.shikiTheme;
}

/** The diff surface's boot theme pair — the default light/dark themes. The pool boots on it
 * and keeps it until a theme is chosen; the per-view themeType picks a side by the .dark class in the
 * meantime. Switching to any curated theme then goes through the pool's setRenderOptions. */
export const DEFAULT_DIFF_THEME: ThemesType = {
  light: shikiThemeFor(DEFAULT_LIGHT),
  dark: shikiThemeFor(DEFAULT_DARK),
};

/** The Shiki pair for a chosen theme — both sides set to its own theme, so a view's themeType lands on
 * it whichever side the .dark class picks. Null (pre-hydration) boots on the default pair; an unknown
 * id falls back to it too. Shared by the pool sync (which pushes it onto the workers as the tokenizing
 * theme) and the diff view (which mirrors it into its per-view options purely to force a re-render on a
 * same-appearance switch — see DiffView). */
export function activeDiffThemePair(selection: ThemeId | null): ThemesType {
  const shiki =
    selection === null ? undefined : THEMES.find((theme) => theme.id === selection)?.shikiTheme;
  return shiki === undefined ? DEFAULT_DIFF_THEME : { light: shiki, dark: shiki };
}

/** Every distinct Pierre/Shiki theme the curated set can render the diff in — preloaded up front so a
 * theme switch resolves from the warm cache with no async colour-in flash. */
export const ALL_DIFF_THEMES: DiffsThemeNames[] = [
  ...new Set(THEMES.map((theme) => theme.shikiTheme)),
];

/** The pure-JS shiki engine (the library default), pinned deliberately, not an
 * implicit fallback: no wasm blob and no CSP surface, unlike `shiki-wasm`. Every
 * highlight path — pool init, worker render, warm-up — reads this one. */
export const HIGHLIGHT_ENGINE: HighlighterTypes = "shiki-js";

/** Grammars Reviewer's own diffs surface — it is a TS / React / Tailwind repo. Warmed at
 * pool init so the first diff of each paints coloured, with no resolve-then-colour flash.
 * Deliberately narrow: an unlisted language still highlights (its grammar is resolved on
 * first view and cached), it just flashes once; warming every bundled grammar would bloat
 * startup for languages this app never shows. */
export const CORE_HIGHLIGHT_LANGUAGES: SupportedLanguages[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "css",
  "markdown",
];

/** Primes the shared main-thread highlighter singleton — the resolution cache the pool later
 * reuses — a render tick before the pool would warm it itself, by kicking the theme + core-
 * grammar imports off at module load. It does NOT colour the diffs (the workers do that, seeded
 * separately by the pool's `langs`); it only gives the shared cache a head start. Fire-and-forget
 * by nature, but a rejection is surfaced, never swallowed as success: a broken grammar/theme
 * import is a real defect that must stay visible, not hide behind a silently-uncoloured diff. */
export function warmHighlighter(): void {
  void preloadHighlighter({
    themes: ALL_DIFF_THEMES,
    langs: CORE_HIGHLIGHT_LANGUAGES,
    preferredHighlighter: HIGHLIGHT_ENGINE,
  }).catch((error: unknown) => {
    console.error(
      "Highlighter warm-up failed; diffs fall back to per-view grammar resolution.",
      error,
    );
  });
}
