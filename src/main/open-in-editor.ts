import { shell } from "electron";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { EditorChoice } from "../shared/contracts";
import type { EditorOpenRequest, EditorOpenResponse } from "../shared/editor-ipc";
import { EDITORS, editorUrlFor } from "../shared/editors";
import { errnoCode } from "../shared/errors";
import type { Session } from "../shared/session";

// Open in Editor, main side: the only path by which the app hands a file to another program.
//
// A new seam rather than an extension of `external-links.ts`, whose gate exists precisely to
// drop everything that is not https — `file:` and custom schemes included — so a hostile
// artifact cannot reach the OS through a link in a comment. That gate stays as it is. This one
// admits exactly the schemes in `shared/editors.ts` and nothing the renderer can choose: the
// scheme comes from the stored setting, the path from the session's own validated checkout,
// and the renderer's request contributes only a repo-relative path and a line.
//
// Containment is proven on the resolved, realpath'd file against the realpath'd checkout, not
// on the string. `resolve` folds `..` away; `realpath` follows a symlink to wherever it goes
// and, on macOS, `/var` → `/private/var` on the root as well as the file, so the two are
// compared in the same coordinates. A path that lands outside is refused; a path that lands
// on nothing, or on a directory, is refused as missing. There is no shell and no argv: the
// URL is the whole hand-off, and the OS's own scheme handler does the rest.

/** What the opener needs from main, as functions: the session by id and the stored editor
 * choice. Injected rather than imported so the decision below tests against a temp directory
 * with no session store and no `electron-store` behind it. */
export type OpenInEditorDeps = {
  findSession: (id: string) => Session | undefined;
  editor: () => EditorChoice;
};

/** The schemes `openEditorUrl` will hand to the OS: the editors' own, derived from the table
 * so an editor added there is admitted here without a second list to forget. */
const EDITOR_PROTOCOLS: ReadonlySet<string> = new Set(EDITORS.map((editor) => `${editor.scheme}:`));

/** Whether a URL is one of the editor forms this module built. The allowlist is checked at the
 * moment of the call, not only at construction, so a refactor that routes some other string
 * here still cannot open it. */
export function isEditorUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return EDITOR_PROTOCOLS.has(parsed.protocol);
}

function openEditorUrl(url: string): void {
  if (isEditorUrl(url)) {
    void shell.openExternal(url);
  }
}

export type EditorFileCheck =
  | { ok: true; path: string }
  | { ok: false; code: "outsideRepo" | "missing" };

/** Where a repo-relative path lands on disk, proven inside `repoRoot` — the absolute real path
 * of a regular file, or why not. Exported for the test, which drives it against a temp
 * directory: a `..` escape, a symlink out, a directory and an absent file each get their
 * refusal, and a symlinked *root* still contains its own files. */
export async function checkEditorFile(repoRoot: string, path: string): Promise<EditorFileCheck> {
  let root: string;
  try {
    root = await realpath(repoRoot);
  } catch {
    // The checkout itself is gone: nothing under it can be present.
    return { ok: false, code: "missing" };
  }
  let real: string;
  try {
    real = await realpath(resolve(root, path));
  } catch (error) {
    // ENOENT and ENOTDIR are the honest "nothing there"; anything else (EACCES, ELOOP) is a
    // path this app cannot vouch for, and refusing it as outside is the safe reading.
    const code = errnoCode(error);
    return { ok: false, code: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "outsideRepo" };
  }
  if (real !== root && !real.startsWith(root + sep)) {
    return { ok: false, code: "outsideRepo" };
  }
  try {
    const info = await stat(real);
    return info.isFile() ? { ok: true, path: real } : { ok: false, code: "missing" };
  } catch {
    return { ok: false, code: "missing" };
  }
}

/** The `editor:open` handler: session → live? → editor chosen? → file inside the checkout? →
 * hand the URL to the OS. Every refusal is a typed answer the renderer turns into a sentence. */
export async function openInEditor(
  deps: OpenInEditorDeps,
  request: EditorOpenRequest,
): Promise<EditorOpenResponse> {
  const session = deps.findSession(request.sessionId);
  if (session === undefined) {
    return { ok: false, failure: { code: "noSession" } };
  }
  // A frozen review renders the artifact's own copy of the diff; its `source.repo.path` is the
  // authored label and was never validated as a checkout on this machine (`review/handlers.ts`),
  // so nothing here may resolve a file against it.
  if (session.reviewDiff?.kind === "frozenPatch") {
    return { ok: false, failure: { code: "notLive" } };
  }
  const editor = deps.editor();
  if (editor === "none") {
    return { ok: false, failure: { code: "noEditor" } };
  }
  const file = await checkEditorFile(session.source.repo.path, request.path);
  if (!file.ok) {
    return { ok: false, failure: { code: file.code } };
  }
  openEditorUrl(editorUrlFor(editor, file.path, request.line));
  return { ok: true };
}
