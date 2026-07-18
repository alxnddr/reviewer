import * as z from "zod";
import { DEFAULT_DARK, DEFAULT_LIGHT, THEME_IDS, THEMES } from "./themes.generated";
import type { ThemeAppearance } from "./themes.generated";

export type { ThemeAppearance } from "./themes.generated";

/** The persisted theme choice: one curated theme, validated against the generated set. The whole app
 * is themed by picking one of these — there is no separate light/dark/system mode. Its
 * inferred type is the same literal union as the generated ThemeId. */
export const ThemeId = z.enum(THEME_IDS);
export type ThemeId = z.infer<typeof ThemeId>;

export type ResolvedTheme = {
  readonly id: ThemeId;
  readonly appearance: ThemeAppearance;
};

/** The theme to render before the user has ever chosen one: the OS's light/dark preference maps to
 * the designated default of that appearance. A one-time seed, not a mode — once chosen the pick is a
 * concrete theme that ignores later OS changes. */
export function defaultTheme(systemDark: boolean): ThemeId {
  return systemDark ? DEFAULT_DARK : DEFAULT_LIGHT;
}

/** Resolve a theme id to its appearance. A stale id — one persisted before the curated set changed —
 * falls back to the light default rather than leaving the app unthemed; a validated id always hits. */
export function resolveTheme(id: ThemeId): ResolvedTheme {
  const meta =
    THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_LIGHT);
  if (meta === undefined) {
    throw new Error("theme set is missing its default light theme");
  }
  return { id: meta.id, appearance: meta.appearance };
}
