import { describe, expect, it } from "vitest";
import { EDITOR_CHOICES, EDITOR_IDS, EDITORS, editorMeta, editorUrlFor } from "./editors";

describe("EDITORS", () => {
  it("lists every id exactly once, in the id tuple's order", () => {
    expect(EDITORS.map((editor) => editor.id)).toEqual([...EDITOR_IDS]);
  });

  it("puts none ahead of the editors", () => {
    expect(EDITOR_CHOICES).toEqual(["none", ...EDITOR_IDS]);
  });

  it("gives every editor a label and a plain scheme", () => {
    for (const editor of EDITORS) {
      expect(editor.label.length, editor.id).toBeGreaterThan(0);
      // A scheme with `:` or `/` in it would produce a URL whose protocol is not the scheme
      // the opener allowlists.
      expect(editor.scheme, editor.id).toMatch(/^[a-z][a-z0-9-]*$/u);
      expect(editorMeta(editor.id)).toBe(editor);
    }
  });
});

describe("editorUrlFor", () => {
  it("spells the file form with a line", () => {
    expect(editorUrlFor("zed", "/Users/me/repo/src/a.ts", 12)).toBe(
      "zed://file/Users/me/repo/src/a.ts:12",
    );
    expect(editorUrlFor("vscode-insiders", "/r/x.ts", 1)).toBe("vscode-insiders://file/r/x.ts:1");
  });

  it("leaves the line off when there is none", () => {
    expect(editorUrlFor("cursor", "/r/x.ts")).toBe("cursor://file/r/x.ts");
  });

  it("encodes a segment without touching the separators", () => {
    expect(editorUrlFor("windsurf", "/r/my dir/a#b.ts", 3)).toBe(
      "windsurf://file/r/my%20dir/a%23b.ts:3",
    );
  });
});
