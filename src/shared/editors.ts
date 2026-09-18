// The editors Open in Editor can hand a file to, as data: the id a reader picks in Settings, the
// name the dialog and the buttons show for it, and the URL scheme its app registers. Hand-written
// like `themes.ts` and for the same reason — a closed set the zod `EditorId` enum in `contracts.ts`
// derives from, so a stored choice is validated against exactly these and nothing else.
//
// URL schemes only, no argv template. Every editor here registers a `<scheme>://file/<path>:<line>`
// handler with the OS, which `shell.openExternal` reaches without spawning anything — so the seam
// that opens a file (`main/open-in-editor.ts`) never runs a shell and never takes a command the
// reader typed. A custom command would be a second, executable setting to sanitize; this table
// is the decision not to have one. Adding an editor is one row here, provided it registers such
// a scheme; one that does not (a terminal editor) does not belong in this list.

/** Every supported editor id, as a literal tuple — the zod `EditorId` enum derives from it. */
export const EDITOR_IDS = ["zed", "vscode", "vscode-insiders", "cursor", "windsurf"] as const;
export type EditorId = (typeof EDITOR_IDS)[number];

/** What a reader can store: one of the editors, or none — the fresh-install state, in which every
 * Open in Editor control is present but disabled and says where to pick one. A literal rather
 * than an absent key, because absent already means "never chosen" for every setting and a
 * resolved record has to carry *some* value for this one. */
export const EDITOR_CHOICES = ["none", ...EDITOR_IDS] as const;
export type EditorChoice = (typeof EDITOR_CHOICES)[number];

export type EditorMeta = {
  readonly id: EditorId;
  readonly label: string;
  /** The URL scheme the editor's app registers (`zed` for `zed://file/…`). */
  readonly scheme: string;
};

export const EDITORS: readonly EditorMeta[] = [
  { id: "zed", label: "Zed", scheme: "zed" },
  { id: "vscode", label: "Visual Studio Code", scheme: "vscode" },
  { id: "vscode-insiders", label: "Visual Studio Code Insiders", scheme: "vscode-insiders" },
  { id: "cursor", label: "Cursor", scheme: "cursor" },
  { id: "windsurf", label: "Windsurf", scheme: "windsurf" },
];

/** One editor's row. Total by construction: `EditorId` is the table's own id set, and
 * `editors.test.ts` pins that the table lists every id exactly once. */
export function editorMeta(id: EditorId): EditorMeta {
  const meta = EDITORS.find((editor) => editor.id === id);
  if (meta === undefined) {
    throw new Error(`editor table is missing ${id}`);
  }
  return meta;
}

/** The `<scheme>://file/<abs path>:<line>` URL every editor in the table opens a file at. Each
 * path segment is percent-encoded on its own so a space or a `#` in a filename survives the
 * trip through the OS's URL handler, while the separators stay separators. No line means the
 * file alone. Pure, and shared-side, so the renderer's tooltip and main's opener agree on the
 * form without either importing the other. */
export function editorUrlFor(editor: EditorId, absPath: string, line?: number): string {
  const encoded = absPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const suffix = line === undefined ? "" : `:${line}`;
  return `${editorMeta(editor).scheme}://file${encoded}${suffix}`;
}
