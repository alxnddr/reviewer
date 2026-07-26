/** Real `git diff` output captured from a throwaway repo, covering every file status
 * the parser must handle. Shared by the parse tests and the dev-only browser preview
 * states. */

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
      (_, line) => `+export const v${fileIndex}_${line} = ${line};`,
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
