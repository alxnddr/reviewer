import { describe, expect, it } from "vitest";
import { SHORTCUT_SHEET, shortcut, shortcutLabel } from "./shortcuts";

// The registry's own invariants. Which keys are declared is a literal and the types already
// carry most of it — a shortcut cannot name a group that does not exist, and a hint cannot
// name an id that is not registered — so what is left to test is what the types cannot say:
// that every declared key reaches the sheet exactly once, in the order the sheet is read in,
// and that no two rows under one heading claim the same key.

describe("SHORTCUT_SHEET", () => {
  it("renders every declared shortcut once, off the table the hints read", () => {
    const ids = SHORTCUT_SHEET.flatMap((group) => group.shortcuts.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
    // Derived rather than a second literal, which is the whole point of the file: every row
    // is the same entry `ShortcutHint` gets when it looks that id up, keys and label and all.
    for (const group of SHORTCUT_SHEET) {
      for (const entry of group.shortcuts) {
        const { id, ...row } = entry;
        expect(row).toEqual(shortcut(id));
      }
    }
  });

  // One heading is one context — the keys under it are all live at the same moment — so two
  // rows there claiming the same key is one of them being a lie about what the press does.
  // Across headings is fine and common: Esc closes the find bar, clears the solo, ends the
  // comment walk, each in its own scope.
  it("never claims one key twice inside a scope", () => {
    for (const group of SHORTCUT_SHEET) {
      const keys = group.shortcuts.flatMap((entry) => entry.keys);
      expect(new Set(keys).size, `${group.id} claims a key twice`).toBe(keys.length);
    }
  });

  it("leaves no group empty", () => {
    for (const group of SHORTCUT_SHEET) {
      expect(group.shortcuts.length).toBeGreaterThan(0);
    }
  });

  it("opens on the review's own vocabulary and ends on the surfaces that borrow keys", () => {
    expect(SHORTCUT_SHEET.map((group) => group.id)).toEqual([
      "reading",
      "comments",
      "layers",
      "find",
      "windows",
      "tabs",
      "commits",
      "recents",
      "editor",
    ]);
  });

  it("names every group that only answers while something holds focus", () => {
    for (const id of ["layers", "tabs", "commits", "recents", "editor"]) {
      const group = SHORTCUT_SHEET.find((entry) => entry.id === id);
      expect(group?.note).toBeTypeOf("string");
    }
  });

  // The four groups findings.md caught implemented and undocumented. The tab strip also holds
  // ⌥⇧←/→, which the sheet did carry — under Windows, beside the menu accelerators, which was
  // the other half of the same drift: that chord is read by the strip's own handler and is
  // dead everywhere else.
  it("carries the keys that had drifted off the sheet", () => {
    const keysOf = (groupId: string): string[] =>
      (SHORTCUT_SHEET.find((group) => group.id === groupId)?.shortcuts ?? []).flatMap(
        (entry) => entry.keys,
      );
    expect(keysOf("commits")).toEqual(["↑", "↓", "Home", "End"]);
    expect(keysOf("recents")).toEqual(["↑", "↓", "⇞", "⇟", "Home", "End", "⏎", "Esc"]);
    expect(keysOf("tabs")).toEqual(["←", "→", "⌥⇧←", "⌥⇧→", "Home", "End"]);
    expect(keysOf("editor")).toEqual(["⌘⏎", "Esc"]);
    // And nothing under Windows needs a surface focused to fire: every one of them is a menu
    // accelerator.
    expect(keysOf("windows")).toEqual(["⌘O", "⇧⌘O", "⇧⌘R", "⌘T", "⌘1", "⌘9", "⌃⇥", "⌘W"]);
  });
});

describe("shortcutLabel", () => {
  it("prefers the compact wording where a control has already said most of it", () => {
    expect(shortcut("comment.stop").label).toBe("Stop stepping through comments");
    expect(shortcutLabel("comment.stop")).toBe("Stop navigating");
  });

  it("falls back to the sheet's sentence", () => {
    expect(shortcutLabel("file.next")).toBe("Next file");
  });
});
