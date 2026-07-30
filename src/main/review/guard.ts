import { readFile, realpath, stat } from "node:fs/promises";
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
  /** `path` is the artifact as this module resolved it — absolute, and with symlinks
   * followed. Returned rather than left to the caller to re-derive, because it is the key
   * the session is deduped by and the key its progress is stored under: two callers
   * canonicalizing a path two ways would quietly become two tabs over one review. */
  { ok: true; review: ImportedReview; path: string } | { ok: false; failure: ReviewOpenFailure };

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
  // Symlinks resolved last, once the file is known to be readable: a symlinked artifact is a
  // real way to keep a review around (`recent.ts` stats through them for the same reason),
  // and a link opened alongside its target must be one tab sharing one progress record, not
  // two. A realpath that fails leaves the resolved path standing — worst case the link and
  // its target are treated as two reviews, which is the behaviour without this line at all.
  const real = await realpath(path).catch(() => path);
  return { ok: true, review: imported.review, path: real };
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
