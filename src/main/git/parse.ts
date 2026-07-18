// Pure parsing of git plumbing output: no spawning, no I/O, unit-testable on
// crafted strings. Formats are chosen so the parse is unambiguous — NUL record
// separators survive newlines in commit subjects.

/** Matches `LOG_FORMAT` in ops.ts: fields joined by `%x1f`, records by `-z`'s NUL. */
export const LOG_FIELD_SEPARATOR = "\u001f";

export type ParsedCommit = {
  sha: string;
  shortSha: string;
  author: string;
  authoredAt: string;
  subject: string;
};

/** Parses `git log -z --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s` output, newest first.
 * Throws on records that don't match the format — that means a bug on our side;
 * callers map the throw to a typed failure. */
export function parseCommitLog(stdout: string): ParsedCommit[] {
  return stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, shortSha, author, authoredAt, ...subjectParts] =
        record.split(LOG_FIELD_SEPARATOR);
      if (
        sha === undefined ||
        shortSha === undefined ||
        author === undefined ||
        authoredAt === undefined ||
        subjectParts.length === 0
      ) {
        throw new Error("Malformed git log record: expected 5 fields");
      }
      // The subject is last so a separator byte inside it (legal in a commit
      // message) re-joins instead of corrupting the fixed fields before it.
      return { sha, shortSha, author, authoredAt, subject: subjectParts.join(LOG_FIELD_SEPARATOR) };
    });
}

/** Parses `git for-each-ref refs/heads --format=%(refname:short)` output. */
export function parseBranchList(stdout: string): string[] {
  return stdout.split("\n").filter((name) => name.length > 0);
}
