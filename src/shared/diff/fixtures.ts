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
