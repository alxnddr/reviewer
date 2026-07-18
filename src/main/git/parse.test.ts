import { describe, expect, it } from "vitest";
import { LOG_FIELD_SEPARATOR, parseBranchList, parseCommitLog } from "./parse";

const SHA = "f".repeat(40);

function logRecord(fields: {
  sha?: string;
  shortSha?: string;
  author?: string;
  authoredAt?: string;
  subject?: string;
}): string {
  return [
    fields.sha ?? SHA,
    fields.shortSha ?? "fffffff",
    fields.author ?? "Ada",
    fields.authoredAt ?? "2026-07-04T10:00:00+02:00",
    fields.subject ?? "a subject",
  ].join(LOG_FIELD_SEPARATOR);
}

describe("parseCommitLog", () => {
  it("returns no commits for empty output", () => {
    expect(parseCommitLog("")).toEqual([]);
  });

  it("parses NUL-separated records, newest first", () => {
    const stdout = `${logRecord({ subject: "second" })}\0${logRecord({ subject: "first" })}\0`;
    const commits = parseCommitLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: SHA,
      shortSha: "fffffff",
      author: "Ada",
      authoredAt: "2026-07-04T10:00:00+02:00",
      subject: "second",
    });
    expect(commits[1]?.subject).toBe("first");
  });

  it("keeps a newline inside a subject", () => {
    const commits = parseCommitLog(logRecord({ subject: "line one\nline two" }));
    expect(commits[0]?.subject).toBe("line one\nline two");
  });

  it("keeps a separator byte inside a subject", () => {
    const subject = `weird${LOG_FIELD_SEPARATOR}subject`;
    const commits = parseCommitLog(logRecord({ subject }));
    expect(commits[0]?.subject).toBe(subject);
  });

  it("throws on a record with missing fields", () => {
    expect(() => parseCommitLog(`${SHA}${LOG_FIELD_SEPARATOR}fffffff`)).toThrow(/Malformed/);
  });
});

describe("parseBranchList", () => {
  it("splits one branch per line", () => {
    expect(parseBranchList("main\nfeature/login\n")).toEqual(["main", "feature/login"]);
  });

  it("returns no branches for empty output", () => {
    expect(parseBranchList("")).toEqual([]);
  });
});
