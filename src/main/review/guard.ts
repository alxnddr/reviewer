import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { REVIEW_EXTENSION } from "../../shared/review-file";
import { importReview, type ImportedReview, type ReviewStamp } from "../../shared/review";
import type { ReviewOpenFailure } from "../../shared/review-open";

// The one seam all three open paths funnel through: a path — from a renderer drop,
// a dialog pick, or argv — is untrusted until every check here has passed, and no
// byte is read until the size cap has. Electron-free on purpose: dialog/CLI/
// `open-file` deliver a string; this turns a string into an `ImportedReview` or a
// typed failure, never a throw.

/** Byte cap checked against `stat.size`, so an over-cap artifact is rejected
 * before its bytes ever load. */
export const REVIEW_MAX_BYTES = 32 * 1024 * 1024;

export type ReviewImportResult =
  | { ok: true; review: ImportedReview }
  | { ok: false; failure: ReviewOpenFailure };

/** Node fs rejections are `Error` with an errno `code`; the cast is the boundary
 * where an untyped runtime shape becomes a checked string. */
function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export async function importReviewFromPath(
  rawPath: string,
  stamp: ReviewStamp,
): Promise<ReviewImportResult> {
  const path = resolve(rawPath);
  // Extension first, before touching disk: a `.txt` never reaches `stat`, `read`,
  // or `importReview`, so a mis-typed pick costs nothing and leaks nothing.
  if (!path.endsWith(REVIEW_EXTENSION)) {
    return { ok: false, failure: { code: "wrongExtension" } };
  }

  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    return {
      ok: false,
      failure: { code: isErrno(error, "ENOENT") ? "fileNotFound" : "unreadable" },
    };
  }
  if (!stats.isFile()) {
    return { ok: false, failure: { code: "unreadable" } };
  }
  if (stats.size > REVIEW_MAX_BYTES) {
    return { ok: false, failure: { code: "tooLarge" } };
  }

  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch {
    return { ok: false, failure: { code: "unreadable" } };
  }

  const imported = importReview(bytes, stamp);
  if (!imported.ok) {
    return { ok: false, failure: { code: "invalidContent" } };
  }
  return { ok: true, review: imported.review };
}

/** The CLI / `open-file` argv → path step, pure so the resolution rule is tested
 * without a process. Scans from the end (the artifact is the trailing arg on both
 * the packaged `Reviewer x.reviewer.json` and the dev `electron . x.reviewer.json`
 * forms) and resolves a relative arg against the launch cwd (`second-instance`
 * carries `workingDirectory`; a first launch passes `process.cwd()`). Returns
 * null when no arg names a review — the focus-only fallback. */
export function reviewPathFromArgv(
  argv: readonly string[],
  workingDirectory: string,
): string | null {
  for (let index = argv.length - 1; index >= 0; index--) {
    const arg = argv[index];
    if (arg !== undefined && arg.endsWith(REVIEW_EXTENSION)) {
      return resolve(workingDirectory, arg);
    }
  }
  return null;
}
