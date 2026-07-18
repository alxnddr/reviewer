import { BrowserWindow, dialog, type FileFilter } from "electron";
import { writeFile } from "node:fs/promises";
import { IpcChannel } from "../../shared/ipc";
import { ReviewSaveRequest, ReviewSaveResponse } from "../../shared/review-save";
import { registerIpcHandler } from "../ipc-registry";

// The one native-save seam for review export: main owns the save sheet and the
// disk write so neither reaches the sandboxed renderer, and any fs error is mapped
// to a typed failure — a raw error never crosses IPC. The two export channels reuse
// `saveTextViaDialog`, differing only by filter and the suggested filename, exactly
// like the git handlers reuse one runner.

/** Show the parented save sheet (a window-modal sheet on macOS, like the open
 * dialog) and write `content` to the chosen path. A dismissed sheet writes
 * nothing; an fs error becomes `writeFailed`, logged here so the detail stays out
 * of IPC. */
async function saveTextViaDialog(
  request: ReviewSaveRequest,
  filters: FileFilter[],
): Promise<ReviewSaveResponse> {
  const options = { title: "Export Review", defaultPath: request.defaultName, filters };
  const owner = BrowserWindow.getFocusedWindow();
  const picked = await (owner === null
    ? dialog.showSaveDialog(options)
    : dialog.showSaveDialog(owner, options));
  if (picked.canceled || picked.filePath === "") {
    return { ok: true, value: { kind: "canceled" } };
  }
  try {
    await writeFile(picked.filePath, request.content, "utf8");
  } catch (error) {
    console.error("Review export write failed:", error);
    return { ok: false, failure: { code: "writeFailed" } };
  }
  return { ok: true, value: { kind: "saved", path: picked.filePath } };
}

// macOS matches only the last extension segment, so a `.reviewer.json` file
// surfaces under the `json` filter — the same double-extension handling the open
// dialog uses.
const JSON_FILTERS: FileFilter[] = [
  { name: "Reviewer review", extensions: ["reviewer.json", "json"] },
];
const MARKDOWN_FILTERS: FileFilter[] = [{ name: "Markdown", extensions: ["md"] }];

export function saveReviewJson(request: ReviewSaveRequest): Promise<ReviewSaveResponse> {
  return saveTextViaDialog(request, JSON_FILTERS);
}

export function saveReviewMarkdown(request: ReviewSaveRequest): Promise<ReviewSaveResponse> {
  return saveTextViaDialog(request, MARKDOWN_FILTERS);
}

export function registerReviewSaveHandlers(): void {
  registerIpcHandler(
    IpcChannel.reviewSaveJson,
    { request: ReviewSaveRequest, response: ReviewSaveResponse },
    saveReviewJson,
  );
  registerIpcHandler(
    IpcChannel.reviewSaveMarkdown,
    { request: ReviewSaveRequest, response: ReviewSaveResponse },
    saveReviewMarkdown,
  );
}
