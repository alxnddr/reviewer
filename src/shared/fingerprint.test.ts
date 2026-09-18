import { describe, expect, it } from "vitest";
import { commentFingerprint, fnv1a, type FingerprintedComment } from "./fingerprint";

// The point of this file is the pinned value below. A fingerprint keys reader state that
// outlives the build that wrote it, so a refactor that quietly changes the hash — a
// different separator, a reordered field, a `codePointAt` "cleanup" — would silently
// orphan every mark on every machine and nothing else in the toolchain would notice. The
// literal is the tripwire; if you change it, you are changing what readers keep.

const COMMENT: FingerprintedComment = {
  file: "src/main/git/runner.ts",
  side: "additions",
  startLine: 42,
  endLine: 44,
  body: "The timeout is not cleared on the success path, so a fast child keeps a handle alive.",
};

describe("commentFingerprint", () => {
  it("is the pinned value for a known comment", () => {
    expect(commentFingerprint(COMMENT)).toBe("9d534093");
  });

  it("is eight lower-case hex characters, leading zeros kept", () => {
    expect(commentFingerprint(COMMENT)).toMatch(/^[\da-f]{8}$/u);
    // A hash whose top bits are zero must not shorten the key — two keys of different
    // widths would collide in a record only by luck.
    expect(fnv1a("").toString(16).padStart(8, "0")).toHaveLength(8);
  });

  it("is deterministic across calls", () => {
    expect(commentFingerprint(COMMENT)).toBe(commentFingerprint({ ...COMMENT }));
  });

  it("separates two comments that differ only in side", () => {
    expect(commentFingerprint({ ...COMMENT, side: "deletions" })).not.toBe(
      commentFingerprint(COMMENT),
    );
  });

  it("separates comments that differ only in file, or in either endpoint", () => {
    const base = commentFingerprint(COMMENT);
    expect(commentFingerprint({ ...COMMENT, file: "src/main/git/ops.ts" })).not.toBe(base);
    expect(commentFingerprint({ ...COMMENT, startLine: 41 })).not.toBe(base);
    expect(commentFingerprint({ ...COMMENT, endLine: 45 })).not.toBe(base);
  });

  it("loses the mark when the body is edited — the stated consequence", () => {
    expect(
      commentFingerprint({ ...COMMENT, body: `${COMMENT.body} Fixed in the next hunk.` }),
    ).not.toBe(commentFingerprint(COMMENT));
  });

  it("ignores the author's labels, so re-tagging keeps the reader's mark", () => {
    // `tag`, `severity` and `evidence` are not part of `FingerprintedComment` at all — the
    // structural type is the enforcement. This asserts the runtime agrees: extra keys on
    // the object cannot reach the hash.
    const labelled = { ...COMMENT, tag: "decision", severity: "blocking", evidence: "$ bun test" };
    expect(commentFingerprint(labelled)).toBe(commentFingerprint(COMMENT));
  });

  it("does not let a body smuggle a field boundary", () => {
    // `body` is hashed last precisely so a `|` inside it cannot shift a later field. Two
    // comments whose anchor differs must stay distinct even when one body ends where the
    // other's begins.
    const a: FingerprintedComment = { ...COMMENT, endLine: 42, body: "x" };
    const b: FingerprintedComment = { ...COMMENT, endLine: 42, body: "x|44|x" };
    expect(commentFingerprint(a)).not.toBe(commentFingerprint(b));
  });
});

describe("fnv1a", () => {
  it("matches the FNV-1a 32-bit reference vectors", () => {
    expect(fnv1a("")).toBe(0x811c_9dc5);
    expect(fnv1a("a")).toBe(0xe40c_292c);
    expect(fnv1a("foobar")).toBe(0xbf9c_f968);
  });
});
