import type { EditorChoice, ThemeId } from "../../../shared/contracts";
import { EDITORS } from "../../../shared/editors";
import {
  DIFF_FONT_SIZE,
  DIFF_LINE_HEIGHT,
  DIFF_TAB_SIZE,
  type NumberRange,
  type Settings,
  type SettingsPatch,
} from "../../../shared/settings";
import { THEMES } from "../../../shared/themes";

// What the settings dialog shows, as data: every setting's row — its group, label, the sentence
// under it, and which control edits it. The dialog renders this and nothing else, so adding a
// setting is one entry here after its key in `shared/settings.ts`, and the test beside this file
// is what makes forgetting the entry a failure rather than an invisible row.
//
// Pure, and typed against the schema: a `number` row can only name a number key, a `boolean`
// row a boolean key, and a `select` row's options are the key's own literal union — so the
// catalog cannot offer a value the schema would refuse. The search over it is a function here
// too, for the same reason every other decision in `lib/` is: it is the part that can be proven
// without a DOM.

/** The dialog's sections, in the order its navigation lists them. */
export const SETTING_GROUPS = [
  { id: "appearance", title: "Appearance" },
  { id: "diff", title: "Diff" },
  { id: "editor", title: "Editor" },
] as const;
export type SettingGroupId = (typeof SETTING_GROUPS)[number]["id"];

/** The keys whose stored value is exactly `T` (not merely assignable to it — `string extends`
 * keeps an enum key out of the free-text rows). */
type KeysOf<T> = {
  [Key in keyof Settings]-?: [T] extends [Exclude<Settings[Key], undefined>]
    ? [Exclude<Settings[Key], undefined>] extends [T]
      ? Key
      : never
    : never;
}[keyof Settings];

type Row<Key extends keyof Settings> = {
  readonly key: Key;
  readonly group: SettingGroupId;
  readonly label: string;
  /** One sentence, read cold: what the setting changes and, where it is not obvious, why a
   * reader would want it. */
  readonly description: string;
};

export type SelectOption<Value extends string> = { readonly value: Value; readonly label: string };

/** The keys whose stored value is a string literal union — the ones a radio list can offer. */
type SelectKey = {
  [Key in keyof Settings]-?: Exclude<Settings[Key], undefined> extends string
    ? string extends Exclude<Settings[Key], undefined>
      ? never
      : Key
    : never;
}[keyof Settings];

export type SelectEntry<Key extends SelectKey> = Row<Key> & {
  readonly kind: "select";
  readonly options: readonly SelectOption<Exclude<Settings[Key], undefined>>[];
};
export type NumberEntry = Row<KeysOf<number>> & {
  readonly kind: "number";
  readonly range: NumberRange;
  /** Shown after the field: what the number counts. */
  readonly unit: string;
};
/** A font family, picked from the monospace fonts installed on this machine. The options are
 * not in the catalog because they are not the app's to know: `lib/local-fonts` lists them when
 * the dialog opens. */
export type FontEntry = Row<KeysOf<string>> & { readonly kind: "font" };
export type BooleanEntry = Row<KeysOf<boolean>> & { readonly kind: "boolean" };

export type SettingEntry =
  | SelectEntry<"theme">
  | SelectEntry<"editor">
  | NumberEntry
  | FontEntry
  | BooleanEntry;

const THEME_OPTIONS: readonly SelectOption<ThemeId>[] = THEMES.map((theme) => ({
  value: theme.id,
  label: theme.label,
}));

/** None first: it is the fresh-install state, and a reader looking for the way to turn the
 * buttons back off should find it where the list starts. */
const EDITOR_OPTIONS: readonly SelectOption<EditorChoice>[] = [
  { value: "none", label: "None" },
  ...EDITORS.map((editor) => ({ value: editor.id, label: editor.label })),
];

/** Every setting, in the order the dialog lists them within their group. */
export const SETTING_ENTRIES: readonly SettingEntry[] = [
  {
    kind: "select",
    key: "theme",
    group: "appearance",
    label: "Theme",
    description:
      "Colours the whole app, diff included. Each theme is light or dark on its own; until you pick one, the OS decides.",
    options: THEME_OPTIONS,
  },
  {
    kind: "font",
    key: "diffFontFamily",
    group: "diff",
    label: "Font family",
    description:
      "The code font, for the diff and every line that quotes it. Any monospace font installed on this machine; Geist Mono ships with the app.",
  },
  {
    kind: "number",
    key: "diffFontSize",
    group: "diff",
    label: "Font size",
    description: "The diff's type size. The rest of the interface keeps its own.",
    range: DIFF_FONT_SIZE,
    unit: "px",
  },
  {
    kind: "number",
    key: "diffLineHeight",
    group: "diff",
    label: "Line height",
    description:
      "Row height as a multiple of the font size, so it keeps step when the size changes.",
    range: DIFF_LINE_HEIGHT,
    unit: "×",
  },
  {
    kind: "number",
    key: "diffTabSize",
    group: "diff",
    label: "Tab size",
    description: "How many columns a tab character takes up.",
    range: DIFF_TAB_SIZE,
    unit: "columns",
  },
  {
    kind: "boolean",
    key: "diffLigatures",
    group: "diff",
    label: "Font ligatures",
    description:
      "Let the font join sequences like => and !== into one glyph. Off shows every character that changed as itself.",
  },
  {
    kind: "boolean",
    key: "diffWrap",
    group: "diff",
    label: "Wrap long lines",
    description: "Break a long line onto the next row instead of scrolling sideways to read it.",
  },
  {
    kind: "select",
    key: "editor",
    group: "editor",
    label: "Open files in",
    description:
      "Where a file goes when you open it from the diff: the button beside its name, the one on a comment, or E. Needs that editor installed, and a review that reads your checkout rather than its own copy of the diff.",
    options: EDITOR_OPTIONS,
  },
];

/** A change to one setting, from a row that only knows its key as a union member. The cast
 * is the one place the catalog's per-row typing is folded back into the patch shape: `key` is
 * the row's own and `value` was typed against it, so the pair is sound by construction. */
export function settingPatch<Key extends keyof Settings>(
  key: Key,
  value: Settings[Key] | undefined,
): SettingsPatch {
  return { [key]: value } as SettingsPatch;
}

/** The rows a query leaves standing. Every word typed has to appear somewhere in the row —
 * label, description, or its group's title — so "diff font" finds the font rows and nothing
 * else. Empty (or all spaces) is no filter. */
export function filterSettings(entries: readonly SettingEntry[], query: string): SettingEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return [...entries];
  }
  return entries.filter((entry) => {
    const group = SETTING_GROUPS.find((candidate) => candidate.id === entry.group);
    const haystack = `${group?.title ?? ""} ${entry.label} ${entry.description}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export type SettingSection = {
  readonly id: SettingGroupId;
  readonly title: string;
  readonly entries: readonly SettingEntry[];
};

/** The rows, grouped for rendering: each group in navigation order, carrying the rows the
 * filter left it, and absent altogether once the filter has left it none. */
export function settingSections(entries: readonly SettingEntry[]): SettingSection[] {
  return SETTING_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    entries: entries.filter((entry) => entry.group === group.id),
  })).filter((section) => section.entries.length > 0);
}
