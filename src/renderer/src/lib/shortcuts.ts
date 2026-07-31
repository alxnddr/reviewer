// The app's keyboard vocabulary, declared once.
//
// Every key in here used to be written down two or three times over: the shortcut sheet kept
// a hand-maintained literal of its own, the tooltip on whichever control performs the same
// action spelled the key out again, and the recents picker's footer spelled three of them a
// third time. Nothing linked the copies, so they drifted exactly as three independently
// authored lists do — four groups of keys were implemented and on no sheet at all (the commit
// picker's range-brushing, the recents picker's paging, the comment editor's ⌘⏎, the tab
// strip's arrows), and the two hints that name the comment keys spelled them in a different
// case from the sheet that also names them.
//
// So the declaration lives here and everything else derives from it: `ShortcutsDialog` renders
// these groups in this order, `ShortcutHint` looks an entry up by id, and the recents footer
// picks three entries out by id. A hint whose id is not registered is a type error, which is
// the property this file exists for — a key can still be *implemented* without being
// registered, but it can no longer be *advertised* without being registered, and advertising
// it is the half that used to go stale.
//
// The handlers stay where they are. This is a vocabulary, not a dispatch table: each key is
// caught by a short switch next to the state it acts on and guarded by `shortcut-guard`, and
// a central dispatcher would have to reproduce every one of those contexts (focus is in the
// tree, in the strip, in a field, under a sheet) to gain nothing over the switch that already
// sits inside them.

/** A section of the sheet. `note` is for the groups whose keys are not global — the ones that
 * only answer while one particular thing holds focus. Without it the sheet's own promise
 * ("single keys work anywhere") reads as a claim about these too, and a reader who tries ↑
 * from the diff and gets nothing has been told the app is broken rather than told where to
 * press it. */
type ShortcutGroup = { id: string; title: string; note?: string };

/** Grouped the way the work is: moving through the change, then through its findings, then the
 * app's own windows, then the four surfaces that own keys only while they hold focus. Within a
 * group, the order is the order a reader meets them — and this array is the sheet's order, top
 * to bottom, left column then right. */
const GROUPS = [
  { id: "reading", title: "Reading" },
  { id: "comments", title: "Comments" },
  // The tree owns these while it has focus, which F6 is how you give it.
  { id: "layers", title: "Layers", note: "While the layer list has focus" },
  { id: "find", title: "Find", note: "⏎, ⇧⏎ and Esc work in the find field" },
  { id: "windows", title: "Windows" },
  { id: "tabs", title: "Tab strip", note: "While the tab strip has focus" },
  { id: "commits", title: "Commits", note: "While the commit picker has focus" },
  { id: "recents", title: "Recent reviews", note: "While the picker is open" },
  { id: "editor", title: "Writing a comment", note: "While the editor is open" },
] as const satisfies readonly ShortcutGroup[];

type GroupId = (typeof GROUPS)[number]["id"];

/** One shortcut: the keys, then what they do.
 *
 * Two keys mean one of two things and the row has to say which: `↑ ↓` is a choice (either
 * key, opposite directions), `⌘1 … ⌘9` is a range (and every key in between). `range` picks
 * the separator — an ellipsis spans, a bare gap alternates. A chord is never two entries; it
 * is one string inside one chip (`⇧⌘O`).
 *
 * `label` is the sheet's sentence, written to be read cold. `short` is the same action named
 * in a tooltip or a footer, where the control beside it has already said most of it — "Stop
 * navigating" on the stepper's ✕ against "Stop stepping through comments" on a sheet that has
 * no stepper in view. */
type Shortcut = {
  group: GroupId;
  keys: readonly string[];
  label: string;
  short?: string;
  range?: boolean;
};

const SHORTCUTS = {
  "file.next": { group: "reading", keys: ["J"], label: "Next file" },
  "file.previous": { group: "reading", keys: ["K"], label: "Previous file" },
  // The sheet says which file; the hint on the checkbox says which way it is about to go
  // ("Mark read" / "Mark unread"), so that one passes its own label.
  "file.read": { group: "reading", keys: ["R"], label: "Mark the focused file read" },
  "overview.toggle": { group: "reading", keys: ["O"], label: "Open or close the overview" },
  "region.next": { group: "reading", keys: ["F6"], label: "Next pane (⇧F6 back)" },

  "comment.next": { group: "comments", keys: ["N"], label: "Next comment" },
  "comment.previous": { group: "comments", keys: ["P"], label: "Previous comment" },
  "comment.stop": {
    group: "comments",
    keys: ["Esc"],
    label: "Stop stepping through comments",
    short: "Stop navigating",
  },
  // "the one you are on" is doing real work: this key needs a focused comment, and pressing
  // it without one is a no-op the reader would otherwise read as broken.
  "comment.copyPrompt": {
    group: "comments",
    keys: ["⇧⌘C"],
    label: "Copy the comment you are on as a prompt",
    short: "Copy as a prompt",
  },
  "comment.copyAllPrompts": {
    group: "comments",
    keys: ["⌥⇧⌘C"],
    label: "Copy every comment in the review as a prompt",
    short: "Copy all comments as a prompt",
  },

  "layer.step": { group: "layers", keys: ["↑", "↓"], label: "Step the list" },
  "layer.fold": { group: "layers", keys: ["→", "←"], label: "Open or fold a group" },
  "layer.ends": { group: "layers", keys: ["Home", "End"], label: "First or last layer" },
  "layer.clearSolo": { group: "layers", keys: ["Esc"], label: "Clear the soloed layer" },

  "find.open": { group: "find", keys: ["⌘F"], label: "Find in the diff" },
  "find.next": { group: "find", keys: ["⏎"], label: "Next match" },
  "find.previous": { group: "find", keys: ["⇧⏎"], label: "Previous match" },
  "find.close": { group: "find", keys: ["Esc"], label: "Close find" },

  "repo.open": { group: "windows", keys: ["⌘O"], label: "Open a repository" },
  "review.open": { group: "windows", keys: ["⇧⌘O"], label: "Open a review" },
  "recents.open": { group: "windows", keys: ["⇧⌘R"], label: "Recent reviews" },
  "tab.new": { group: "windows", keys: ["⌘T"], label: "New tab" },
  "tab.ordinal": {
    group: "windows",
    keys: ["⌘1", "⌘9"],
    label: "Switch to a tab by position",
    range: true,
  },
  // The menu binds ⌃⇧⇥ to the other direction; it rides the sentence rather than taking a
  // second row, so the strip's one gesture stays one line on the sheet.
  "tab.cycle": { group: "windows", keys: ["⌃⇥"], label: "Cycle tabs (⌃⇧⇥ back)" },
  "tab.close": { group: "windows", keys: ["⌘W"], label: "Close the tab" },

  "tab.step": { group: "tabs", keys: ["←", "→"], label: "Step the tabs" },
  // Down here rather than under Windows with the other tab chords, because it is not one of
  // them: ⌘T and ⌘W are menu accelerators and fire from anywhere, while this pair is read by
  // the strip's own handler and does nothing until the strip has focus. A row under a heading
  // that promises no such thing is the drift this file exists to stop.
  "tab.move": { group: "tabs", keys: ["⌥⇧←", "⌥⇧→"], label: "Move the focused tab" },
  "tab.ends": { group: "tabs", keys: ["Home", "End"], label: "First or last tab" },

  // Shift named in the sentence rather than given rows of its own, the way F6 names ⇧F6:
  // four rows for two gestures would be the longest group on the sheet for the list a
  // reader spends the least time in.
  "commit.step": { group: "commits", keys: ["↑", "↓"], label: "Step the list (⇧ extends)" },
  "commit.ends": {
    group: "commits",
    keys: ["Home", "End"],
    label: "First or last commit (⇧ extends)",
  },

  "recents.step": { group: "recents", keys: ["↑", "↓"], label: "Step the list", short: "move" },
  "recents.page": { group: "recents", keys: ["⇞", "⇟"], label: "Page the list" },
  "recents.ends": { group: "recents", keys: ["Home", "End"], label: "First or last review" },
  "recents.openReview": {
    group: "recents",
    keys: ["⏎"],
    label: "Open the highlighted review",
    short: "open",
  },
  "recents.close": { group: "recents", keys: ["Esc"], label: "Close the picker", short: "close" },

  "draft.save": { group: "editor", keys: ["⌘⏎"], label: "Save the comment" },
  "draft.cancel": { group: "editor", keys: ["Esc"], label: "Discard the draft" },
} as const satisfies Record<string, Shortcut>;

/** Every registered shortcut, as a type. A hint that names an id which is not in the table
 * above does not compile — the one guard that makes registering a new key unskippable. */
export type ShortcutId = keyof typeof SHORTCUTS;

/** One shortcut, by id. Total by construction: `ShortcutId` is the table's own keys. */
export function shortcut(id: ShortcutId): Shortcut {
  return SHORTCUTS[id];
}

/** What a tooltip or a footer calls this action — the short form where there is one, and the
 * sheet's sentence where there is not. */
export function shortcutLabel(id: ShortcutId): string {
  const entry = shortcut(id);
  return entry.short ?? entry.label;
}

type SheetEntry = Shortcut & { id: ShortcutId };

/** The sheet, in render order: the groups as declared, each carrying the shortcuts declared
 * against it in the order they were written. Derived once at module load — the table never
 * changes at runtime, and the dialog mounts for the life of the app. */
export const SHORTCUT_SHEET: readonly (ShortcutGroup & { shortcuts: readonly SheetEntry[] })[] =
  GROUPS.map((group) => ({
    ...group,
    // `Object.keys` widens to `string`; these are the table's own keys and nothing else can
    // add to it.
    shortcuts: (Object.keys(SHORTCUTS) as ShortcutId[])
      .filter((id) => SHORTCUTS[id].group === group.id)
      .map((id) => ({ id, ...shortcut(id) })),
  }));
