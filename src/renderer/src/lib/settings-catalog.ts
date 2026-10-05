import type { EditorChoice, ThemeId } from "../../../shared/contracts";
import { EDITORS } from "../../../shared/editors";
import { GitHubOwner } from "../../../shared/pull-request";
import {
  DIFF_FONT_SIZE,
  DIFF_LINE_HEIGHT,
  DIFF_TAB_SIZE,
  type NumberRange,
  PROMPT_TEMPLATE_MAX,
  type Settings,
  type SettingsPatch,
} from "../../../shared/settings";
import { THEMES } from "../../../shared/themes";
import { PROMPT_PLACEHOLDERS } from "./pull-request-prompt";

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
  { id: "comments", title: "Comments" },
  { id: "pullRequests", title: "Pull requests" },
  { id: "github", title: "GitHub" },
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
/** Free text over several lines — a prompt template. Drawn under its sentence rather than
 * beside it, because a paragraph does not fit the column the other controls sit in.
 * `placeholders` are the tokens the text may carry, shown with the field so the reader does
 * not have to remember them. */
export type TextEntry = Row<KeysOf<string>> & {
  readonly kind: "text";
  readonly placeholders: readonly string[];
  /** The schema's own cap, so the field cannot take text the schema would read back as "never
   * chosen" — a reset nobody asked for. */
  readonly maxLength: number;
};

/** One line of text the schema holds to a format — a login. Drawn beside its sentence like the
 * short controls, and committed the way the number field is (blur, ⏎). An empty field is the
 * row's reset; a value `accept` refuses is not committed, and the field says why under it rather
 * than storing something the schema would read back as never chosen. */
export type LineEntry = Row<KeysOf<string>> & {
  readonly kind: "line";
  readonly placeholder: string;
  /** The value to store for what was typed, or null when the schema would refuse it. */
  readonly accept: (text: string) => string | null;
  /** The sentence under the field while `accept` refuses what is in it. */
  readonly invalid: string;
};

export type SettingEntry =
  | SelectEntry<"theme">
  | SelectEntry<"editor">
  | NumberEntry
  | FontEntry
  | BooleanEntry
  | TextEntry
  | LineEntry;

/** A GitHub login as a reader types it: trimmed, with the `@` a mention carries taken off, then
 * held to the schema's own charset (`GitHubOwner`) — the parse the stored value goes through. */
export function acceptGitHubLogin(text: string): string | null {
  const parsed = GitHubOwner.safeParse(text.trim().replace(/^@/u, ""));
  return parsed.success ? parsed.data : null;
}

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
    kind: "boolean",
    key: "fileTreeFlattenFolders",
    group: "appearance",
    label: "Collapse folder chains",
    description:
      "In the changed-files list, draw a run of folders that hold nothing else as a single row. Off gives every folder a row of its own, which stays readable when the sidebar is too narrow to show a long chain whole.",
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
  {
    kind: "boolean",
    key: "postableIncludesEvidence",
    group: "comments",
    label: "Include evidence for the author",
    description:
      "Add the evidence, folded, to comments you copy or post for the author. Off by default: evidence is written for you.",
  },
  {
    kind: "line",
    key: "githubUsername",
    group: "github",
    label: "GitHub username",
    description:
      "Review Pull Request… lists the pull requests that request your review. Public repositories only.",
    placeholder: "octocat",
    accept: acceptGitHubLogin,
    invalid: "Not a GitHub username: letters, digits, hyphens and underscores.",
  },
  {
    kind: "text",
    key: "pullRequestPrompt",
    group: "pullRequests",
    label: "Prompt for your agent",
    description:
      "Review Pull Request… copies this when the worktree is ready. Paste it into your agent. {pr} is the pull request's URL, {worktree} the folder, {base} the base branch, {head} the commit. The folder path has a space in it, so quote {worktree} in shell commands.",
    placeholders: PROMPT_PLACEHOLDERS,
    maxLength: PROMPT_TEMPLATE_MAX,
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
