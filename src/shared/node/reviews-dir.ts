import { basename, join } from "node:path";

// Where `rvw emit` writes a review when it is given no `--out`, and — because it is the same
// place — where the app looks to list what has been reviewed before. A refs-only artifact
// points at its repo by absolute path and the app re-derives the diff, so it does not belong
// *in* the repo, where it would be untracked clutter to gitignore and sweep up. It is a handoff
// file the app imports into its own session store; rvw therefore owns one user-level directory
// for it, outside every repo, and `rvw open` reaches it wherever it is.
//
// This lives in shared rather than in `cli/` because it is now a *contract between two
// programs*: the CLI writes here and the app reads here, and a copy of the rule on each side is
// a feature that goes quietly empty the day one of them changes. Both functions take their
// environment (env, home, timestamp) as arguments so the location and the derived name are
// proven without mutating `process.env` or reading the clock.
//
// It sits under `shared/node/` because only the two node-side programs read it — main's
// `review/recent.ts` and `review/guard.ts`, the CLI's `emit` and `open` — and that directory is
// excluded from `tsconfig.web.json`, so `node:path` is available here and a renderer module that
// reached for this file would not compile.

/** The on-disk identity of a review artifact: the one extension every `.reviewer.json`
 * carries. Both open paths gate on it — main's import guard (a dropped/picked/argv path is
 * rejected before a byte is read) and the CLI's `rvw open` (a launch is refused before the app
 * is asked to open a non-review) — so the string lives here once and cannot drift between the
 * two sides. It sits in this module rather than one of its own because a file's extension and
 * its name are the same subject: `reviewFileName` below is what puts it there in the first
 * place, and every program that reads the constant is one of the two that read this file. */
export const REVIEW_EXTENSION = ".reviewer.json";

/** The reviews directory: `$RVW_HOME/reviews` when RVW_HOME is set — one override, for a user
 * who wants it elsewhere and for a test that must not touch the real home — else the default
 * `~/.rvw/reviews`. The caller creates it (mkdir -p) before writing; this only names it. */
export function reviewsDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const override = env.RVW_HOME;
  // `join` also collapses a trailing separator on `home` or the override, so a value given with
  // one does not produce a doubled slash mid-path. `home || "/"` because an empty home — a shell
  // run with `HOME=` — would otherwise join to a *relative* `.rvw/reviews`, scattering the store
  // into whatever directory each program happened to start in: `rvw emit` would drop it inside
  // the repo it is reviewing and the app would never look there.
  return override !== undefined && override.length > 0
    ? join(override, "reviews")
    : join(home || "/", ".rvw", "reviews");
}

/** A filename for a review of `repoPath`'s `base..head`. Every component is slugged to a
 * filesystem-safe token — a branch ref carries slashes a path separator would swallow, a sha
 * does not — and each ref is capped so a 40-char sha does not swamp the name. `stamp` (the
 * caller's `Date.now()`) makes each emit unique, so re-reviewing a range never silently
 * clobbers an earlier artifact the user has not opened yet; it is injected, not read here, so
 * the name is deterministic under test. */
export function reviewFileName(
  repoPath: string,
  base: string,
  head: string,
  stamp: number,
): string {
  // `basename("/")` is the empty string, which `slug` passes through and the `||` reads as
  // "no name here".
  const repo = slug(basename(repoPath)) || "review";
  return `${repo}-${slug(base)}-${slug(head)}-${stamp}${REVIEW_EXTENSION}`;
}

/** A ref or repo name reduced to a short, filesystem-safe token: runs of non-alphanumerics
 * (slashes, dots, spaces) collapse to a single `-`, the ends are trimmed of `-`, and the
 * result is capped. Empty in, empty out — the caller supplies the fallback.
 *
 * ASCII-only, knowingly: a non-Latin repo or branch collapses to nothing, so
 * `reviewFileName("/w/repo", "фича", "главная", 1)` yields `repo---1.reviewer.json`. The stamp
 * still makes the name unique, so nothing is clobbered — the loss is cosmetic, and a
 * transliterating slug library would be a poor trade for a 16-char filesystem token. */
function slug(value: string): string {
  return value
    .replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 16);
}
