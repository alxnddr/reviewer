import { describe, expect, it } from "vitest";
import { QUOTED_PATH_HOST_PATCH } from "./fixtures";
import { ANALYSIS_CACHE_KEY, parsePatch } from "./patch";
import { unquoteGitPath } from "./git-path";

// Both shapes the parser leaves a quoted name in, back to the name: the header's (quotes and
// prefix stripped, escapes kept) and `rename to`'s (quotes kept).

describe("unquoteGitPath", () => {
  it("leaves a plain name alone — quotes included, since a quoted form always has a backslash", () => {
    expect(unquoteGitPath("src/a b.ts")).toBe("src/a b.ts");
    expect(unquoteGitPath("Day01-20/11.常用.md")).toBe("Day01-20/11.常用.md");
    // A file really named `"abc"`: git would have written `"\"abc\""`, so this is the name.
    expect(unquoteGitPath('"abc"')).toBe('"abc"');
    expect(unquoteGitPath(unquoteGitPath('"abc"'))).toBe('"abc"');
  });

  it("reads any backslash as git's escape — the documented limit on an already-decoded name", () => {
    expect(unquoteGitPath(String.raw`a\101`)).toBe(String.raw`aA`);
    expect(unquoteGitPath(String.raw`aA`)).toBe("aA");
  });

  it("decodes octal bytes as UTF-8, quoted or not", () => {
    expect(unquoteGitPath(String.raw`11.\345\270\270\347\224\250.md`)).toBe("11.常用.md");
    expect(unquoteGitPath(String.raw`"caf\303\251.txt"`)).toBe("café.txt");
  });

  it("decodes git's C escapes", () => {
    expect(unquoteGitPath(String.raw`"new\tq.txt"`)).toBe("new\tq.txt");
    expect(unquoteGitPath(String.raw`"old \"q\".txt"`)).toBe('old "q".txt');
    expect(unquoteGitPath(String.raw`"back\\slash\nline"`)).toBe("back\\slash\nline");
  });

  it("keeps an escape git would never write, rather than guessing", () => {
    expect(unquoteGitPath(String.raw`"a\qb"`)).toBe(String.raw`a\qb`);
    expect(unquoteGitPath(String.raw`"a\34"`)).toBe(String.raw`a\34`);
  });

  it("reads GitHub's quoted header back to the name a reader sees", () => {
    const [file] = parsePatch(QUOTED_PATH_HOST_PATCH, ANALYSIS_CACHE_KEY);
    // What the parser leaves: the escapes, not the name.
    expect(file?.path).toContain(String.raw`\345`);
    expect(unquoteGitPath(file?.path ?? "")).toBe("Day01-20/11.常用数据结构之字符串.md");
  });

  it("reads a quoted rename's names back too", () => {
    const [file] = parsePatch(
      String.raw`diff --git "a/old \"q\".txt" "b/new\tq.txt"
similarity index 80%
rename from "old \"q\".txt"
rename to "new\tq.txt"
index 1111111..2222222 100644
--- "a/old \"q\".txt"
+++ "b/new\tq.txt"
@@ -1 +1 @@
-a
+b
`,
      ANALYSIS_CACHE_KEY,
    );
    expect(unquoteGitPath(file?.path ?? "")).toBe("new\tq.txt");
    expect(unquoteGitPath(file?.previousPath ?? "")).toBe('old "q".txt');
  });
});
