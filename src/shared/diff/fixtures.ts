/** Real `git diff` output captured from a throwaway repo, covering every file status
 * the parser must handle and the hunk geometries anchoring must survive. Shared by the
 * parse tests and the dev-only browser preview states. */

/** add + delete + modify + binary change + pure rename + second modify. */
export const MULTI_STATUS_PATCH = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..c15acb9
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+brand new file
+with two lines
diff --git a/doomed.txt b/doomed.txt
deleted file mode 100644
index 51d140e..0000000
--- a/doomed.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-to be deleted
-line2
diff --git a/greet.ts b/greet.ts
index 3056cd1..109cadb 100644
--- a/greet.ts
+++ b/greet.ts
@@ -1,3 +1,7 @@
 export function greet(name: string): string {
-  return \`hello \${name}\`;
+  return \`hi \${name}\`;
+}
+
+export function shout(name: string): string {
+  return greet(name).toUpperCase();
 }
diff --git a/img.png b/img.png
index 4488d3f..1332eb8 100644
Binary files a/img.png and b/img.png differ
diff --git a/oldname.txt b/newname.txt
similarity index 100%
rename from oldname.txt
rename to newname.txt
diff --git a/notes.txt b/notes.txt
index 9405325..91ac79b 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1,5 +1,6 @@
 a
-b
+B
 c
 d
 e
+f
`;

/** Rename with a content edit (similarity < 100%). */
export const RENAME_WITH_EDIT_PATCH = `diff --git a/newname.txt b/final.txt
similarity index 75%
rename from newname.txt
rename to final.txt
index f7010dd..7d0b036 100644
--- a/newname.txt
+++ b/final.txt
@@ -1,5 +1,5 @@
 renamed content line1
-line2
+line2 edited
 line3
 line4
 line5
`;

/** Two binaries renamed *and* edited, plus a text edit. Captured with git's default
 * `core.quotePath`, which the app's own capture turns off but an imported artifact's
 * embedded patch can carry: the second file's path is octal-escaped and quoted, so its
 * `diff --git` header and its `rename to` line spell the name differently — and the
 * parser takes the latter, quotes and all. `String.raw` because `\303` is not a legal
 * escape in a template literal. */
export const QUOTED_BINARY_RENAME_PATCH = String.raw`diff --git a/big-old.bin b/big-new.bin
similarity index 99%
rename from big-old.bin
rename to big-new.bin
index b17c966..29efdac 100644
Binary files a/big-old.bin and b/big-new.bin differ
diff --git "a/caf\303\251-old.bin" "b/caf\303\251-new.bin"
similarity index 99%
rename from "caf\303\251-old.bin"
rename to "caf\303\251-new.bin"
index b17c966..29efdac 100644
Binary files "a/caf\303\251-old.bin" and "b/caf\303\251-new.bin" differ
diff --git a/t.txt b/t.txt
index 8e27be7..f483c77 100644
--- a/t.txt
+++ b/t.txt
@@ -1 +1 @@
-text
+text2
`;

/** Both rename shapes in one diff — a pure rename (no hunks at all) and a rename that
 * also edited a line (hunks over the *old* file's line numbers on the deletions side).
 * The anchoring case: a comment authored on either file's pre-rename path has to find
 * it under its new one. */
export const RENAMES_PATCH = `diff --git a/src/old-edit.txt b/src/edit.txt
similarity index 69%
rename from src/old-edit.txt
rename to src/edit.txt
index abf8f72..88622b9 100644
--- a/src/old-edit.txt
+++ b/src/edit.txt
@@ -1,5 +1,5 @@
 edit line1
-edit line2
+edit line2 changed
 edit line3
 edit line4
 edit line5
diff --git a/src/old-pure.txt b/src/pure.txt
similarity index 100%
rename from src/old-pure.txt
rename to src/pure.txt
`;

/** One file, one modification hunk: new-file lines 8..16 carrying additions {11,12,13} against
 * old-file lines 8..14 carrying the deletion {11}, with three context lines either side. The
 * smallest geometry that exercises both sides' coordinates at once, so the anchor resolver, the
 * coverage universe, the snippet preview and the hunk walk are all proven against one fixture
 * rather than three that merely looked alike. */
export const ONE_HUNK_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 7624304..9ec2034 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -8,7 +8,9 @@ ctx7
 ctx8
 ctx9
 ctx10
-old11
+new11
+new12
+new13
 ctx12
 ctx13
 ctx14
`;

/** Two files, one hunk each: `src/foo.ts` carries a modification hunk over new-file lines
 * 10..14 (additions {11,12,13}) against old-file lines 10..12 (deletion {11}), and
 * `src/bar.ts` a hunk over new-file lines 1..3 (addition {2}). The tools fixture: a comment
 * anchor, a layer range, and a description link all need somewhere real to place, and the
 * second file is what makes "this one placed, that one did not" provable — so the emit gate,
 * the validator, and the app's render path are proven against one diff rather than three
 * inlined copies that merely looked alike. */
export const TWO_FILE_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@
 ctx10
-old11
+new11
+new12
+new13
 ctx14
diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,3 @@
 keep1
+added2
 keep3
`;

/** One file, two hunks: additions/deletions 1..6 and 27..33, with lines 7..26 collapsed
 * between them. The anchoring case for hunk geometry rather than file status — hunks
 * render contiguously, separated only by a visual row, so a selection can reach across
 * the collapsed gap that no single hunk covers. */
export const TWO_HUNKS_PATCH = `diff --git a/src/two-hunks.txt b/src/two-hunks.txt
index b5c3d22..f6d80db 100644
--- a/src/two-hunks.txt
+++ b/src/two-hunks.txt
@@ -1,6 +1,6 @@
 line1
 line2
-line3
+line3 changed
 line4
 line5
 line6
@@ -27,7 +27,7 @@ line26
 line27
 line28
 line29
-line30
+line30 changed
 line31
 line32
 line33
`;

/** Path with a space (git appends a tab after the +++ path). */
export const SPACED_NAME_PATCH = `diff --git a/sp ace.txt b/sp ace.txt
new file mode 100644
index 0000000..587be6b
--- /dev/null
+++ b/sp ace.txt\t
@@ -0,0 +1 @@
+x
`;

/** `fileCount` generated file additions of `linesPerFile` lines each — the many-files case. */
export function buildManyFilesPatch(fileCount: number, linesPerFile: number): string {
  return Array.from({ length: fileCount }, (_, fileIndex) => {
    const name = `src/file-${String(fileIndex).padStart(2, "0")}.ts`;
    const lines = Array.from(
      { length: linesPerFile },
      (_unused, line) => `+export const v${fileIndex}_${line} = ${line};`,
    );
    return [
      `diff --git a/${name} b/${name}`,
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      `+++ b/${name}`,
      `@@ -0,0 +1,${linesPerFile} @@`,
      ...lines,
      "",
    ].join("\n");
  }).join("");
}

/** One file, `hunkCount` hunks: line 10, 30, 50… each replaced, with no context, so hunk `n`
 * (from zero) is exactly line `10 + 20n` on both sides. The many-hunks case — a generated or
 * reformatted file — where a list of "every hunk" stops being a hint. */
export function buildManyHunksPatch(hunkCount: number): string {
  const name = "src/many-hunks.ts";
  const hunks = Array.from({ length: hunkCount }, (_, index) => {
    const line = 10 + 20 * index;
    return [`@@ -${line} +${line} @@`, `-old ${line}`, `+new ${line}`];
  });
  return [
    `diff --git a/${name} b/${name}`,
    "index 1111111..2222222 100644",
    `--- a/${name}`,
    `+++ b/${name}`,
    ...hunks.flat(),
    "",
  ].join("\n");
}

/** One generated addition per named path. The numbered builder above produces one
 * flat shape (`src/file-NN.ts`); a preview that has to show how a list narrows real
 * paths needs names and directories of differing depth, so it names them itself. */
export function buildPathsPatch(paths: readonly string[], linesPerFile: number): string {
  return paths
    .map((path, fileIndex) => {
      const lines = Array.from(
        { length: linesPerFile },
        (_, line) => `+export const v${fileIndex}_${line} = ${line};`,
      );
      return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 +1,${linesPerFile} @@`,
        ...lines,
        "",
      ].join("\n");
    })
    .join("");
}

/** A single-file addition of `lineCount` generated lines — the huge-file case. */
export function buildHugeAdditionPatch(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, index) => `+const value${index} = ${index};`);
  return [
    "diff --git a/huge.ts b/huge.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/huge.ts",
    `@@ -0,0 +1,${lineCount} @@`,
    ...lines,
    "",
  ].join("\n");
}

/** A new file of `count` one-line exported functions — the outline's "a new module is a table of
 * contents" case, where `MAX_SYMBOLS_PER_FILE` has to cut the list rather than the reader. */
export function buildExportsPatch(count: number): string {
  const lines = Array.from(
    { length: count },
    (_, index) => `+export function step${index}(): number { return ${index}; }`,
  );
  return [
    "diff --git a/steps.ts b/steps.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/steps.ts",
    `@@ -0,0 +1,${count} @@`,
    ...lines,
    "",
  ].join("\n");
}

/** A function moved whole from one file to another, and re-indented on the way — the case
 * move detection exists for. The deleted run is `src/moved-from.ts` old-file lines 3..10
 * (seven lines of function plus the blank after it); the added run is `src/moved-to.ts`
 * new-file lines 3..10, the same lines at four-space indentation. Whitespace is the only
 * difference, which is what makes this fixture prove the normalization rather than assume it. */
export const MOVED_BLOCK_PATCH = `diff --git a/src/moved-from.ts b/src/moved-from.ts
index 1111111..2222222 100644
--- a/src/moved-from.ts
+++ b/src/moved-from.ts
@@ -1,13 +1,5 @@
 import { helper } from "./helper";
 
-export function formatTitle(input: string): string {
-  const trimmed = input.trim();
-  if (trimmed.length === 0) {
-    return "untitled";
-  }
-  return trimmed.toUpperCase();
-}
-
 export function render(input: string): string {
   return helper(formatTitle(input));
 }
diff --git a/src/moved-to.ts b/src/moved-to.ts
index 3333333..4444444 100644
--- a/src/moved-to.ts
+++ b/src/moved-to.ts
@@ -1,5 +1,13 @@
 export const VERSION = 1;
 
+export function formatTitle(input: string): string {
+    const trimmed = input.trim();
+    if (trimmed.length === 0) {
+      return "untitled";
+    }
+    return trimmed.toUpperCase();
+}
+
 export function version(): string {
   return "v" + VERSION;
 }
`;

/** Two moves that are not the same thing. `src/reorder.ts` really moves a function past the
 * one below it — old-file lines 1..4 leave, new-file lines 5..8 arrive, and the two spans do
 * not overlap. `src/reindented.ts` only re-indents three lines where they stand: a perfect
 * line-for-line match from `2..4` to `2..4`, which is a true statement and a useless one, and
 * is what the in-place rule exists to throw away. */
export const IN_FILE_MOVE_PATCH = `diff --git a/src/reindented.ts b/src/reindented.ts
index 5555555..6666666 100644
--- a/src/reindented.ts
+++ b/src/reindented.ts
@@ -1,6 +1,6 @@
 export function pad(value: string): string {
-  if (value.length > 3) {
-    return value;
-  }
+    if (value.length > 3) {
+      return value;
+    }
   return value.padStart(3, "0");
 }
diff --git a/src/reorder.ts b/src/reorder.ts
index 7777777..8888888 100644
--- a/src/reorder.ts
+++ b/src/reorder.ts
@@ -1,12 +1,12 @@
-function alpha(value: number): number {
-  return value + 1;
-}
-
 function beta(value: number): number {
   return value * 2;
 }
 
+function alpha(value: number): number {
+  return value + 1;
+}
+
 export const table = {
   alpha,
   beta,
 };
`;

/** Two independent rewrites that happen to share their first three lines and their last two —
 * the coincidence the thresholds have to refuse. Each side is an eleven-line run, so the
 * three-line preamble is 27% of the shorter block and fails the coverage rule, and the
 * two-line `return merged; }` tail is below the three-line floor. Nothing here is a move. */
export const NEAR_MISS_MOVE_PATCH = `diff --git a/src/near-a.ts b/src/near-a.ts
index 9999999..aaaaaaa 100644
--- a/src/near-a.ts
+++ b/src/near-a.ts
@@ -1,12 +1,2 @@
-export function optionsFor(kind: string): Options {
-  const base = defaults();
-  const merged = Object.assign({}, base);
-  merged.kind = kind;
-  merged.retries = 3;
-  merged.timeout = 5000;
-  merged.verbose = false;
-  merged.label = kind + "-a";
-  merged.order = 1;
-  return merged;
-}
+export const optionsFor = memoize(buildOptions);
 
diff --git a/src/near-b.ts b/src/near-b.ts
index bbbbbbb..ccccccc 100644
--- a/src/near-b.ts
+++ b/src/near-b.ts
@@ -1,1 +1,13 @@
+export function optionsFor(kind: string): Options {
+  const base = defaults();
+  const merged = Object.assign({}, base);
+  merged.strategy = "eager";
+  merged.window = 12;
+  merged.cache = true;
+  merged.label = kind + "-b";
+  merged.order = 2;
+  merged.tag = "b";
+  merged.extra = null;
+  return merged;
+}
 
`;

/** `fileCount` files that each delete `linesPerFile` lines and add `linesPerFile` lines, where
 * file N adds exactly what file N-1 deleted — a diff that is nothing *but* moves, which is the
 * shape that makes move detection work hardest: every seed finds a candidate and every
 * candidate extends the whole way. The generated text is unique per source file, so the seed
 * index stays honest rather than collapsing under `MAX_SEED_OCCURRENCES`. Used to measure the
 * detection cost rather than assume it. */
export function buildMovedLinesPatch(fileCount: number, linesPerFile: number): string {
  const body = (fileIndex: number): string[] =>
    Array.from(
      { length: linesPerFile },
      (_unused, line) => `export const moved${fileIndex}_${line} = ${line} * ${fileIndex + 1};`,
    );
  return Array.from({ length: fileCount }, (_unused, fileIndex) => {
    const name = `src/moved-${String(fileIndex).padStart(3, "0")}.ts`;
    const removed = body(fileIndex).map((line) => `-${line}`);
    const added = body((fileIndex + fileCount - 1) % fileCount).map((line) => `+${line}`);
    return [
      `diff --git a/${name} b/${name}`,
      "index 1111111..2222222 100644",
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -1,${linesPerFile + 1} +1,${linesPerFile + 1} @@`,
      ...removed,
      ...added,
      " // tail",
      "",
    ].join("\n");
  }).join("");
}

/** One change to `src/loop.c`, diffed twice from the same two commits: once with
 * `--diff-algorithm=myers` (git's default) and once with `--diff-algorithm=histogram`. Captured
 * from a throwaway repo. Myers aligns it as two hunks — new-file lines 7..13 and 18..27 — and
 * histogram as one, 7..27, so new-file lines 14..17 are context in one diff and collapsed away
 * in the other. The hunk-boundary case for checking a review against the code host's diff: a
 * reader whose `diff.algorithm` differs from the host's sees lines the host has no hunk for. */
export const MYERS_PATCH = `diff --git a/src/loop.c b/src/loop.c
index fe91b24..9f12e17 100644
--- a/src/loop.c
+++ b/src/loop.c
@@ -7,7 +7,7 @@ foo();
 int g() {
 return x;
 x++;
-int f() {
+int g() {
 bar();
 }
 x++;
@@ -18,13 +18,10 @@ bar();
 bar();
 foo();
 }
-foo();
 int g() {
-}
 x++;
 }
 int g() {
-return x;
-x++;
 int g() {
+return x;
 int g() {
`;

/** `MYERS_PATCH`'s change, aligned by `--diff-algorithm=histogram`: one hunk over new-file
 * lines 7..27. */
export const HISTOGRAM_PATCH = `diff --git a/src/loop.c b/src/loop.c
index fe91b24..9f12e17 100644
--- a/src/loop.c
+++ b/src/loop.c
@@ -7,24 +7,21 @@ foo();
 int g() {
 return x;
 x++;
-int f() {
-bar();
-}
-x++;
-bar();
-}
-
-
-bar();
-foo();
-}
-foo();
 int g() {
+bar();
 }
 x++;
+bar();
 }
+
+
+bar();
+foo();
+}
+int g() {
+x++;
+}
+int g() {
 int g() {
 return x;
-x++;
-int g() {
 int g() {
`;

/** A pull request's diff as the code host shows it — against the base branch as it is now.
 * Captured from a throwaway repo: `main` gained a commit (`src/config.ts`, and line 2 of
 * `src/list.txt`) after which the pull request branched and changed lines 5 and 18 of
 * `src/list.txt`. `git diff main...pr`: one file, two hunks, new-file lines 2..8 and 15..20. */
export const STALE_BASE_HOST_PATCH = `diff --git a/src/list.txt b/src/list.txt
index 12f810b..fb1cdf0 100644
--- a/src/list.txt
+++ b/src/list.txt
@@ -2,7 +2,7 @@ line 1
 line 2 (from main)
 line 3
 line 4
-line 5
+line 5 (from the pr)
 line 6
 line 7
 line 8
@@ -15,6 +15,6 @@ line 14
 line 15
 line 16
 line 17
-line 18
+line 18 (from the pr)
 line 19
 line 20
`;

/** The same pull request diffed against a *stale* local `main` that never fetched that commit:
 * the merge base moves back, so the diff also carries `main`'s own change — all of
 * `src/config.ts`, and line 2 of `src/list.txt`, which widens the first hunk to new-file lines
 * 1..8. `git diff stale-main...pr` from the same repo as `STALE_BASE_HOST_PATCH`. */
export const STALE_BASE_LOCAL_PATCH = `diff --git a/src/config.ts b/src/config.ts
index 982290e..181bbd0 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,2 @@
-export const retries = 3;
+export const retries = 5;
 export const timeoutMs = 1000;
diff --git a/src/list.txt b/src/list.txt
index c4352f8..fb1cdf0 100644
--- a/src/list.txt
+++ b/src/list.txt
@@ -1,8 +1,8 @@
 line 1
-line 2
+line 2 (from main)
 line 3
 line 4
-line 5
+line 5 (from the pr)
 line 6
 line 7
 line 8
@@ -15,6 +15,6 @@ line 14
 line 15
 line 16
 line 17
-line 18
+line 18 (from the pr)
 line 19
 line 20
`;

/** A pull request's diff exactly as GitHub's API returned it (`jackfrued/Python-100-Days#1207`,
 * fetched 2026-10-03): one file whose name is outside ASCII, so GitHub — like git with its
 * default `core.quotePath` — writes it C-quoted with octal escapes in every header line. The
 * parser keeps the escapes (`git-path.ts` says how), so the name it reports is not the name a
 * reader sees. `String.raw` because `\345` is not a legal escape in a template literal. */
export const QUOTED_PATH_HOST_PATCH = String.raw`diff --git "a/Day01-20/11.\345\270\270\347\224\250\346\225\260\346\215\256\347\273\223\346\236\204\344\271\213\345\255\227\347\254\246\344\270\262.md" "b/Day01-20/11.\345\270\270\347\224\250\346\225\260\346\215\256\347\273\223\346\236\204\344\271\213\345\255\227\347\254\246\344\270\262.md"
index 38e2ffc807..3bc7023f20 100755
--- "a/Day01-20/11.\345\270\270\347\224\250\346\225\260\346\215\256\347\273\223\346\236\204\344\271\213\345\255\227\347\254\246\344\270\262.md"
+++ "b/Day01-20/11.\345\270\270\347\224\250\346\225\260\346\215\256\347\273\223\346\236\204\344\271\213\345\255\227\347\254\246\344\270\262.md"
@@ -4,7 +4,7 @@
 
 <img src="res/day11/eniac.jpg" style="zoom:50%;">
 
-随着时间的推移，虽然数值运算仍然是计算机日常工作中最为重要的组成部分，但是今天的计算机还要处理大量的以文本形式存在的信息。如果我们希望通过 Python 程序来操作本这些文本信息，就必须要先了解字符串这种数据类型以及与它相关的运算和方法。
+随着时间的推移，虽然数值运算仍然是计算机日常工作中最为重要的组成部分，但是今天的计算机还要处理大量的以文本形式存在的信息。如果我们希望通过 Python 程序来操作这些文本信息，就必须要先了解字符串这种数据类型以及与它相关的运算和方法。
 
 ### 字符串的定义
 
`;

/** `QUOTED_PATH_HOST_PATCH`'s change as this app captures it, with `core.quotePath` off: the
 * same hunk under the plain UTF-8 name, `Day01-20/11.常用数据结构之字符串.md`. */
export const QUOTED_PATH_LOCAL_PATCH = `diff --git a/Day01-20/11.常用数据结构之字符串.md b/Day01-20/11.常用数据结构之字符串.md
index 38e2ffc807..3bc7023f20 100755
--- a/Day01-20/11.常用数据结构之字符串.md
+++ b/Day01-20/11.常用数据结构之字符串.md
@@ -4,7 +4,7 @@
 
 <img src="res/day11/eniac.jpg" style="zoom:50%;">
 
-随着时间的推移，虽然数值运算仍然是计算机日常工作中最为重要的组成部分，但是今天的计算机还要处理大量的以文本形式存在的信息。如果我们希望通过 Python 程序来操作本这些文本信息，就必须要先了解字符串这种数据类型以及与它相关的运算和方法。
+随着时间的推移，虽然数值运算仍然是计算机日常工作中最为重要的组成部分，但是今天的计算机还要处理大量的以文本形式存在的信息。如果我们希望通过 Python 程序来操作这些文本信息，就必须要先了解字符串这种数据类型以及与它相关的运算和方法。
 
 ### 字符串的定义
 
`;

/** Six files — five of code in four languages, and one of prose — captured with the app's own `DIFF_CONFIG` /
 * `DIFF_ARGS` from a throwaway repo — the outline fixture (`outline.ts`). What each file proves:
 *
 *   - `src/blob.ts`: a signature change (`loadBlob` gains a parameter and `async`), a method
 *     whose signature changed (`record`), an added arrow const (`patchText`), a removed
 *     *non-exported* const that must not surface (`blobCache`), and a body-only change found
 *     from a declaration in the hunk's own leading context (`size`).
 *   - `src/handlers.ts`: git's hunk header names the *wrong* function (`first`, the nearest
 *     column-0 line above the hunk) while the edit is in `second`, whose declaration is in the
 *     hunk's context; and a removed function (`third`) in the same change block.
 *   - `cmd/server.go`: an added struct, a paired signature change, and a body-only hunk whose
 *     only clue is the header's funcname (`func (s *Server) Handle`).
 *   - `tools/sync.py`: a deep body edit attributed to the header's `class Syncer:`, and an
 *     added `def`.
 *   - `scripts/install.sh`: an added shell function, and a top-level edit attributed to nothing.
 *   - `README.md`: prose that reads like a declaration (`function loadBlob(path) …`) and must
 *     not be outlined, because markdown is not code. */
export const OUTLINE_PATCH = `diff --git a/README.md b/README.md
index b5ce304..9195199 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Demo
 
 The loader reads blobs.
+function loadBlob(path) now retries.
diff --git a/cmd/server.go b/cmd/server.go
index bf358a1..5c7805b 100644
--- a/cmd/server.go
+++ b/cmd/server.go
@@ -2,8 +2,12 @@ package main
 
 import "fmt"
 
-func serve(addr string) error {
-	fmt.Println("listening on", addr)
+type Server struct {
+	name string
+}
+
+func serve(addr string, name string) error {
+	fmt.Println("listening on", addr, "as", name)
 	return nil
 }
 
@@ -12,7 +16,7 @@ func (s *Server) Handle(path string) string {
 		return "index"
 	}
 	if path == "/health" {
-		return "ok"
+		return "ok: " + s.name
 	}
 	return "not found: " + path
 }
diff --git a/scripts/install.sh b/scripts/install.sh
index dbbbde6..e6cf62b 100644
--- a/scripts/install.sh
+++ b/scripts/install.sh
@@ -1,5 +1,9 @@
 #!/bin/sh
 set -e
 
+install_bin() {
+  cp "$1" /usr/local/bin/
+}
+
 echo "installing"
-cp rvw /usr/local/bin/rvw
+install_bin rvw
diff --git a/src/blob.ts b/src/blob.ts
index 0fcf847..5cec87b 100644
--- a/src/blob.ts
+++ b/src/blob.ts
@@ -1,27 +1,24 @@
 import { fetchBlob } from "./net";
+import { withRetry } from "./retry";
 
-const blobCache = new Map<string, Promise<string>>();
-
-export function loadBlob(path: string): Promise<string> {
-  const cached = blobCache.get(path);
-  if (cached !== undefined) {
-    return cached;
-  }
-  const read = fetchBlob(path);
-  blobCache.set(path, read);
-  return read;
+export async function loadBlob(path: string, attempts = 3): Promise<string> {
+  return withRetry(() => fetchBlob(path), attempts);
 }
 
+export const patchText = (previous: string, next: string): string => {
+  return previous === next ? previous : next;
+};
+
 export class Manifest {
   private entries: string[] = [];
 
-  record(path: string): void {
-    this.entries.push(path);
+  record(path: string, attempt: number): void {
+    this.entries.push(\`\${path}#\${attempt}\`);
   }
 
   size(): number {
     const count = this.entries.length;
-    if (count > 100) {
+    if (count > 500) {
       console.warn("large manifest");
     }
     return count;
diff --git a/src/handlers.ts b/src/handlers.ts
index e9636db..96df068 100644
--- a/src/handlers.ts
+++ b/src/handlers.ts
@@ -4,9 +4,5 @@ export function first(): number {
 
 export function second(): number {
   const a = 1;
-  return a + 1;
-}
-
-function third(): void {
-  console.log("third");
+  return a + 2;
 }
diff --git a/tools/sync.py b/tools/sync.py
index ef8026e..70711e8 100644
--- a/tools/sync.py
+++ b/tools/sync.py
@@ -11,10 +11,14 @@ class Syncer:
             return 0
         self.client.open()
         for item in pending:
-            self.client.send(item)
+            self.client.send(item, retry=True)
         self.client.close()
         return len(pending)
 
 
 def helper(value):
     return value * 2
+
+
+def backoff(attempt: int) -> float:
+    return min(2 ** attempt, 30)
`;

/** Sixteen files in eight languages, captured with the app's own `DIFF_CONFIG` / `DIFF_ARGS` from
 * a throwaway repo — the dependency-diff fixture (`imports.ts`). What each file proves:
 *
 *   - `web/viewer.tsx`: a relative import retargeted (`../src/cache` → `../src/blob`), an import
 *     *moved* (`react`, removed at the top and re-added lower: no change), a multi-line import
 *     read from its closing `} from` line through a learned alias (`@/components/ui` →
 *     `web/components/ui/index.ts`), a re-export from a scoped package's deep path, a dynamic
 *     `import()`, a removed `require()` of a deep path (`lodash/merge` → `lodash`), and a string
 *     holding a dynamic `import()` of a package that must not count.
 *   - `src/cache.ts` (deleted) and `lib/retry.ts` (added): every statement of a whole file, one
 *     way each; `./clock.js` is ESM-style for a `.ts` the diff does not carry.
 *   - `src/blob.ts`: an added relative import of a file the diff adds, beside a context one.
 *   - `tools/sync.py` / `app/store.py`: Python's plain, relative (`.policy`) and absolute-internal
 *     (`app.store`, a changed file; `app.models`, a directory the diff shows) imports.
 *   - `cmd/server.go`: specs inside an `import ( … )` block, one retargeted from a package the
 *     change deletes (`internal/cache`) to one it adds (`internal/store`); `internal/store`'s
 *     own single-line `import "os"`.
 *   - `engine/src/main.rs`: `std::…::HashMap` → `std::…::BTreeMap` (same package: no change), a
 *     `crate::` path to a file the diff adds, and an external crate.
 *   - `android/…/Main.kt`, `app/Sources/Viewer/View.swift`, `scripts/release.rb`: Kotlin, Swift
 *     and Ruby (`require` and `require_relative`).
 *   - `README.md`: an indented code sample that reads like an import and must not, because
 *     Markdown is not code. */
export const IMPORTS_PATCH = `diff --git a/README.md b/README.md
index 0805455..e967a45 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,3 @@
 # Demo
+
+    import { loadBlob } from "./src/blob";
diff --git a/android/src/main/kotlin/demo/Main.kt b/android/src/main/kotlin/demo/Main.kt
index 86d7c99..b904a67 100644
--- a/android/src/main/kotlin/demo/Main.kt
+++ b/android/src/main/kotlin/demo/Main.kt
@@ -1,7 +1,7 @@
 package demo
 
-import demo.cache.Store
+import kotlinx.coroutines.delay
 
-fun main() {
-    println(Store.size())
+suspend fun main() {
+    delay(10)
 }
diff --git a/app/Sources/Viewer/View.swift b/app/Sources/Viewer/View.swift
new file mode 100644
index 0000000..2a851b8
--- /dev/null
+++ b/app/Sources/Viewer/View.swift
@@ -0,0 +1,6 @@
+import SwiftUI
+import Combine
+
+struct Viewer: View {
+    var body: some View { Text("hi") }
+}
diff --git a/app/store.py b/app/store.py
new file mode 100644
index 0000000..8326259
--- /dev/null
+++ b/app/store.py
@@ -0,0 +1,7 @@
+import json
+
+from app.models import Blob
+
+
+def save(response):
+    return Blob(json.loads(response.text))
diff --git a/cmd/server.go b/cmd/server.go
index 76ac91b..b5a6438 100644
--- a/cmd/server.go
+++ b/cmd/server.go
@@ -2,10 +2,12 @@ package main
 
 import (
 	"fmt"
+	"net/http"
 
-	"example.com/demo/internal/cache"
+	"example.com/demo/internal/store"
 )
 
 func main() {
-	fmt.Println(cache.Size())
+	fmt.Println(store.Size())
+	http.ListenAndServe(":8080", nil)
 }
diff --git a/engine/src/main.rs b/engine/src/main.rs
index 922fcea..d104ffa 100644
--- a/engine/src/main.rs
+++ b/engine/src/main.rs
@@ -1,6 +1,8 @@
-use std::collections::HashMap;
+use std::collections::BTreeMap;
+use crate::retry::Policy;
+use serde::Deserialize;
 
 fn main() {
-    let map: HashMap<String, u32> = HashMap::new();
-    println!("{}", map.len());
+    let map: BTreeMap<String, u32> = BTreeMap::new();
+    println!("{} {:?}", map.len(), Policy::default());
 }
diff --git a/engine/src/retry.rs b/engine/src/retry.rs
new file mode 100644
index 0000000..36a1db9
--- /dev/null
+++ b/engine/src/retry.rs
@@ -0,0 +1,2 @@
+#[derive(Debug, Default)]
+pub struct Policy;
diff --git a/internal/cache/cache.go b/internal/cache/cache.go
deleted file mode 100644
index 0f11cb9..0000000
--- a/internal/cache/cache.go
+++ /dev/null
@@ -1,3 +0,0 @@
-package cache
-
-func Size() int { return 0 }
diff --git a/internal/store/store.go b/internal/store/store.go
new file mode 100644
index 0000000..ae5990b
--- /dev/null
+++ b/internal/store/store.go
@@ -0,0 +1,5 @@
+package store
+
+import "os"
+
+func Size() int { return len(os.Args) }
diff --git a/lib/retry.ts b/lib/retry.ts
new file mode 100644
index 0000000..a7feff8
--- /dev/null
+++ b/lib/retry.ts
@@ -0,0 +1,6 @@
+import pRetry from "p-retry";
+import { sleep } from "./clock.js";
+
+export function withRetry<T>(run: () => Promise<T>): Promise<T> {
+  return pRetry(run, { onFailedAttempt: () => sleep(10) });
+}
diff --git a/scripts/release.rb b/scripts/release.rb
index 1b6b214..625b8c2 100644
--- a/scripts/release.rb
+++ b/scripts/release.rb
@@ -1 +1,4 @@
-puts "releasing"
+require "json"
+require_relative "../lib/version"
+
+puts "releasing #{Version::NAME}"
diff --git a/src/blob.ts b/src/blob.ts
index 9b65412..f70fd25 100644
--- a/src/blob.ts
+++ b/src/blob.ts
@@ -1,5 +1,6 @@
 import { fetchBlob } from "./net";
+import { withRetry } from "../lib/retry";
 
 export function loadBlob(path: string): Promise<string> {
-  return fetchBlob(path);
+  return withRetry(() => fetchBlob(path));
 }
diff --git a/src/cache.ts b/src/cache.ts
deleted file mode 100644
index f6f277d..0000000
--- a/src/cache.ts
+++ /dev/null
@@ -1,8 +0,0 @@
-import { LRU } from "lru-cache";
-import { fetchBlob } from "./net";
-
-export const cache = new LRU<string, string>(100);
-
-export function cached(path: string): Promise<string> {
-  return fetchBlob(path);
-}
diff --git a/tools/sync.py b/tools/sync.py
index 8b37289..4a774d8 100644
--- a/tools/sync.py
+++ b/tools/sync.py
@@ -1,6 +1,9 @@
 import os
-import requests
+import httpx
+
+from .policy import backoff
+from app.store import save
 
 
 def sync(url):
-    return requests.get(url, timeout=os.environ.get("T"))
+    save(httpx.get(url, timeout=backoff(os.environ.get("T"))))
diff --git a/web/components/ui/index.ts b/web/components/ui/index.ts
new file mode 100644
index 0000000..88a20d1
--- /dev/null
+++ b/web/components/ui/index.ts
@@ -0,0 +1,2 @@
+export { Panel } from "./panel";
+export { Toolbar } from "./toolbar";
diff --git a/web/viewer.tsx b/web/viewer.tsx
index 98c5d51..13838ef 100644
--- a/web/viewer.tsx
+++ b/web/viewer.tsx
@@ -1,10 +1,17 @@
-import { useState } from "react";
-import { loadBlob } from "../src/cache";
+import { loadBlob } from "../src/blob";
 import { Header } from "./header";
+import {
+  Panel,
+  Toolbar,
+} from "@/components/ui";
+import { useState } from "react";
+
+export * from "@scope/kit/icons";
 
-const legacy = require("lodash/merge");
+const probe = 'import("katex")';
 
-export function Viewer(): JSX.Element {
+export async function Viewer(): Promise<JSX.Element> {
   const [path] = useState("");
-  return <Header title={legacy({}, loadBlob(path))} />;
+  const worker = await import("./worker");
+  return <Panel><Toolbar /><Header title={worker.render(loadBlob(path), probe)} /></Panel>;
 }
`;

/** Three files that rewire `OUTLINE_PATCH`'s retry story, captured the same way, for the guide
 * preview's Deps tab and the dependency graph's tests: the session cache is deleted (`lru-cache`
 * and `./net` go with it), the retry helper `src/blob.ts` imports is added (with `p-retry` and a
 * `../lib/clock` the diff does not carry), and the viewer swaps `../src/cache` for
 * `../src/blob` — one module edge both removed and added. Disjoint from `OUTLINE_PATCH`'s paths,
 * so the two concatenate into one diff. */
export const GUIDE_DEPS_PATCH = `diff --git a/src/cache.ts b/src/cache.ts
deleted file mode 100644
index 0705935..0000000
--- a/src/cache.ts
+++ /dev/null
@@ -1,8 +0,0 @@
-import { LRUCache } from "lru-cache";
-import { fetchBlob } from "./net";
-
-export const blobCache = new LRUCache<string, Promise<string>>({ max: 500 });
-
-export function cachedRead(path: string): Promise<string> {
-  return blobCache.get(path) ?? fetchBlob(path);
-}
diff --git a/src/retry.ts b/src/retry.ts
new file mode 100644
index 0000000..b4c0cc8
--- /dev/null
+++ b/src/retry.ts
@@ -0,0 +1,6 @@
+import pRetry from "p-retry";
+import { sleep } from "../lib/clock";
+
+export function withRetry<T>(read: () => Promise<T>, attempts: number): Promise<T> {
+  return pRetry(read, { retries: attempts, onFailedAttempt: () => sleep(250) });
+}
diff --git a/web/viewer.ts b/web/viewer.ts
index 829618b..039ed5e 100644
--- a/web/viewer.ts
+++ b/web/viewer.ts
@@ -1,6 +1,6 @@
-import { cachedRead } from "../src/cache";
+import { loadBlob } from "../src/blob";
 import { render } from "./render";
 
 export async function show(path: string): Promise<string> {
-  return render(await cachedRead(path));
+  return render(await loadBlob(path));
 }
`;

/** Lines built to make a backtracking pattern split a run every possible way: a prefix some
 * pattern of the outline, the import reader or the snippet's noise filter starts with, then a
 * long run of what that pattern's quantifiers take, then one character that fails the match at
 * the very end. A PR's author picks their lines, so the linearity tests run every pattern over
 * all of these at `length` far past the read budget, where a polynomial cannot hide. */
export function backtrackingLines(length: number): string[] {
  const prefixes = [
    "",
    "  ",
    "function",
    "export function f",
    "type X",
    "  f():",
    "  f(",
    "  public ",
    "def f",
    "fun a.",
    "func (",
    "class ",
    "f()",
    "import a",
    "import ",
    "from .",
    "require",
    "export {",
    '"x"',
    "use ",
    "@a ",
  ];
  const runs = [" ", "\t", ")", "):", "public ", "a", ".", "<", "@a ", "*", ",", "a ", "from "];
  const lines: string[] = [];
  for (const prefix of prefixes) {
    for (const run of runs) {
      const body = run.repeat(Math.ceil(length / run.length));
      lines.push(`${prefix}${body}`.slice(0, length - 1) + "x");
    }
  }
  return lines;
}
