import * as z from "zod";
import { defaultTheme, EditorChoice, ThemeId } from "./contracts";

// The app's settings: the reader's own choices, as opposed to a session's state. This module is
// the contract every side agrees on — main persists exactly this shape, the IPC rows for
// `settings:get` / `settings:set` validate against it, and the renderer's store is `z.infer` of
// it — so a setting added here is visible to all three at once, and one added anywhere else is
// a compile error somewhere.
//
// Two shapes, deliberately. `Settings` is what is *stored*: every key optional, absent meaning
// "never chosen". `ResolvedSettings` is what is *applied*: every key present, the absent ones
// filled from `resolveSettings`. Persisting only the choices — the session.ts inputs-not-derived
// precedent — is what lets a default change in a later build reach every reader who never
// touched that setting, and what lets the settings dialog know which rows to offer a reset on.
// Writing resolved values to disk would freeze today's defaults into every settings file.
//
// Every key is salvaged on its own rather than the object as a whole: `settings.json` is hand-
// editable, and a font size typed as `"big"` must cost the reader that one setting, not their
// theme and everything else in the file. `.catch(undefined)` turns an unreadable value back
// into "never chosen" for that key alone. A non-object file still fails whole, which
// `parseSettings` in main answers with the empty object.

/** The bounds a number setting is clamped to, shared by the schema and the dialog's stepper
 * so the two cannot disagree about what a legal value is. */
export type NumberRange = { readonly min: number; readonly max: number; readonly step: number };

/** Pierre lays the diff out on a 13px register; 8 is the smallest a monospace glyph still
 * reads at, 32 the largest before a split diff shows nothing but a few tokens per row. */
export const DIFF_FONT_SIZE: NumberRange = { min: 8, max: 32, step: 1 };
/** A multiplier of the font size, not a pixel height, so a bigger font keeps its proportions
 * without a second edit. 1 is glyphs touching; 3 is triple-spaced. */
export const DIFF_LINE_HEIGHT: NumberRange = { min: 1, max: 3, step: 0.1 };
/** How wide a tab character renders. 8 is what `git diff` itself assumes; 1 is the floor CSS
 * `tab-size` accepts. */
export const DIFF_TAB_SIZE: NumberRange = { min: 1, max: 8, step: 1 };

/** A free-form CSS font-family list, as the reader types it: `JetBrains Mono` or
 * `"Fira Code", Menlo`. Applied *ahead of* the bundled fallback stack, never instead of it, so
 * a name that is not installed costs nothing — the diff falls through to Geist Mono. The cap
 * is there because the value is interpolated into a style property; it is not a security
 * boundary (a custom property cannot escape its declaration), just a guard against a pasted
 * paragraph. */
const FontFamily = z.string().trim().min(1).max(200);

/** A number that must survive a hand edit: a stored value outside the range is a value the
 * dialog could never have written, so it reads as "never chosen" rather than as a clamp. */
function bounded(range: NumberRange) {
  return (range.step === 1 ? z.int() : z.number()).min(range.min).max(range.max);
}

/** Absent, or unreadable, both mean "never chosen" — for this key only. */
function choice<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

export const Settings = z.object({
  /** One curated theme. Absent until first picked; the OS preference seeds the default. */
  theme: choice(ThemeId),
  /** Whether the changed-files tree draws a run of single-child folders as one row
   * (`src/renderer/src/lib`) instead of one row per folder. On is the tree library's own
   * default and costs vertical space nowhere; off costs rows but keeps every name legible in
   * a narrow rail, where a long chain is ellipsified into something no reader can parse. */
  fileTreeFlattenFolders: choice(z.boolean()),
  /** The code font: the diff, and every other surface that quotes code (snippets in the
   * comments rail, inline code in a comment). One font, so a quoted line looks like the line
   * it quotes. */
  diffFontFamily: choice(FontFamily),
  diffFontSize: choice(bounded(DIFF_FONT_SIZE)),
  diffLineHeight: choice(bounded(DIFF_LINE_HEIGHT)),
  diffTabSize: choice(bounded(DIFF_TAB_SIZE)),
  /** Whether the code font may join glyphs (`=>`, `!==`). Off is the honest rendering of a
   * diff — a ligature can hide which character actually changed. */
  diffLigatures: choice(z.boolean()),
  /** Wrap long lines in place of a horizontal scrollbar. */
  diffWrap: choice(z.boolean()),
  /** Where Open in Editor sends a file (`shared/editors.ts`). `none` is a value rather than an
   * absent key because the controls that use it are always drawn: they read the resolved
   * record and need one answer — disabled, and why — until an editor is picked. */
  editor: choice(EditorChoice),
});
export type Settings = z.infer<typeof Settings>;

/** A change to some settings: a key set to `undefined` is a reset to the default, which is
 * the one thing `Partial<Settings>` cannot say under `exactOptionalPropertyTypes`. */
export type SettingsPatch = { [Key in keyof Settings]?: Settings[Key] | undefined };

export const SETTING_KEYS = Object.keys(Settings.shape) as readonly (keyof Settings)[];

/** The settings with `patch` applied. A reset (`undefined`) removes the key rather than
 * storing `undefined`, so what is persisted is only ever the choices that were made. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = { ...current };
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) {
      continue;
    }
    const value = patch[key];
    if (value === undefined) {
      delete next[key];
    } else {
      // The catalog of keys is closed and each branch of the union is written by the dialog
      // against its own key, so the assignment is sound; the cast is what TypeScript needs to
      // write one loop instead of eight identical statements.
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/** Every setting, decided: what the app actually applies. */
export type ResolvedSettings = {
  readonly [Key in keyof Settings]-?: Exclude<Settings[Key], undefined>;
};

/** The values a fresh install runs on. `theme` is not here because its default is not a
 * constant — it follows the OS until the reader picks one (`resolveSettings`). */
export const SETTINGS_DEFAULTS: Omit<ResolvedSettings, "theme"> = {
  // Geist Mono, spelled the way the bundled stack spells it in design/globals.css. The
  // renderer treats this exact value as "not overridden" and leaves the stylesheet alone,
  // which is what keeps the fresh-install rendering byte-identical to the one before this
  // setting existed.
  diffFontFamily: "Geist Mono",
  // Pierre's own register: 13px on 20px rows (1.5 × 13 rounds to 20), two-column tabs.
  diffFontSize: 13,
  diffLineHeight: 1.5,
  diffTabSize: 2,
  diffLigatures: true,
  diffWrap: false,
  editor: "none",
  // What the tree did before it was a setting, and what `@pierre/trees` does when told
  // nothing: a chain of empty folders is one row.
  fileTreeFlattenFolders: true,
};

/** Fills every unchosen key. `systemDark` is an input rather than read here so this stays a
 * pure function the renderer, main and the tests can all call. */
export function resolveSettings(
  settings: Settings,
  env: { systemDark: boolean },
): ResolvedSettings {
  return {
    theme: settings.theme ?? defaultTheme(env.systemDark),
    diffFontFamily: settings.diffFontFamily ?? SETTINGS_DEFAULTS.diffFontFamily,
    diffFontSize: settings.diffFontSize ?? SETTINGS_DEFAULTS.diffFontSize,
    diffLineHeight: settings.diffLineHeight ?? SETTINGS_DEFAULTS.diffLineHeight,
    diffTabSize: settings.diffTabSize ?? SETTINGS_DEFAULTS.diffTabSize,
    diffLigatures: settings.diffLigatures ?? SETTINGS_DEFAULTS.diffLigatures,
    diffWrap: settings.diffWrap ?? SETTINGS_DEFAULTS.diffWrap,
    editor: settings.editor ?? SETTINGS_DEFAULTS.editor,
    fileTreeFlattenFolders:
      settings.fileTreeFlattenFolders ?? SETTINGS_DEFAULTS.fileTreeFlattenFolders,
  };
}

/** The row height the diff renders at, in pixels: the multiplier applied to the font size and
 * rounded, because Pierre's virtualizer estimates rows in whole pixels and a fractional line
 * height drifts its scroll math against the measured DOM. */
export function diffLineHeightPx(
  resolved: Pick<ResolvedSettings, "diffFontSize" | "diffLineHeight">,
): number {
  return Math.round(resolved.diffFontSize * resolved.diffLineHeight);
}
