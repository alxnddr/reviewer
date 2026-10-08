import { describe, expect, it } from "vitest";
import { resolveAnchor } from "./anchor";
import {
  backtrackingLines,
  buildHugeAdditionPatch,
  GUIDE_DEPS_PATCH,
  IMPORTS_PATCH,
  OUTLINE_PATCH,
} from "./fixtures";
import {
  dependencyDiff,
  detectImports,
  IMPORT_PATTERNS,
  joinPath,
  jsPackageName,
  learnAliases,
  type DependencyTarget,
  type ImportLanguage,
  type FileDependencies,
} from "./imports";
import { parsePatch } from "./patch";

// The dependency diff feeds a picture of how a change rewires its modules, so its tests pin both
// halves of "conservative" the outline's do: what it reads off a real captured diff in eight
// languages (`IMPORTS_PATCH`, file by file), and what it refuses — prose, a string that only
// mentions `import(…)`, an import that merely moved. The invariant at the bottom is the contract
// with the UI: every statement opens on a changed line an anchor places on.

const files = parsePatch(IMPORTS_PATCH, "imports-test");
const diff = dependencyDiff(files);

function of(path: string): FileDependencies {
  const found = diff.find((entry) => entry.path === path);
  if (found === undefined) {
    throw new Error(`no dependencies for ${path}`);
  }
  return found;
}

/** A file's changes as `±specifier → target` lines, which read like the diff they came from. */
function summary(path: string): string[] {
  const name = (target: DependencyTarget): string => {
    switch (target.kind) {
      case "internal":
        return `${target.path}${target.directory ? "/" : ""}${target.inDiff ? "" : " (not in diff)"}`;
      case "package":
        return `package ${target.name}`;
      case "unresolved":
        return `unresolved ${target.specifier}`;
    }
  };
  const entry = of(path);
  return [
    ...entry.added.map((change) => `+${change.specifier} → ${name(change.target)}`),
    ...entry.removed.map((change) => `-${change.specifier} → ${name(change.target)}`),
  ];
}

describe("dependencyDiff over IMPORTS_PATCH", () => {
  it("reads TS/JS statements, calls, re-exports and a learned alias; pairs a moved import", () => {
    expect(summary("web/viewer.tsx")).toEqual([
      "+../src/blob → src/blob.ts",
      "+@/components/ui → web/components/ui/index.ts",
      "+@scope/kit/icons → package @scope/kit",
      "+./worker → web/worker (not in diff)",
      "-../src/cache → src/cache.ts",
      "-lodash/merge → package lodash",
    ]);
  });

  it("places each statement on its own changed line — the closing line of a multi-line import", () => {
    const viewer = of("web/viewer.tsx");
    expect(viewer.added.map((change) => change.line)).toEqual([1, 6, 9, 15]);
    expect(viewer.added.every((change) => change.side === "additions")).toBe(true);
    expect(viewer.removed.map((change) => [change.side, change.line])).toEqual([
      ["deletions", 2],
      ["deletions", 5],
    ]);
  });

  it("reads every statement of a deleted and of an added file, one way each", () => {
    expect(summary("src/cache.ts")).toEqual([
      "-lru-cache → package lru-cache",
      "-./net → src/net (not in diff)",
    ]);
    expect(summary("lib/retry.ts")).toEqual([
      "+p-retry → package p-retry",
      "+./clock.js → lib/clock.js (not in diff)",
    ]);
  });

  it("keeps a context-line import as evidence, not as a change", () => {
    const blob = of("src/blob.ts");
    expect(summary("src/blob.ts")).toEqual(["+../lib/retry → lib/retry.ts"]);
    expect(blob.unchanged.map((change) => change.specifier)).toEqual(["./net"]);
  });

  it("reads Python's plain, relative and absolute-internal imports", () => {
    expect(summary("tools/sync.py")).toEqual([
      "+httpx → package httpx",
      "+.policy → tools/policy.py (not in diff)",
      "+app.store → app/store.py",
      "-requests → package requests",
    ]);
    // `app/` holds a changed Python file, so `app.models` is this repository's, not a package.
    expect(summary("app/store.py")).toEqual([
      "+json → package json",
      "+app.models → app/models.py (not in diff)",
    ]);
  });

  it("reads Go block specs, retargeted from a deleted package to an added one", () => {
    expect(summary("cmd/server.go")).toEqual([
      "+net/http → package net/http",
      "+example.com/demo/internal/store → internal/store/",
      "-example.com/demo/internal/cache → internal/cache/",
    ]);
    expect(summary("internal/store/store.go")).toEqual(["+os → package os"]);
  });

  it("pairs Rust's HashMap → BTreeMap off (same package) and resolves `crate::`", () => {
    expect(summary("engine/src/main.rs")).toEqual([
      "+crate::retry::Policy → engine/src/retry.rs",
      "+serde::Deserialize → package serde",
    ]);
  });

  it("reads Kotlin, Swift and Ruby", () => {
    expect(summary("android/src/main/kotlin/demo/Main.kt")).toEqual([
      "+kotlinx.coroutines.delay → package kotlinx.coroutines",
      "-demo.cache.Store → android/src/main/kotlin/demo/cache/ (not in diff)",
    ]);
    expect(summary("app/Sources/Viewer/View.swift")).toEqual([
      "+SwiftUI → package SwiftUI",
      "+Combine → package Combine",
    ]);
    expect(summary("scripts/release.rb")).toEqual([
      "+json → package json",
      "+../lib/version → lib/version.rb (not in diff)",
    ]);
  });

  it("reads nothing out of prose, and lists only files that show an import", () => {
    expect(diff.map((entry) => entry.path)).not.toContain("README.md");
    expect(diff.map((entry) => entry.path)).not.toContain("engine/src/retry.rs");
  });

  it("leaves out what `skip` refuses", () => {
    const skipped = dependencyDiff(files, { skip: (file) => file.path.startsWith("web/") });
    expect(skipped.some((entry) => entry.path.startsWith("web/"))).toBe(false);
  });

  it("takes a configured alias over a learned one", () => {
    const configured = dependencyDiff(files, { aliases: { "@/": "elsewhere/" } });
    const viewer = configured.find((entry) => entry.path === "web/viewer.tsx");
    expect(viewer?.added[1]?.target).toEqual({
      kind: "internal",
      path: "elsewhere/components/ui",
      directory: false,
      inDiff: false,
    });
  });

  it("opens every statement on a changed line an anchor places on", () => {
    for (const patch of [IMPORTS_PATCH, OUTLINE_PATCH + GUIDE_DEPS_PATCH]) {
      const parsed = parsePatch(patch, "anchor-check");
      for (const entry of dependencyDiff(parsed)) {
        const file = parsed.find((candidate) => candidate.path === entry.path);
        for (const change of [...entry.added, ...entry.removed]) {
          const anchor = {
            file: entry.path,
            side: change.side,
            startLine: change.line,
            endLine: change.line,
          };
          expect(
            resolveAnchor(anchor, { kind: "derived", file: file?.fileDiff ?? null }).status,
            `${entry.path}:${change.line}`,
          ).toBe("placed");
        }
      }
    }
  });
});

describe("dependencyDiff over the guide's patches", () => {
  it("resolves OUTLINE_PATCH's `./retry` into GUIDE_DEPS_PATCH's added file once both are loaded", () => {
    const both = dependencyDiff(parsePatch(OUTLINE_PATCH + GUIDE_DEPS_PATCH, "guide"));
    const blob = both.find((entry) => entry.path === "src/blob.ts");
    expect(blob?.added.map((change) => change.target)).toEqual([
      { kind: "internal", path: "src/retry.ts", directory: false, inDiff: true },
    ]);
  });
});

describe("detectImports", () => {
  it("refuses call forms glued to what precedes them, and comments", () => {
    expect(detectImports(`const probe = 'import("katex")';`, "js")).toEqual([]);
    expect(detectImports(`expect(src).toContain("require('x')")`, "js")).toEqual([]);
    expect(detectImports(`module.require("x")`, "js")).toEqual([]);
    expect(detectImports(`// import { a } from "b";`, "js")).toEqual([]);
    expect(detectImports(`# import os`, "python")).toEqual([]);
  });

  it("reads the TS/JS statement shapes", () => {
    const read = (line: string): string[] => detectImports(line, "js").map((raw) => raw.specifier);
    expect(read(`import * as z from "zod";`)).toEqual(["zod"]);
    expect(read(`import type { A } from "./a";`)).toEqual(["./a"]);
    expect(read(`import "./side-effect.css";`)).toEqual(["./side-effect.css"]);
    expect(read(`export { a, b } from "./ab";`)).toEqual(["./ab"]);
    expect(read(`} from "./multi";`)).toEqual(["./multi"]);
    expect(read(`import x = require("legacy");`)).toEqual(["legacy"]);
    expect(read(`const [a, b] = await Promise.all([import("./a"), import("./b")]);`)).toEqual([
      "./a",
      "./b",
    ]);
    expect(read(`import {`)).toEqual([]);
  });

  it("reads Python's comma list and Rust's `pub use`", () => {
    expect(detectImports("import os, sys as system", "python").map((raw) => raw.specifier)).toEqual(
      ["os", "sys"],
    );
    expect(detectImports("pub(crate) use super::net::{fetch, Blob};", "rust")).toEqual([
      { specifier: "super::net", relative: false },
    ]);
    expect(detectImports(`require_relative "lib/x"`, "ruby")).toEqual([
      { specifier: "lib/x", relative: true },
    ]);
  });
});

describe("paths", () => {
  it("joins posix paths, folding `.` and `..`", () => {
    expect(joinPath("src/renderer", "../shared/x")).toBe("src/shared/x");
    expect(joinPath("", "./a")).toBe("a");
    expect(joinPath("a", "../../b")).toBe("b");
  });

  it("names a bare specifier's package root", () => {
    expect(jsPackageName("@scope/pkg/deep/path")).toBe("@scope/pkg");
    expect(jsPackageName("lodash/merge")).toBe("lodash");
    expect(jsPackageName("node:fs")).toBe("node:fs");
  });

  it("learns an alias root by majority, and nothing from a specifier no file explains", () => {
    const paths = new Set([
      "src/renderer/src/lib/a.ts",
      "src/renderer/src/stores/b.ts",
      "other/lib/a.ts",
    ]);
    expect(learnAliases(["@/lib/a", "@/stores/b"], paths)).toEqual(
      new Map([["@/", "src/renderer/src"]]),
    );
    expect(learnAliases(["~/nowhere"], paths)).toEqual(new Map());
    expect(learnAliases(["@scope/pkg"], paths)).toEqual(new Map());
  });
});

// The outline's linearity rules hold here for the same reason (`outline.ts`'s header): a PR's
// patch is someone else's, read inside a render. Bounds are generous — tens of times the linear
// cost, far under what the old code took.
describe("stays linear on adversarial input", () => {
  it("matches every pattern in time linear in the line, far past the length budget", () => {
    // `JVM_IMPORT` was cubic: 2,000 spaces took 3 s. A linear pattern fails 20,000 in under 1 ms.
    let slowest = { ms: 0, at: "" };
    for (const pattern of IMPORT_PATTERNS) {
      for (const line of backtrackingLines(20_000)) {
        pattern.lastIndex = 0;
        const started = performance.now();
        pattern.exec(line);
        const ms = performance.now() - started;
        if (ms > slowest.ms) {
          slowest = { ms, at: `${String(pattern)} on ${JSON.stringify(line.slice(0, 12))}…` };
        }
      }
    }
    expect(slowest.ms, slowest.at).toBeLessThan(100);
  });

  it("reads no line past the budget, in any language", () => {
    const languages: readonly ImportLanguage[] = [
      "js",
      "python",
      "go",
      "rust",
      "swift",
      "kotlin",
      "java",
      "ruby",
    ];
    const started = performance.now();
    for (const language of languages) {
      expect(detectImports(`import a${" ".repeat(20_000)}x`, language)).toEqual([]);
      expect(detectImports(`import { a } from "${"x".repeat(20_000)}";`, language)).toEqual([]);
    }
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("resolves a 3,000-file diff by index, not by scanning every path per import", () => {
    // 30,000 aliased imports over 3,000 changed files: 1.9 s when every lookup scanned the paths.
    const parts: string[] = [];
    for (let index = 0; index < 3000; index += 1) {
      const path = `pkg${index % 40}/sub${index % 7}/file${index}.ts`;
      const body = Array.from(
        { length: 10 },
        (_, line) => `+import { x${line} } from "@/lib/mod${(index + line) % 500}";`,
      );
      parts.push(
        [
          `diff --git a/${path} b/${path}`,
          "new file mode 100644",
          "index 0000000..1111111",
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${body.length} @@`,
          ...body,
        ].join("\n"),
      );
    }
    const many = parsePatch(`${parts.join("\n")}\n`, "imports-test");
    const started = performance.now();
    const read = dependencyDiff(many);
    expect(performance.now() - started).toBeLessThan(750);
    expect(read).toHaveLength(3000);
  });

  it("leaves a file past the row budget unread", () => {
    const huge = buildHugeAdditionPatch(30_000).replace(
      "+const value0 = 0;",
      '+import { x } from "./x";',
    );
    expect(dependencyDiff(parsePatch(huge, "imports-test"))).toEqual([]);
  });

  it("pairs off thousands of moved imports of one module in one pass", () => {
    const count = 8000;
    const lines = Array.from({ length: count }, (_, index) => [
      `-import { a${index} } from "./shared";`,
      `+import { b${index} } from "./shared";`,
    ]).flat();
    const patch = [
      "diff --git a/src/many.ts b/src/many.ts",
      "index 1111111..2222222 100644",
      "--- a/src/many.ts",
      "+++ b/src/many.ts",
      `@@ -1,${count} +1,${count} @@`,
      ...lines,
      "",
    ].join("\n");
    const started = performance.now();
    expect(dependencyDiff(parsePatch(patch, "imports-test"))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(750);
  });
});
