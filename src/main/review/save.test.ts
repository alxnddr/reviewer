import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewArtifact } from "../../shared/review";
import type { ReviewSaveRequest } from "../../shared/review-save";

// The write is the real boundary here: only the native sheet is mocked (it cannot
// open under vitest), and every assertion is against actual disk state — a file
// that must not appear on cancel, real bytes on save, a mapped failure when the
// write cannot land. BrowserWindow resolves to no focused window so the handler
// takes the ownerless dialog path.
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: (): null => null },
  dialog: { showSaveDialog: vi.fn() },
}));

const { dialog } = await import("electron");
const { saveReviewJson, saveReviewMarkdown } = await import("./save");
const showSaveDialog = vi.mocked(dialog.showSaveDialog);

let tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-save-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  showSaveDialog.mockReset();
});

beforeEach(() => {
  showSaveDialog.mockReset();
});

const VALID_ARTIFACT = JSON.stringify({
  repo: "/repos/app",
  base: "main",
  head: "a".repeat(40),
  comments: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1, body: "hi" }],
  layers: [],
});

function request(content: string): ReviewSaveRequest {
  return { content, defaultName: "app-review.reviewer.json" };
}

describe("saveReviewJson", () => {
  it("writes nothing when the save sheet is canceled", async () => {
    // A viable target path rides the canceled result: the handler must still not
    // write to it, so the assertion is against real disk, not just the envelope.
    const target = join(makeDir(), "app-review.reviewer.json");
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: target });

    const response = await saveReviewJson(request(VALID_ARTIFACT));

    expect(response).toEqual({ ok: true, value: { kind: "canceled" } });
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(existsSync(target)).toBe(false);
  });

  it("treats an empty chosen path as a cancel and writes nothing", async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: "" });

    const response = await saveReviewJson(request(VALID_ARTIFACT));

    expect(response).toEqual({ ok: true, value: { kind: "canceled" } });
  });

  it("writes schema-valid JSON to the chosen path", async () => {
    const target = join(makeDir(), "app-review.reviewer.json");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });

    const response = await saveReviewJson(request(VALID_ARTIFACT));

    expect(response).toEqual({ ok: true, value: { kind: "saved", path: target } });
    const written = readFileSync(target, "utf8");
    expect(written).toBe(VALID_ARTIFACT);
    // What landed on disk re-parses as an artifact — a real, importable file.
    expect(ReviewArtifact.safeParse(JSON.parse(written)).success).toBe(true);
  });

  it("maps a failed write to a typed failure, leaking no raw fs error", async () => {
    // A path whose parent directory does not exist: writeFile rejects, and the
    // handler must turn that into `writeFailed` rather than throw across IPC.
    const target = join(makeDir(), "missing-subdir", "out.reviewer.json");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });

    const response = await saveReviewJson(request(VALID_ARTIFACT));

    expect(response).toEqual({ ok: false, failure: { code: "writeFailed" } });
    expect(existsSync(target)).toBe(false);
    // No stringified fs detail (path, errno, ENOENT) rides the envelope.
    const text = JSON.stringify(response);
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain(target);
  });
});

describe("saveReviewMarkdown", () => {
  it("writes the markdown content to the chosen path", async () => {
    const target = join(makeDir(), "app-review.md");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });

    const response = await saveReviewMarkdown(request("# Review\n"));

    expect(response).toEqual({ ok: true, value: { kind: "saved", path: target } });
    expect(readFileSync(target, "utf8")).toBe("# Review\n");
  });

  it("writes nothing when canceled", async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });
    const response = await saveReviewMarkdown(request("# Review\n"));
    expect(response).toEqual({ ok: true, value: { kind: "canceled" } });
  });
});
