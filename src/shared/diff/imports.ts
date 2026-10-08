import type { Hunk } from "@pierre/diffs";
import type { ReviewSide } from "../review";
import {
  MAX_READ_LINE_LENGTH,
  outlineLanguage,
  tooLargeToRead,
  type OutlineLanguage,
} from "./outline";
import type { PatchFile } from "./patch";
import { walkHunkLines } from "./walk";

// The dependency diff: per file, the import statements a change added and removed, each resolved
// to what it names — another file of the repository, an external package, or an alias this
// module could not map. The guide's Deps tab aggregates it to modules (`lib/deps-graph.ts`), so a
// reader sees how the change rewires who depends on whom before reading a line of it. Computed
// from the diff alone, never authored, like the outline (`outline.ts`) beside it.
//
// **Lines, not a parser.** One regex family per language, gated on the file's extension by the
// outline's own table (`outlineLanguage`), so the two computed views agree about which files are
// code — prose is never read, which is why a Markdown code sample `import { x } from "./y"` is
// not a dependency. A parser per language was the rejected alternative for the same reasons as
// the outline's: its weight in the renderer bundle, and the languages it would still not cover.
// What a line can show is read: TS/JS `import … from`, `export … from`, a multi-line import's
// closing `} from "…"`, side-effect `import "…"`, `import("…")` and `require("…")`; Python
// `import a.b` and `from .x import y`; Go `import "x"` and the lines of an `import ( … )` block;
// Rust `use` and `extern crate`; Swift, Kotlin and Java `import`; Ruby `require` and
// `require_relative`. Shell `source` is not, deliberately — a sourced path is usually computed.
//
// **False positives are worse than misses**, the outline's rule again. A test that asserts on
// source text — a string holding a dynamic import of some package, of which this repository has
// several (`MermaidDiagram.test.ts` is one, and is also why the example is not spelled out here:
// it scans non-test sources for exactly that text) — must not read as a dependency on the
// package, so a call form preceded by a quote, a dot or an identifier character is refused, and
// comment lines are skipped. A Go import-spec line is
// only read inside an import block the walk has *seen open* — on a hunk line, or as the hunk
// header's function context, which git sets to `import (` for a hunk that starts inside one —
// since a bare `"string"` line elsewhere is the tail of a concatenation.
//
// **A moved import is not a change.** A statement removed and another added in the same file that
// resolve to the same target pair off and are dropped — an import re-sorted, re-wrapped onto
// several lines, given more names, or (`std::…::HashMap` → `std::…::BTreeMap`) switched to a
// sibling in the same package: the file depends on the same thing before and after. The pairing
// is by *resolved target*, not by text, which is what makes `./x` → `./x.js` a no-op too.
//
// **Resolution, cheaply.** A relative specifier is joined onto the importing file's directory
// with a small posix join (no `node:path` — this module is node-free) — the *old* path's
// directory for a removed line of a renamed file — then tried against the changed-file set with
// the language's extensions and index files. A hit is a file in the diff; a miss is still a
// repository path (relative imports never leave the repo), just one the diff does not show. A
// bare specifier is a package (`@scope/pkg` and `zod` at their package root, Go's `net/http` and
// `golang.org/x/net` at theirs) *unless the diff shows it is not*: a bare path that names a
// changed file is internal, and for the package-path languages (Python, Kotlin, Java, Ruby's
// `require`) a first segment the diff itself shows as a directory (`app.store` when `app/` holds a
// changed file) is internal too. A path alias (`@/lib/x`, `~/x`) is learned from the diff — each
// aliased specifier that names a changed file by suffix votes for a root, and the most-voted root
// wins (`@/` → `src/renderer/src` in this app) — or passed in (`aliases`); one no file voted for
// stays its own string, an `unresolved` target. What this cannot see: a `tsconfig` `paths` entry
// that is not a prefix alias, a Go module path the diff gives no suffix of, a pure rename's
// relative imports changing meaning without changing text (no `+`/`-` line exists to read), and
// whether a package is new to the repository or only to these files.
//
// **Linear, because the diff is someone else's.** The outline's rules (`outline.ts`'s header)
// hold here too and for the same reason — a PR's patch is adversarial input, read in a render:
// no pattern with overlapping quantifiers (`JVM_IMPORT` once took 3 s on one line of 2,000
// spaces), no line past `MAX_READ_LINE_LENGTH` handed to one, and no file past the outline's row
// budget read (`tooLargeToRead`), which the guide states rather than hides. Resolution is
// indexed, not scanned: every lookup of a path or a directory by its last segment goes through a
// map built once per diff (`Universe`), where scanning every changed path per import statement
// took 1.9 s on 3,000 files.
//
// Node-free and pure (`tsconfig.shared.json`), over the same `parsePatch` and the same hunk walk
// (`walk.ts`) as anchoring, so every statement's `side`/`line` is a `+`/`-` line an anchor
// `{ file: path, side, startLine: line, endLine: line }` places on.

/** What an import names. `internal`: a path in this repository — a file, or for Go, Swift and
 * Kotlin/Java packages a directory — and whether the diff carries it. `package`: an external
 * dependency at its package root. `unresolved`: an alias no changed file explained, kept as
 * written so the reader still sees it. */
export type DependencyTarget =
  | { kind: "internal"; path: string; directory: boolean; inDiff: boolean }
  | { kind: "package"; name: string }
  | { kind: "unresolved"; specifier: string };

export type DependencyChange = {
  /** As the statement wrote it (`../lib/retry`, `std::collections::HashMap`, `app.store`). */
  specifier: string;
  target: DependencyTarget;
  /** The `+` or `-` line the statement sits on, in `side`'s file coordinates. */
  side: ReviewSide;
  line: number;
};

export type FileDependencies = {
  /** The file's path in the diff — the one an anchor names. */
  path: string;
  /** Statements the change added, in reading order, moved imports paired off. */
  added: DependencyChange[];
  /** Statements the change removed, likewise. */
  removed: DependencyChange[];
  /** Statements on the hunks' context lines: dependencies the file visibly has both before and
   * after. Not a change — evidence. A module-level edge the diff adds an import to may already
   * have existed, and only an unchanged statement on screen can say so (`lib/deps-graph.ts`
   * reads these to tell a new edge from one more import on an old one). Partial by nature: the
   * diff shows three lines of context, not the file's whole import block. */
  unchanged: DependencyChange[];
};

export type DependencyOptions = {
  /** Files to leave out whatever their extension — the renderer passes `isMachineWritten`, as it
   * does to the outline. */
  skip?: (file: PatchFile) => boolean;
  /** Alias prefix → repository directory (`{ "@/": "src/renderer/src" }`). Overrides what would
   * be learned from the diff for the prefixes it names. */
  aliases?: Readonly<Record<string, string>>;
};

/** One import a line makes, before resolution. `relative` marks a form that is relative by
 * construction even without a leading dot (Ruby's `require_relative "lib/x"`). */
type RawImport = { specifier: string; relative: boolean };

// ---------------------------------------------------------------------------------------------
// Detection, one line at a time
// ---------------------------------------------------------------------------------------------

/** The quoted specifier of a string literal. */
const QUOTED = "[\"'`]([^\"'`\\s]+)[\"'`]";

/** A call form (`import(…)`, `require(…)`) only counts when nothing glues it to what precedes it:
 * not an identifier character (`myrequire(`), not a dot (`module.require(`), not a quote (source
 * text in a test asserting on `'import("x")'`). */
const JS_CALLS = new RegExp(`(?<![\\w$.'"\`])(?:import|require)\\s*\\(\\s*${QUOTED}\\s*\\)`, "gu");
const JS_STATEMENTS = [
  // import x from "y"; import { a } from "y"; import type …; import "y"; import x = require(…) is a call.
  // The clause starts on a non-blank, so the `\s+` before it and the clause's own blanks never
  // trade a run of spaces between them; it is greedy, so it backtracks one `\sfrom` test per
  // character rather than (lazily) re-scanning the rest of the line from each one.
  new RegExp(String.raw`^import\s+(?:type\s+)?(?:[\w$*{},][\w$*{},\s]*\sfrom\s+)?${QUOTED}`, "u"),
  // export * from "y"; export { a } from "y"; export type { … } from "y".
  new RegExp(
    String.raw`^export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+${QUOTED}`,
    "u",
  ),
  // The closing line of a multi-line import or re-export: `} from "y";`.
  new RegExp(String.raw`^\}\s*from\s+${QUOTED}`, "u"),
];

// `\.[\w.]*`, not `\.+[\w.]*`: both quantifiers took dots, so a line of them split every way.
const PYTHON_FROM = /^from\s+(\.[\w.]*|[A-Za-z_][\w.]*)\s+import\b/u;
const PYTHON_IMPORT =
  /^import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)\s*(?:#.*)?$/u;

const GO_SINGLE = /^import\s+(?:[\w.]+\s+)?"([^"\s]+)"/u;
const GO_BLOCK_OPEN = /^import\s*\(\s*(?:\/\/.*)?$/u;
const GO_BLOCK_CLOSE = /^\)\s*$/u;
const GO_SPEC = /^(?:[\w.]+\s+)?"([^"\s]+)"\s*(?:\/\/.*)?$/u;

const RUST_USE = /^(?:pub(?:\([^)]*\))?\s+)?use\s+(?:::)?([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/u;
const RUST_EXTERN = /^extern\s+crate\s+([A-Za-z_]\w*)/u;

const SWIFT_IMPORT =
  /^(?:@\w+(?:\([^)]*\))?\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_][\w.]*)/u;
// Read on the trimmed line, so nothing trails the optional `;`. It was
// `\s*(?:as\s+\w+)?\s*;?\s*$` — three blank runs in a row, cubic on a line of spaces (2,000 of
// them took 3 s) — and is now one blank run per alternative, each ended by a literal.
const JVM_IMPORT = /^import\s+(?:static\s+)?([A-Za-z_][\w.]*?)(?:\.\*)?(?:\s+as\s+\w+)?(?:\s*;)?$/u;

const RUBY_REQUIRE = /^(require_relative|require|load)\b\s*(?:\(\s*)?["']([^"']+)["']/u;

/** Every pattern above, for the linearity test (`imports.test.ts`), which runs each on lines far
 * past `MAX_READ_LINE_LENGTH`, where a polynomial backtrack cannot hide behind the budget. */
export const IMPORT_PATTERNS: readonly RegExp[] = [
  JS_CALLS,
  ...JS_STATEMENTS,
  PYTHON_FROM,
  PYTHON_IMPORT,
  GO_SINGLE,
  GO_BLOCK_OPEN,
  GO_BLOCK_CLOSE,
  GO_SPEC,
  RUST_USE,
  RUST_EXTERN,
  SWIFT_IMPORT,
  JVM_IMPORT,
  RUBY_REQUIRE,
];

/** A line that is a comment in every language here — never read for an import. */
function isComment(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("--")
  );
}

/** The languages read for imports: the outline's, without shell. */
export type ImportLanguage = Exclude<OutlineLanguage, "shell">;

export function importLanguage(path: string): ImportLanguage | null {
  const language = outlineLanguage(path);
  return language === null || language === "shell" ? null : language;
}

/** The imports one line makes in `language`, outside a Go import block. Exported for the pattern
 * tests, which pin each language's shapes and refusals a line at a time. */
export function detectImports(text: string, language: ImportLanguage): RawImport[] {
  if (text.length > MAX_READ_LINE_LENGTH) {
    return [];
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }
  // Python and Ruby comments start with `#`, but so does nothing else these patterns read;
  // a Rust attribute (`#[derive]`) is not an import either way.
  if (isComment(trimmed)) {
    return [];
  }
  switch (language) {
    case "js": {
      for (const pattern of JS_STATEMENTS) {
        const match = pattern.exec(trimmed);
        if (match?.[1] !== undefined) {
          return [{ specifier: match[1], relative: false }];
        }
      }
      return [...trimmed.matchAll(JS_CALLS)].flatMap((match) =>
        match[1] === undefined ? [] : [{ specifier: match[1], relative: false }],
      );
    }
    case "python": {
      const from = PYTHON_FROM.exec(trimmed);
      if (from?.[1] !== undefined) {
        return [{ specifier: from[1], relative: false }];
      }
      const plain = PYTHON_IMPORT.exec(trimmed);
      if (plain?.[1] === undefined) {
        return [];
      }
      return plain[1].split(",").flatMap((part) => {
        const name = part.trim().split(/\s+/u)[0];
        return name === undefined || name === "" ? [] : [{ specifier: name, relative: false }];
      });
    }
    case "go": {
      const match = GO_SINGLE.exec(trimmed);
      return match?.[1] === undefined ? [] : [{ specifier: match[1], relative: false }];
    }
    case "rust": {
      const match = RUST_USE.exec(trimmed) ?? RUST_EXTERN.exec(trimmed);
      return match?.[1] === undefined ? [] : [{ specifier: match[1], relative: false }];
    }
    case "swift": {
      const match = SWIFT_IMPORT.exec(trimmed);
      return match?.[1] === undefined ? [] : [{ specifier: match[1], relative: false }];
    }
    case "kotlin":
    case "java": {
      const match = JVM_IMPORT.exec(trimmed);
      return match?.[1] === undefined ? [] : [{ specifier: match[1], relative: false }];
    }
    case "ruby": {
      const match = RUBY_REQUIRE.exec(trimmed);
      if (match?.[2] === undefined) {
        return [];
      }
      return [{ specifier: match[2], relative: match[1] === "require_relative" }];
    }
  }
}

/** A template literal's interpolation is computed at run time; nothing static is named. */
function isStatic(raw: RawImport): boolean {
  return !raw.specifier.includes("${");
}

/** One line's imports. `context` marks a statement on a context line — present before and after,
 * read on its `additions` copy only so it is counted once. */
type Found = RawImport & { side: ReviewSide; line: number; context: boolean };

type GoBlock = { additions: boolean; deletions: boolean };

/** Every import on one hunk's lines, changed and context. Go's block state is tracked per side —
 * an `import (` opened on a `+` line exists only after the change — and starts open when git's
 * function context for the hunk is the block's own opening line. */
function hunkImports(
  hunk: Hunk,
  additionLines: readonly string[],
  deletionLines: readonly string[],
  language: ImportLanguage,
): Found[] {
  const found: Found[] = [];
  const opensInBlock = language === "go" && GO_BLOCK_OPEN.test((hunk.hunkContext ?? "").trim());
  const inBlock: GoBlock = { additions: opensInBlock, deletions: opensInBlock };
  walkHunkLines(hunk, (line) => {
    const texts = line.side === "additions" ? additionLines : deletionLines;
    const text = (texts[line.index] ?? "").replace(/\r?\n$/u, "");
    // Past the budget a line is no statement in any language here — not even Go's `import (`
    // or `)`, so skipping it leaves the block state as it was.
    if (text.length > MAX_READ_LINE_LENGTH) {
      return;
    }
    const context = line.kind === "context";
    // A context line is walked once per side; the block state needs both, the statement one.
    const counted = !context || line.side === "additions";
    const push = (raw: RawImport): void => {
      if (counted && isStatic(raw)) {
        found.push({ ...raw, side: line.side, line: line.lineNumber, context });
      }
    };
    if (language === "go") {
      const trimmed = text.trim();
      if (GO_BLOCK_OPEN.test(trimmed)) {
        inBlock[line.side] = true;
        return;
      }
      if (inBlock[line.side]) {
        if (GO_BLOCK_CLOSE.test(trimmed)) {
          inBlock[line.side] = false;
          return;
        }
        const spec = GO_SPEC.exec(trimmed);
        if (spec?.[1] !== undefined) {
          push({ specifier: spec[1], relative: false });
        }
        return;
      }
    }
    if (counted) {
      for (const raw of detectImports(text, language)) {
        push(raw);
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** The directory part of a repository path; `""` for a file at the root. */
export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** `base` joined with `relative`, `.` and `..` folded — the posix join this needs, without
 * `node:path`. A `..` above the root is dropped: a specifier that climbs out of the repository
 * names nothing the diff can show, and the root is the nearest honest answer. */
export function joinPath(base: string, relative: string): string {
  const out: string[] = base === "" ? [] : base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join("/");
}

/** A path without its last extension (`a/b.test.ts` → `a/b.test`). */
function withoutExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? path : path.slice(0, path.length - (name.length - dot));
}

const JS_EXTENSIONS = ["ts", "tsx", "mts", "cts", "d.ts", "js", "jsx", "mjs", "cjs"];
/** ESM TypeScript writes `./x.js` for `./x.ts`; these are the extensions a written one stands for. */
const JS_WRITTEN = new Map([
  ["js", ["ts", "tsx", "js", "jsx"]],
  ["jsx", ["tsx", "jsx"]],
  ["mjs", ["mts", "mjs"]],
  ["cjs", ["cts", "cjs"]],
]);

/** The files a JS specifier joined to `path` could be, most literal first. */
function jsCandidates(path: string): string[] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const written = dot > 0 ? JS_WRITTEN.get(name.slice(dot + 1)) : undefined;
  const stem = written === undefined ? null : withoutExtension(path);
  return [
    path,
    ...(stem === null ? [] : (written ?? []).map((extension) => `${stem}.${extension}`)),
    ...JS_EXTENSIONS.map((extension) => `${path}.${extension}`),
    ...JS_EXTENSIONS.map((extension) => `${path}/index.${extension}`),
  ];
}

const EXTENSIONS: Readonly<Record<Exclude<ImportLanguage, "js">, readonly string[]>> = {
  python: ["py", "pyi"],
  go: ["go"],
  rust: ["rs"],
  swift: ["swift"],
  kotlin: ["kt", "kts"],
  java: ["java"],
  ruby: ["rb"],
};

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

type Universe = {
  /** Every path the diff carries, old and new. */
  paths: ReadonlySet<string>;
  /** `paths` by last segment — every suffix lookup (`bySuffix`) starts from the bucket of its
   * own file name rather than from every path in the diff. */
  pathsByName: ReadonlyMap<string, readonly string[]>;
  /** Every directory that holds a changed file, at every depth. */
  directories: ReadonlySet<string>;
  /** `directories` by last segment, in `directories`' order. */
  directoriesByName: ReadonlyMap<string, readonly string[]>;
  aliases: ReadonlyMap<string, string>;
  /** `codeDirectories` per extension list, by last segment, filled on first ask: it is asked
   * once per statement, and on a thousand-file diff the scan behind it is not free. */
  codeDirectories: Map<string, ReadonlyMap<string, readonly string[]>>;
};

/** The last segment of a path (`a/b/c.ts` → `c.ts`). */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `items` grouped by last segment, each group in `items`' order. */
function byName(items: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const item of items) {
    const name = nameOf(item);
    const bucket = index.get(name);
    if (bucket === undefined) {
      index.set(name, [item]);
    } else {
      bucket.push(item);
    }
  }
  return index;
}

function internal(path: string, directory: boolean, universe: Universe): DependencyTarget {
  return {
    kind: "internal",
    path,
    directory,
    inDiff: directory ? universe.directories.has(path) : universe.paths.has(path),
  };
}

/** The first candidate the diff carries, else null. */
function firstInDiff(candidates: readonly string[], universe: Universe): string | null {
  return candidates.find((candidate) => universe.paths.has(candidate)) ?? null;
}

/** A changed file whose path ends with `/<suffix>` (or is `suffix`), shortest first — the
 * least-nested match is the likeliest to be the one a package path names. */
function bySuffix(suffixes: readonly string[], universe: Universe): string | null {
  // A path ending in `/<suffix>` ends in the suffix's own last segment, so only that bucket can
  // hold one.
  const hits = new Set<string>();
  for (const suffix of suffixes) {
    for (const path of universe.pathsByName.get(nameOf(suffix)) ?? []) {
      if (path === suffix || path.endsWith(`/${suffix}`)) {
        hits.add(path);
      }
    }
  }
  return [...hits].toSorted((a, b) => a.length - b.length || (a < b ? -1 : 1))[0] ?? null;
}

/** The changed directories that hold a changed file with one of `extensions` somewhere under
 * them — so a Python import is never explained by a directory of TypeScript that shares its
 * name, nor Go's `fmt` by a `docs/fmt/` of prose. */
function codeDirectories(
  extensions: readonly string[],
  universe: Universe,
): ReadonlyMap<string, readonly string[]> {
  const key = extensions.join(",");
  const cached = universe.codeDirectories.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const directories = new Set<string>();
  for (const path of universe.paths) {
    if (extensions.some((extension) => path.endsWith(`.${extension}`))) {
      for (let directory = dirnameOf(path); directory !== ""; directory = dirnameOf(directory)) {
        directories.add(directory);
      }
    }
  }
  const found = byName(directories);
  universe.codeDirectories.set(key, found);
  return found;
}

/** The directory in the diff that a dotted package path's first segment names: the shallowest
 * changed directory of this language whose last segment is `first`. `app.store` is internal when
 * `app/` holds a changed Python file; its root is wherever that `app/` sits. */
function rootFor(first: string, extensions: readonly string[], universe: Universe): string | null {
  const hits = codeDirectories(extensions, universe).get(first) ?? [];
  const shallowest = hits.toSorted((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
  return shallowest === undefined ? null : dirnameOf(shallowest);
}

/** A bare JS specifier's package: `@scope/pkg/deep` → `@scope/pkg`, `lodash/merge` → `lodash`,
 * `node:fs` as is. */
export function jsPackageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

function isRelative(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/** The alias prefix of a specifier, if it has the shape of one: `@/`, `~/`, `#/`, `$lib/`.
 * `@scope/pkg` is a package, not an alias — an alias's `@` is followed by the slash. */
function aliasPrefix(specifier: string): string | null {
  const match = /^(?:@|~|#|\$[\w-]+)\//u.exec(specifier);
  return match === null ? null : match[0];
}

function resolveJs(specifier: string, from: string, universe: Universe): DependencyTarget {
  if (isRelative(specifier) || specifier.startsWith("/")) {
    const joined = joinPath(specifier.startsWith("/") ? "" : dirnameOf(from), specifier);
    return internal(firstInDiff(jsCandidates(joined), universe) ?? joined, false, universe);
  }
  const prefix = aliasPrefix(specifier);
  if (prefix !== null) {
    const root = universe.aliases.get(prefix);
    if (root === undefined) {
      return { kind: "unresolved", specifier };
    }
    const joined = joinPath(root, specifier.slice(prefix.length));
    return internal(firstInDiff(jsCandidates(joined), universe) ?? joined, false, universe);
  }
  // A `baseUrl` import (`src/lib/x`) looks bare; it is internal when it names a changed file.
  const named = firstInDiff(jsCandidates(specifier), universe);
  return named === null
    ? { kind: "package", name: jsPackageName(specifier) }
    : internal(named, false, universe);
}

function resolvePython(specifier: string, from: string, universe: Universe): DependencyTarget {
  const dots = /^\.*/u.exec(specifier)?.[0].length ?? 0;
  const dotted = specifier.slice(dots);
  const relativePath = dotted
    .split(".")
    .filter((part) => part !== "")
    .join("/");
  const candidates = (base: string): string[] =>
    relativePath === ""
      ? [`${base}/__init__.py`]
      : [
          ...EXTENSIONS.python.map((extension) => `${base}/${relativePath}.${extension}`),
          `${base}/${relativePath}/__init__.py`,
        ].map((path) => path.replace(/^\//u, ""));
  if (dots > 0) {
    // One dot is the importing file's package; each further dot climbs one.
    let base = dirnameOf(from);
    for (let level = 1; level < dots; level += 1) {
      base = dirnameOf(base);
    }
    const hit = firstInDiff(candidates(base), universe);
    if (hit !== null) {
      return internal(hit, false, universe);
    }
    const guess = relativePath === "" ? base : joinPath(base, relativePath);
    return internal(relativePath === "" ? guess : `${guess}.py`, relativePath === "", universe);
  }
  const named = bySuffix(
    [`${relativePath}.py`, `${relativePath}.pyi`, `${relativePath}/__init__.py`],
    universe,
  );
  if (named !== null) {
    return internal(named, false, universe);
  }
  const first = relativePath.split("/")[0] ?? relativePath;
  const root = rootFor(first, EXTENSIONS.python, universe);
  return root === null
    ? { kind: "package", name: first }
    : internal(`${joinPath(root, relativePath)}.py`, false, universe);
}

/** Go's standard library has no dot in its first segment; a module path's root is its first three
 * segments (`github.com/org/repo`, `golang.org/x/net`). */
function goPackageName(specifier: string): string {
  const segments = specifier.split("/");
  return segments[0]?.includes(".") === true ? segments.slice(0, 3).join("/") : specifier;
}

function resolveGo(specifier: string, from: string, universe: Universe): DependencyTarget {
  if (isRelative(specifier)) {
    return internal(joinPath(dirnameOf(from), specifier), true, universe);
  }
  // A package is a directory; an import names this repository's when a changed directory is a
  // suffix of it of at least two segments (`…/internal/store` → `internal/store`) — one segment
  // would let any `fmt/` in the tree claim the standard library's `fmt`.
  const segments = specifier.split("/");
  // Every suffix tried ends in the specifier's last segment, so only that bucket can hold one.
  const goDirectories = codeDirectories(EXTENSIONS.go, universe).get(segments.at(-1) ?? "") ?? [];
  for (let take = segments.length; take >= 2; take -= 1) {
    const suffix = segments.slice(segments.length - take).join("/");
    const hit = goDirectories.find(
      (directory) => directory === suffix || directory.endsWith(`/${suffix}`),
    );
    if (hit !== undefined) {
      return internal(hit, true, universe);
    }
  }
  return { kind: "package", name: goPackageName(specifier) };
}

/** The directory a Rust file's child modules live in: its own for a crate root or a `mod.rs`,
 * else a directory named after it (`src/net.rs` → `src/net/`). */
function rustModuleDirectory(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "main.rs" || name === "lib.rs" || name === "mod.rs"
    ? dirnameOf(path)
    : withoutExtension(path);
}

function resolveRust(specifier: string, from: string, universe: Universe): DependencyTarget {
  const segments = specifier.split("::");
  const head = segments[0] ?? specifier;
  let base: string;
  let rest = segments.slice(1);
  if (head === "crate") {
    // The crate root is the `src` the importing file sits under, else its own directory.
    const marker = `/${from}`.lastIndexOf("/src/");
    base = marker === -1 ? dirnameOf(from) : from.slice(0, marker + "src".length);
  } else if (head === "self" || head === "super") {
    base = rustModuleDirectory(from);
    if (head === "super") {
      base = dirnameOf(base);
    }
    while (rest[0] === "super") {
      base = dirnameOf(base);
      rest = rest.slice(1);
    }
  } else {
    return { kind: "package", name: head };
  }
  // The longest module path the diff carries as a file: `a::b::C` is `a/b.rs` or `a/b/mod.rs`,
  // and an item's name (`C`) is never a file — so every prefix is tried, longest first.
  for (let take = rest.length; take >= 1; take -= 1) {
    const module = joinPath(base, rest.slice(0, take).join("/"));
    const hit = firstInDiff([`${module}.rs`, `${module}/mod.rs`], universe);
    if (hit !== null) {
      return internal(hit, false, universe);
    }
  }
  const first = rest[0];
  return first === undefined
    ? internal(base, true, universe)
    : internal(`${joinPath(base, first)}.rs`, false, universe);
}

function resolveSwift(specifier: string, universe: Universe): DependencyTarget {
  const module = specifier.split(".")[0] ?? specifier;
  // A Swift module is a target; a package's targets live in `Sources/<Module>`.
  const hit = (universe.directoriesByName.get(module) ?? []).find(
    (directory) => directory === `Sources/${module}` || directory.endsWith(`/Sources/${module}`),
  );
  return hit === undefined ? { kind: "package", name: module } : internal(hit, true, universe);
}

function resolveJvm(
  specifier: string,
  language: "kotlin" | "java",
  universe: Universe,
): DependencyTarget {
  const segments = specifier.split(".");
  // `a.b.Class` or `a.b.function`: the file is `a/b/Class.kt`, the package `a/b`.
  const asFile = segments.join("/");
  const named = bySuffix(
    EXTENSIONS[language].map((extension) => `${asFile}.${extension}`),
    universe,
  );
  if (named !== null) {
    return internal(named, false, universe);
  }
  const packagePath = segments.slice(0, -1).join("/");
  const first = segments[0] ?? specifier;
  const root = segments.length > 1 ? rootFor(first, EXTENSIONS[language], universe) : null;
  if (root !== null) {
    return internal(joinPath(root, packagePath), true, universe);
  }
  // A package root is its first two segments (`kotlinx.coroutines`, `java.util`, `org.junit`);
  // a one-segment import is its own.
  return {
    kind: "package",
    name: segments.slice(0, Math.max(1, Math.min(2, segments.length - 1))).join("."),
  };
}

function resolveRuby(raw: RawImport, from: string, universe: Universe): DependencyTarget {
  const withExtension = (path: string): string => (path.endsWith(".rb") ? path : `${path}.rb`);
  if (raw.relative || isRelative(raw.specifier)) {
    return internal(withExtension(joinPath(dirnameOf(from), raw.specifier)), false, universe);
  }
  const named = bySuffix([withExtension(raw.specifier)], universe);
  return named === null
    ? { kind: "package", name: raw.specifier.split("/")[0] ?? raw.specifier }
    : internal(named, false, universe);
}

function resolve(
  raw: RawImport,
  from: string,
  language: ImportLanguage,
  universe: Universe,
): DependencyTarget {
  switch (language) {
    case "js":
      return resolveJs(raw.specifier, from, universe);
    case "python":
      return resolvePython(raw.specifier, from, universe);
    case "go":
      return resolveGo(raw.specifier, from, universe);
    case "rust":
      return resolveRust(raw.specifier, from, universe);
    case "swift":
      return resolveSwift(raw.specifier, universe);
    case "kotlin":
    case "java":
      return resolveJvm(raw.specifier, language, universe);
    case "ruby":
      return resolveRuby(raw, from, universe);
  }
}

/** One key per thing a statement can depend on — what pairing compares. */
export function targetKey(target: DependencyTarget): string {
  switch (target.kind) {
    case "internal":
      return `internal:${target.path}`;
    case "package":
      return `package:${target.name}`;
    case "unresolved":
      return `unresolved:${target.specifier}`;
  }
}

/** Alias roots learned from the diff: for each aliased JS specifier, the changed files it could
 * name by suffix vote for the directory in front of that suffix; per prefix, the most-voted root
 * wins, ties to the shorter (then the lexically first) root, so the answer is stable. */
export function learnAliases(
  specifiers: readonly string[],
  paths: ReadonlySet<string>,
): Map<string, string> {
  // Each candidate is looked up in the bucket of its own file name, not tested against every
  // path: specifiers × paths × candidates was the 1.9 s of a 3,000-file diff.
  const pathsByName = byName(paths);
  const votes = new Map<string, Map<string, number>>();
  for (const specifier of new Set(specifiers)) {
    const prefix = aliasPrefix(specifier);
    if (prefix === null) {
      continue;
    }
    const rest = specifier.slice(prefix.length);
    const roots = new Set<string>();
    for (const candidate of jsCandidates(rest)) {
      for (const path of pathsByName.get(nameOf(candidate)) ?? []) {
        if (path.endsWith(`/${candidate}`)) {
          roots.add(path.slice(0, path.length - candidate.length - 1));
        } else if (path === candidate) {
          roots.add("");
        }
      }
    }
    const tally = votes.get(prefix) ?? new Map<string, number>();
    for (const root of roots) {
      tally.set(root, (tally.get(root) ?? 0) + 1);
    }
    votes.set(prefix, tally);
  }
  const learned = new Map<string, string>();
  for (const [prefix, tally] of votes) {
    const best = [...tally.entries()].toSorted(
      ([a, countA], [b, countB]) =>
        countB - countA || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
    )[0];
    if (best !== undefined) {
      learned.set(prefix, best[0]);
    }
  }
  return learned;
}

/** Drop every added statement that has a removed one with the same target in the same file, one
 * for one: the file depended on that before and still does. */
function pairMoved(
  added: readonly DependencyChange[],
  removed: readonly DependencyChange[],
): [DependencyChange[], DependencyChange[]] {
  // A queue per target read through a cursor — not re-spread per push nor `shift()`ed, both of
  // which are quadratic in a file that removes thousands of imports of one module.
  const pending = new Map<string, { queue: number[]; next: number }>();
  for (const [index, change] of removed.entries()) {
    const key = targetKey(change.target);
    const entry = pending.get(key);
    if (entry === undefined) {
      pending.set(key, { queue: [index], next: 0 });
    } else {
      entry.queue.push(index);
    }
  }
  const keptAdded: DependencyChange[] = [];
  const pairedRemoved = new Set<number>();
  for (const change of added) {
    const entry = pending.get(targetKey(change.target));
    const match = entry?.queue[entry.next];
    if (entry === undefined || match === undefined) {
      keptAdded.push(change);
    } else {
      entry.next += 1;
      pairedRemoved.add(match);
    }
  }
  return [keptAdded, removed.filter((_, index) => !pairedRemoved.has(index))];
}

/** Every file whose hunks show an import statement — added, removed, or on a context line — in
 * diff order. A binary, a file with no hunks and a file in no import-read language contribute
 * nothing. */
export function dependencyDiff(
  files: readonly PatchFile[],
  options: DependencyOptions = {},
): FileDependencies[] {
  const read = files.flatMap((file) => {
    const language = importLanguage(file.path);
    if (
      language === null ||
      file.isBinary ||
      options.skip?.(file) === true ||
      tooLargeToRead(file)
    ) {
      return [];
    }
    const { additionLines, deletionLines } = file.fileDiff;
    const found = file.fileDiff.hunks.flatMap((hunk) =>
      hunkImports(hunk, additionLines, deletionLines, language),
    );
    return found.length === 0 ? [] : [{ file, language, found }];
  });

  const paths = new Set(files.flatMap((file) => [file.path, file.previousPath ?? file.path]));
  const directories = new Set<string>();
  for (const path of paths) {
    for (let directory = dirnameOf(path); directory !== ""; directory = dirnameOf(directory)) {
      directories.add(directory);
    }
  }
  const learned = learnAliases(
    read.flatMap(({ language, found }) =>
      language === "js" ? found.map((raw) => raw.specifier) : [],
    ),
    paths,
  );
  const aliases = new Map(learned);
  for (const [prefix, root] of Object.entries(options.aliases ?? {})) {
    aliases.set(prefix, root.replace(/\/+$/u, ""));
  }
  const universe: Universe = {
    paths,
    pathsByName: byName(paths),
    directories,
    directoriesByName: byName(directories),
    aliases,
    codeDirectories: new Map(),
  };

  return read.flatMap(({ file, language, found }) => {
    const changes = found.map((raw) => {
      // A removed line lived at the file's old path; resolve it from there.
      const from = raw.side === "deletions" ? (file.previousPath ?? file.path) : file.path;
      return {
        change: {
          specifier: raw.specifier,
          target: resolve(raw, from, language, universe),
          side: raw.side,
          line: raw.line,
        },
        context: raw.context,
      };
    });
    const changed = changes.filter((entry) => !entry.context).map((entry) => entry.change);
    const unchanged = changes.filter((entry) => entry.context).map((entry) => entry.change);
    const [added, removed] = pairMoved(
      changed.filter((change) => change.side === "additions"),
      changed.filter((change) => change.side === "deletions"),
    );
    return added.length === 0 && removed.length === 0 && unchanged.length === 0
      ? []
      : [{ path: file.path, added, removed, unchanged }];
  });
}
