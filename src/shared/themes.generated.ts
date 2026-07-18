// Runtime source of truth for the curated theme set: ids, labels, appearance, the
// Pierre/Shiki diff theme name, and the pre-paint window background (chrome bg, hex for Electron).
// Kept in sync with design/globals.css.

export type ThemeAppearance = "light" | "dark";

/** Every curated theme id, as a literal tuple — the zod ThemeId enum derives from it. */
export const THEME_IDS = [
  "pierre-light",
  "pierre-dark",
  "github-light",
  "github-dark",
  "dracula",
  "nord",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export type ThemeMeta = {
  readonly id: ThemeId;
  readonly label: string;
  readonly appearance: ThemeAppearance;
  readonly shikiTheme: string;
  readonly windowBackground: string;
};

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "pierre-light",
    label: "Pierre Light",
    appearance: "light",
    shikiTheme: "pierre-light",
    windowBackground: "#fafafa",
  },
  {
    id: "pierre-dark",
    label: "Pierre Dark",
    appearance: "dark",
    shikiTheme: "pierre-dark",
    windowBackground: "#141414",
  },
  {
    id: "github-light",
    label: "GitHub Light",
    appearance: "light",
    shikiTheme: "github-light",
    windowBackground: "#ffffff",
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    appearance: "dark",
    shikiTheme: "github-dark",
    windowBackground: "#24292e",
  },
  {
    id: "dracula",
    label: "Dracula",
    appearance: "dark",
    shikiTheme: "dracula",
    windowBackground: "#282a36",
  },
  {
    id: "nord",
    label: "Nord",
    appearance: "dark",
    shikiTheme: "nord",
    windowBackground: "#2e3440",
  },
];

/** Seeded on first run at OS light / dark, before the user picks a theme. */
export const DEFAULT_LIGHT: ThemeId = "pierre-light";
export const DEFAULT_DARK: ThemeId = "pierre-dark";
