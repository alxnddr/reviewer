import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/session";
import { NO_PROGRESS } from "../shared/review-progress";

const openExternal = vi.fn();
vi.mock("electron", () => ({ shell: { openExternal: (url: string) => openExternal(url) } }));

const { checkEditorFile, isEditorUrl, openInEditor } = await import("./open-in-editor");

// The two decisions the seam makes that a type cannot: that a path is proven inside the
// checkout on disk rather than on its spelling, and that only an editor scheme ever reaches
// `shell.openExternal`. Both are driven against a real temp directory — a symlink is the case
// string checks get wrong, and only the filesystem can produce one.

let scratch: string;
let repo: string;

beforeEach(() => {
  // realpath'd up front: on macOS `tmpdir()` is under `/var`, which is itself a link to
  // `/private/var`, and the assertions compare against what the seam resolves.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "rvw-editor-")));
  repo = join(scratch, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
  writeFileSync(join(scratch, "outside.ts"), "leaked\n");
  openExternal.mockReset();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("checkEditorFile", () => {
  it("answers the real path of a file inside the checkout", async () => {
    await expect(checkEditorFile(repo, "src/a.ts")).resolves.toEqual({
      ok: true,
      path: join(repo, "src", "a.ts"),
    });
  });

  it("refuses a .. escape", async () => {
    await expect(checkEditorFile(repo, "../outside.ts")).resolves.toEqual({
      ok: false,
      code: "outsideRepo",
    });
  });

  it("refuses a symlink that leaves the checkout", async () => {
    symlinkSync(join(scratch, "outside.ts"), join(repo, "src", "link.ts"));
    await expect(checkEditorFile(repo, "src/link.ts")).resolves.toEqual({
      ok: false,
      code: "outsideRepo",
    });
  });

  it("still contains a file when the checkout root is itself a symlink", async () => {
    const linkedRoot = join(scratch, "linked");
    symlinkSync(repo, linkedRoot);
    await expect(checkEditorFile(linkedRoot, "src/a.ts")).resolves.toEqual({
      ok: true,
      path: join(repo, "src", "a.ts"),
    });
  });

  it("reports an absent file, and a directory, as missing", async () => {
    await expect(checkEditorFile(repo, "src/gone.ts")).resolves.toEqual({
      ok: false,
      code: "missing",
    });
    await expect(checkEditorFile(repo, "src")).resolves.toEqual({ ok: false, code: "missing" });
  });

  it("reports a checkout that is gone as missing", async () => {
    await expect(checkEditorFile(join(scratch, "nope"), "src/a.ts")).resolves.toEqual({
      ok: false,
      code: "missing",
    });
  });
});

describe("isEditorUrl", () => {
  it("admits every editor scheme", () => {
    for (const url of ["zed://file/a", "vscode://file/a", "cursor://file/a:1"]) {
      expect(isEditorUrl(url)).toBe(true);
    }
  });

  it.each(["https://example.com", "file:///etc/passwd", "javascript:alert(1)", "not a url"])(
    "refuses %s",
    (url) => {
      expect(isEditorUrl(url)).toBe(false);
    },
  );
});

describe("openInEditor", () => {
  const SESSION_ID = "11111111-1111-4111-8111-111111111111";

  function session(reviewDiff: Session["reviewDiff"] = null): Session {
    return {
      id: SESSION_ID,
      source: { kind: "local", repo: { path: repo, name: "repo" } },
      base: null,
      head: null,
      commitSelection: null,
      selectedFilePath: null,
      scrollTop: 0,
      comments: [],
      layers: [],
      overview: null,
      reviewDiff,
      reviewSubrange: null,
      reviewOrigin: null,
      reviewPath: null,
      ...NO_PROGRESS,
    };
  }

  it("hands the editor URL of a contained file to the OS", async () => {
    const response = await openInEditor(
      { findSession: () => session(), editor: () => "zed" },
      { sessionId: SESSION_ID, path: "src/a.ts", line: 7 },
    );
    expect(response).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith(`zed://file${join(repo, "src", "a.ts")}:7`);
  });

  it("refuses in order: no session, frozen, no editor, outside, missing", async () => {
    const outside = { sessionId: SESSION_ID, path: "../outside.ts" };
    const none = new Map<string, Session>();
    await expect(
      openInEditor({ findSession: (id) => none.get(id), editor: () => "zed" }, outside),
    ).resolves.toEqual({ ok: false, failure: { code: "noSession" } });
    await expect(
      openInEditor(
        { findSession: () => session({ kind: "frozenPatch", patch: "diff" }), editor: () => "zed" },
        outside,
      ),
    ).resolves.toEqual({ ok: false, failure: { code: "notLive" } });
    await expect(
      openInEditor({ findSession: () => session(), editor: () => "none" }, outside),
    ).resolves.toEqual({ ok: false, failure: { code: "noEditor" } });
    await expect(
      openInEditor({ findSession: () => session(), editor: () => "zed" }, outside),
    ).resolves.toEqual({ ok: false, failure: { code: "outsideRepo" } });
    await expect(
      openInEditor(
        { findSession: () => session(), editor: () => "zed" },
        { sessionId: SESSION_ID, path: "src/gone.ts" },
      ),
    ).resolves.toEqual({ ok: false, failure: { code: "missing" } });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens a refs review, which reads a checkout, like a plain repo session", async () => {
    const response = await openInEditor(
      {
        findSession: () => session({ kind: "refs", base: "main", head: "feature" }),
        editor: () => "cursor",
      },
      { sessionId: SESSION_ID, path: "src/a.ts" },
    );
    expect(response).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith(`cursor://file${join(repo, "src", "a.ts")}`);
  });
});
