import type { Hunk } from "@pierre/diffs";
import type { ReviewSide } from "../review";
import type { PatchFile } from "./patch";
import { walkHunkLines } from "./walk";

// The outline diff: per file, the symbols a change touched — added, removed, or modified — as
// signatures without bodies, the "call stack without bodies" view of a change. Computed, never
// authored: nothing here reads the artifact, so the outline of a plain repo session and of a
// review are the same answer about the same diff.
//
// Two sources, in order of trust:
//
//   1. **Declaration lines.** A `+` or `-` line shaped like a declaration in the file's language
//      (`function`, `def`, `fn`, `func`, `class`, `interface`, `type … =`, an arrow-valued
//      top-level const, an indented method header …) is a symbol added or removed. An added and
//      a removed declaration of the same name in the same file pair into one `modified` symbol
//      carrying both signatures.
//   2. **Hunk context**, for edits that touch a body and no declaration line. The enclosing
//      symbol is found by walking *up the indentation* from the edit through the hunk's own
//      context lines — the nearest strictly shallower line, then the nearest line shallower
//      than that, until one is a declaration — and only when the hunk runs out does it fall back
//      to the header's function context (`@@ … @@ <context>`, which `@pierre/diffs` keeps as
//      `hunk.hunkContext`). The header is the fallback and not the first answer because git
//      picks it by searching upward from the line *before the hunk's first context line* for
//      any column-0 line that starts with a letter (`xemit.c`, the default funcname): when the
//      enclosing function's declaration is one of the hunk's three leading context lines, the
//      header names the function *above* it. `OUTLINE_PATCH`'s `src/handlers.ts` is that
//      case, captured from real git.
//
// **False positives are worse than misses.** A reader shown `~ first()` for an edit in `second`
// learns to distrust the whole view; a reader shown nothing for one hunk loses only that hunk.
// So every rule here prefers silence: patterns are per language and gated on the file's
// extension (prose and config are never outlined — a README line "function loadBlob(path) now
// retries" is not a declaration); a plain `const` counts only when it is exported (an API
// surface), an arrow-valued one only at the top level (an indented `const onClick = () => {` is
// a local); a method needs an indented `name(…) {` line ending in its brace, with every
// control-flow keyword refused as a name; the indentation walk stops dead at a column-0 line that
// is not a declaration (an import, a closing brace, a top-level call); and the header is honoured
// only when it is itself a declaration *shallower than the edit*. A body attribution never
// outranks a declaration: a symbol whose own line changed is reported from that line, and the
// same name inferred from context is dropped.
//
// Language-gated, not language-agnostic, deliberately. One pattern set run over every file was
// the first shape considered, and it is wrong in both directions: `def` and `fn` mean nothing in
// TypeScript, `type X =` is a declaration in TS and Rust but not in Go, a method header in Java
// needs a modifier where one in TS must not, and Markdown is full of the words. The table is
// small — one row per language family, a handful of patterns each — and adding a language is a
// row, not a branch.
//
// The pairing is by name within one file, so two same-named methods in different classes of one
// file can pair across classes, and a class's `constructor` collapses with another's. That is a
// cost of reading lines rather than a syntax tree; a parser per language was the rejected
// alternative, for the weight it would put in the renderer bundle and the languages it would
// still not cover. Node-free and pure (`tsconfig.shared.json`), over the same `parsePatch` and
// the same hunk walk (`walk.ts`) as anchoring, coverage and search — so a symbol's `side`/`line`
// is a coordinate an anchor can open.
//
// **The diff is adversarial input, and this runs in a render.** Review Pull Request… opens
// someone else's PR, a patch can be `MAX_PATCH_BYTES` (32 MB) of their choosing, and the outline
// is computed in the guide's `useMemo`s and on every chapter card (`representativeAnchors`) — so
// a shape of input that costs more than linear time freezes the window, and one that blows the
// stack blanks it. Four rules hold it to linear, and each has a test with the pathological input
// that once broke it (`outline.test.ts`, "stays linear"):
//
//   - **No spread over a file's rows.** `Math.min(...rows)` passed one argument per row and threw
//     `RangeError` past ~120k of them — a 150k-line data file. Loops only.
//   - **One stack pass per hunk** for the enclosing symbol (`IndentStack`), not a walk back up the
//     hunk per changed run, which was quadratic in the hunk: 40k interleaved lines took 36 s.
//   - **No overlapping quantifiers** in a pattern (`\s*\*?\s*`, `\s*;?\s*$`): on a line of spaces
//     each one is a polynomial backtrack, and the patterns run on every changed line. Every
//     pattern below is written so that what one quantifier gives back the next cannot take.
//   - **Budgets**, past which a file is not read at all rather than read slowly: a line longer
//     than `MAX_READ_LINE_LENGTH` is never handed to a pattern, and a file whose hunks hold more
//     than `MAX_READ_ROWS_PER_FILE` rows is not outlined (`tooLargeToRead`). Both are stated to
//     the reader — the guide says which files it did not read — because a silently empty outline
//     would claim the file declares nothing. `shared/diff/imports.ts` reads under the same two.
//
// And it is computed once per parsed file: `outlineFile` keeps its answer in a `WeakMap` keyed by
// the `PatchFile`, so the guide, the chapter band and every chapter card that asks again — each a
// separate memo, re-run on a solo or a reload of layers — get the first answer back, and a new
// parse (a reload, a new diff) is a new key the old entry is collected with.

/** What a declaration declares. Coarse on purpose: enough for a glyph and a word beside the
 * signature, not a type system. A Swift `protocol` reads `interface`, a Kotlin `object` and a
 * Java `record` read `class`, a Rust `union` reads `struct`, a Ruby/Rust module reads `module`;
 * `method` is any function declared indented — a class member, or a function nested in one. */
export type OutlineSymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "module"
  | "variable";

export type OutlineStatus = "added" | "removed" | "modified";

/** Where a symbol's evidence came from. `declaration`: its own declaration line is among the
 * changed lines (or, for `modified`, both an old and a new one are). `hunk-context`: only its
 * body changed, and it was named from the hunk's context — a declaration among the hunk's
 * context lines, or the hunk header's function context. The UI can weigh the two differently;
 * the second is an inference and says so. */
export type OutlineSource = "declaration" | "hunk-context";

export type OutlineSymbol = {
  name: string;
  kind: OutlineSymbolKind;
  status: OutlineStatus;
  /** The declaration as it reads after the change — before it for a removed symbol — trimmed,
   * whitespace-collapsed, cut before its body and capped at `MAX_SIGNATURE_LENGTH`. */
  signature: string;
  /** For a `modified` symbol whose declaration line itself changed: the signature it had
   * before. Null when the signature is unchanged (a body edit, or a declaration line git
   * re-emitted verbatim) and for added/removed symbols. */
  previousSignature: string | null;
  /** A changed line that opens this symbol in the diff, in `side`'s file coordinates: the added
   * declaration (added, or modified by declaration), the removed one (removed), or the first
   * changed line of the edit (modified by hunk context). Always a `+`/`-` line inside a hunk,
   * so an anchor `{ file, side, startLine: line, endLine: line }` places. */
  side: ReviewSide;
  line: number;
  source: OutlineSource;
};

export type FileOutline = {
  path: string;
  /** In reading order — the order the unified diff shows the lines they were found on. */
  symbols: OutlineSymbol[];
  /** Symbols past `MAX_SYMBOLS_PER_FILE`, counted rather than listed. */
  omitted: number;
};

export type OutlineOptions = {
  /** Files to leave out whatever their extension — the renderer passes `isMachineWritten`
   * (`lib/initial-folds.ts`), so a generated client or a minified bundle is not outlined. A
   * predicate rather than an import because that rule set lives in the renderer and this module
   * is shared; lockfiles and prose need no predicate, since no outlined language claims them. */
  skip?: (file: PatchFile) => boolean;
};

/** A signature past this is a parameter list, not a name; the cap keeps a row one line. */
export const MAX_SIGNATURE_LENGTH = 96;

/** A file contributing more than this is a new module or a rewrite, and its outline is its
 * table of contents rather than a summary of a change; the rest is counted in `omitted`. */
export const MAX_SYMBOLS_PER_FILE = 50;

/** A line longer than this is never matched against a pattern — not a declaration, not an
 * import. A hand-written declaration or import fits in a few lines of 100 columns; a longer line
 * is minified code, a data literal or a crafted one, and since every pattern here is linear at
 * best its cost is the line's length, which the PR's author picks. 400 keeps a Java signature
 * with its annotations and generics, and keeps the worst line under a microsecond or so. */
export const MAX_READ_LINE_LENGTH = 400;

/** The most rows (context once, plus every `+` and `-`) a file's hunks may hold and still be
 * outlined or read for imports. Past it a file is a generated artifact, a vendored drop or a
 * data dump, and its outline would be its table of contents (`MAX_SYMBOLS_PER_FILE` already
 * says that much) — reading it would cost the window tens of milliseconds per file for a list
 * nobody reads. At about a microsecond a row the budget bounds a file at ~20 ms; a 32 MB patch
 * of files under it is read once (the cache), in about a second. */
export const MAX_READ_ROWS_PER_FILE = 20_000;

/** Rows in a file's hunks, by their content (a header can claim any count). */
function rowCount(file: PatchFile): number {
  let rows = 0;
  for (const hunk of file.fileDiff.hunks) {
    for (const block of hunk.hunkContent) {
      rows += block.type === "context" ? block.lines : block.additions + block.deletions;
    }
  }
  return rows;
}

/** A file whose hunks are past `MAX_READ_ROWS_PER_FILE` — not outlined and not read for imports.
 * Exported so the guide can say which files it left out (`components/guide/MapCard.tsx`) instead
 * of drawing a silence that reads as "declares nothing". */
export function tooLargeToRead(file: PatchFile): boolean {
  return rowCount(file) > MAX_READ_ROWS_PER_FILE;
}

// ---------------------------------------------------------------------------------------------
// Languages and their declaration patterns
// ---------------------------------------------------------------------------------------------

export type OutlineLanguage =
  | "js"
  | "python"
  | "go"
  | "rust"
  | "swift"
  | "kotlin"
  | "java"
  | "ruby"
  | "shell";

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, OutlineLanguage> = new Map([
  ["ts", "js"],
  ["tsx", "js"],
  ["mts", "js"],
  ["cts", "js"],
  ["js", "js"],
  ["jsx", "js"],
  ["mjs", "js"],
  ["cjs", "js"],
  ["py", "python"],
  ["pyi", "python"],
  ["go", "go"],
  ["rs", "rust"],
  ["swift", "swift"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["java", "java"],
  ["rb", "ruby"],
  ["rake", "ruby"],
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
]);

/** The language family a path is outlined as, by extension, or null for anything else —
 * prose, config, data, lockfiles, and the languages this table does not (yet) carry. A shell
 * script with no extension is a miss, which is the side to err on. */
export function outlineLanguage(path: string): OutlineLanguage | null {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  return LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** How a matched line is cut down to a signature: `body` keeps everything up to the body
 * (`{`, an expression-bodied `=` after the parameter list, or through an arrow's `=>`);
 * `assignment` stops at the first top-level `=`, so a type alias or an exported constant reads
 * as its name and not its value. */
type SignatureCut = "body" | "assignment";

export type DeclarationPattern = {
  /** Must capture `name`; may capture `kw`, which `KEYWORD_KIND` maps to the kind. */
  pattern: RegExp;
  kind: OutlineSymbolKind;
  /** The kind when the line is indented — a `def` inside a class is a method. */
  indentedKind?: OutlineSymbolKind;
  cut: SignatureCut;
  /** A check on the rest of the line past the match (`from` is where the match ended), for a
   * shape whose tail a regex could only test by backtracking over it. */
  rest?: (text: string, from: number) => boolean;
};

/** Whether what follows a method header's `(` (from `from` on) is `.*\)\s*(?::[^{;=]+)?\{\s*$`:
 * a `)` closing the parameters, an optional return type with no `{`, `;` or `=` in it, and the
 * body's `{` ending the line. By hand, walking back once from the brace, because as a regex the
 * `.*\)` retried the return-type tail at every `)` it could give back, and `\s*` beside
 * `[^{;=]+` split a run of spaces every possible way: a crafted `f():` and a line of spaces was
 * quadratic, which is the whole of why this is not one pattern. */
function endsAsMethodHeader(text: string, from: number): boolean {
  const line = text.trimEnd();
  const brace = line.length - 1;
  if (line[brace] !== "{") {
    return false;
  }
  // Scanning leftward: `clean` — nothing in (index, brace) is a `{`, `;` or `=`; `next` — the
  // nearest non-blank character right of `index`, or -1 when only blanks lie before the brace.
  let clean = true;
  let next = -1;
  for (let index = brace - 1; index >= from; index -= 1) {
    const char = line[index] ?? "";
    if (char === ")") {
      if (next === -1) {
        return true;
      }
      if (clean && line[next] === ":" && next < brace - 1) {
        return true;
      }
    }
    if (char === "{" || char === ";" || char === "=") {
      clean = false;
    }
    if (!isBlank(char)) {
      next = index;
    }
  }
  return false;
}

/** The kind a captured `kw` names, for the patterns that match several keywords at once. */
const KEYWORD_KIND: Readonly<Record<string, OutlineSymbolKind>> = {
  class: "class",
  object: "class",
  record: "class",
  actor: "class",
  interface: "interface",
  "@interface": "interface",
  protocol: "interface",
  struct: "struct",
  union: "struct",
  enum: "enum",
  trait: "trait",
  mod: "module",
  module: "module",
  type: "type",
};

/** Words no declaration is named, in any of the languages here. A pattern that captures one
 * has matched a statement (`if (x) {`, `} catch (e) {`) or a modifier (`class var x` in Swift,
 * where `class` is a modifier), so the match is refused rather than reported. */
const NOT_A_NAME = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "catch",
  "try",
  "finally",
  "with",
  "return",
  "throw",
  "new",
  "typeof",
  "delete",
  "void",
  "await",
  "yield",
  "super",
  "this",
  "import",
  "export",
  "function",
  "func",
  "fun",
  "fn",
  "def",
  "var",
  "let",
  "val",
  "const",
  "in",
  "of",
  "when",
  "match",
  "guard",
  "defer",
  "select",
  "go",
  "elif",
  "unless",
  "until",
]);

const SWIFT_MODIFIERS = String.raw`(?:(?:public|private|fileprivate|internal|open|static|class|final|override|mutating|nonmutating|convenience|required|indirect|@\w+(?:\([^)]*\))?)\s+)*`;
const KOTLIN_MODIFIERS = String.raw`(?:(?:public|private|protected|internal|open|override|abstract|final|suspend|inline|operator|infix|tailrec|external|data|sealed|enum|annotation|inner|value|actual|expect)\s+)*`;
const JAVA_MODIFIER = String.raw`(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp|synchronized|native|default)\s+`;

/** One row per language family; within a row the first pattern that matches wins, so a more
 * specific shape precedes a looser one (Go's receiver method before its plain `func`, Swift's
 * `class func` before `class Name`, TS's arrow-valued const before the exported one). Exported for the linearity test,
 * which runs every pattern on lines far past `MAX_READ_LINE_LENGTH`, where a polynomial backtrack
 * cannot hide behind the budget. */
export const DECLARATION_PATTERNS: Readonly<
  Record<OutlineLanguage, readonly DeclarationPattern[]>
> = {
  js: [
    {
      pattern:
        /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\b\s*(?:\*\s*)?(?<name>[A-Za-z_$][\w$]*)\s*[<(]/u,
      kind: "function",
      cut: "body",
    },
    {
      pattern:
        /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)/u,
      kind: "class",
      cut: "body",
    },
    {
      pattern: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+(?<name>[A-Za-z_$][\w$]*)/u,
      kind: "interface",
      cut: "body",
    },
    {
      pattern: /^\s*(?:export\s+)?(?:declare\s+)?type\s+(?<name>[A-Za-z_$][\w$]*)\s*(?:<.*>\s*)?=/u,
      kind: "type",
      cut: "assignment",
    },
    {
      pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(?<name>[A-Za-z_$][\w$]*)/u,
      kind: "enum",
      cut: "body",
    },
    {
      pattern: /^\s*(?:export\s+)?(?:declare\s+)?namespace\s+(?<name>[A-Za-z_$][\w$.]*)/u,
      kind: "module",
      cut: "body",
    },
    // A function held in a top-level binding: `const f = (…) =>`, `= async x =>`, `= function`.
    // Column 0 only (no `\s*`): indented, the same shape is a local helper or a callback.
    {
      pattern:
        /^(?:export\s+)?(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:<[^>]*>\s*)?\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/u,
      kind: "function",
      cut: "body",
    },
    // An exported binding is API surface whatever it holds; an unexported one is not listed.
    {
      pattern: /^export\s+(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)/u,
      kind: "variable",
      cut: "assignment",
    },
    // A method header: indented, `name(…)` with optional modifiers and return type, and the
    // line must end on the body's `{` — a call statement ends on `;` or `)`, and a call taking a
    // callback has `=>` between its `)` and its `{`. The pattern stops at the parameter list's
    // `(`; what follows it is `endsAsMethodHeader`'s to check, in one pass.
    {
      pattern:
        /^\s+(?:(?:public|private|protected|static|async|override|readonly|abstract|declare|get|set)\s+)*(?:\*\s*)?(?<name>#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>\s*)?\(/u,
      kind: "method",
      cut: "body",
      rest: endsAsMethodHeader,
    },
  ],
  python: [
    {
      pattern: /^\s*(?:async\s+)?def\s+(?<name>[A-Za-z_]\w*)\s*\(/u,
      kind: "function",
      indentedKind: "method",
      cut: "body",
    },
    { pattern: /^\s*class\s+(?<name>[A-Za-z_]\w*)\s*[(:]/u, kind: "class", cut: "body" },
  ],
  go: [
    {
      pattern: /^func\s+\([^)]*\)\s*(?<name>[A-Za-z_]\w*)\s*[[(]/u,
      kind: "method",
      cut: "body",
    },
    { pattern: /^func\s+(?<name>[A-Za-z_]\w*)\s*[[(]/u, kind: "function", cut: "body" },
    {
      pattern: /^type\s+(?<name>[A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(?<kw>struct|interface)\b/u,
      kind: "type",
      cut: "body",
    },
    { pattern: /^type\s+(?<name>[A-Za-z_]\w*)\b/u, kind: "type", cut: "assignment" },
  ],
  rust: [
    {
      pattern:
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|default)\s+)*(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+(?<name>[A-Za-z_]\w*)/u,
      kind: "function",
      indentedKind: "method",
      cut: "body",
    },
    {
      pattern:
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?<kw>struct|enum|trait|union|mod)\s+(?<name>[A-Za-z_]\w*)/u,
      kind: "struct",
      cut: "body",
    },
    {
      pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(?<name>[A-Za-z_]\w*)/u,
      kind: "type",
      cut: "assignment",
    },
  ],
  swift: [
    {
      pattern: new RegExp(String.raw`^\s*${SWIFT_MODIFIERS}func\s+(?<name>[A-Za-z_]\w*)`, "u"),
      kind: "function",
      indentedKind: "method",
      cut: "body",
    },
    {
      pattern: new RegExp(
        String.raw`^\s*${SWIFT_MODIFIERS}(?<kw>class|struct|enum|protocol|actor)\s+(?<name>[A-Za-z_]\w*)`,
        "u",
      ),
      kind: "class",
      cut: "body",
    },
  ],
  kotlin: [
    {
      pattern: new RegExp(
        String.raw`^\s*${KOTLIN_MODIFIERS}fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?(?<name>[A-Za-z_]\w*)\s*\(`,
        "u",
      ),
      kind: "function",
      indentedKind: "method",
      cut: "body",
    },
    {
      pattern: new RegExp(
        String.raw`^\s*${KOTLIN_MODIFIERS}(?<kw>class|interface|object)\s+(?<name>[A-Za-z_]\w*)`,
        "u",
      ),
      kind: "class",
      cut: "body",
    },
  ],
  java: [
    {
      pattern: new RegExp(
        String.raw`^\s*(?:${JAVA_MODIFIER})*(?<kw>class|interface|enum|record|@interface)\s+(?<name>[A-Za-z_]\w*)`,
        "u",
      ),
      kind: "class",
      cut: "body",
    },
    // At least one modifier, or `int x(` inside a method body — a local declaration with a
    // call on its right-hand side is a parenthesis away — would read as a method.
    {
      pattern: new RegExp(
        String.raw`^\s*(?:${JAVA_MODIFIER})+(?:<[^>]*>\s+)?[\w.$]+(?:<[^()]*>)?(?:\[\])*\s+(?<name>[A-Za-z_]\w*)\s*\(`,
        "u",
      ),
      kind: "method",
      cut: "body",
    },
  ],
  ruby: [
    {
      pattern: /^\s*def\s+(?<name>(?:self\.)?[A-Za-z_]\w*[?!=]?)/u,
      kind: "function",
      indentedKind: "method",
      cut: "body",
    },
    { pattern: /^\s*(?<kw>class|module)\s+(?<name>[A-Z][\w:]*)/u, kind: "class", cut: "body" },
  ],
  shell: [
    { pattern: /^\s*function\s+(?<name>[A-Za-z_][\w-]*)/u, kind: "function", cut: "body" },
    {
      pattern: /^\s*(?<name>[A-Za-z_][\w-]*)\s*\(\s*\)\s*(?:\{.*)?$/u,
      kind: "function",
      cut: "body",
    },
  ],
};

/** A declaration read off one line. */
export type Declaration = { name: string; kind: OutlineSymbolKind; signature: string };

/** The declaration `text` makes in `language`, or null. Exported for the pattern tests, which
 * pin each language's shapes — and its refusals — one line at a time. */
export function detectDeclaration(text: string, language: OutlineLanguage): Declaration | null {
  if (text.length > MAX_READ_LINE_LENGTH) {
    return null;
  }
  for (const { pattern, kind, indentedKind, cut, rest } of DECLARATION_PATTERNS[language]) {
    const match = pattern.exec(text);
    const groups = match?.groups;
    const name = groups?.["name"];
    if (
      match === null ||
      groups === undefined ||
      name === undefined ||
      NOT_A_NAME.has(name) ||
      (rest !== undefined && !rest(text, match.index + match[0].length))
    ) {
      continue;
    }
    const keyword = groups["kw"];
    const keywordKind = keyword === undefined ? undefined : KEYWORD_KIND[keyword];
    const indented = indentOf(text) > 0;
    return {
      name,
      kind: keywordKind ?? (indented && indentedKind !== undefined ? indentedKind : kind),
      signature: signatureOf(text, cut),
    };
  }
  return null;
}

/** A declaration line cut down to its signature: up to the body (or the value, for an
 * assignment), trimmed, its whitespace collapsed, its trailing `{`/`:`/`;`/`,` dropped, and
 * capped. The scan tracks bracket depth and skips quoted text, so a `{` in a parameter's type
 * (`(a: { x: number })`) or a default (`sep = "{"`) is not mistaken for the body. `->` and `=>`
 * do not close an angle bracket. */
export function signatureOf(text: string, cut: SignatureCut): string {
  let depth = 0;
  let quote: string | null = null;
  let sawParameters = false;
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "<") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
      sawParameters ||= depth === 0 && char === ")";
    } else if (char === ">") {
      const previous = text[index - 1];
      if (previous !== "=" && previous !== "-") {
        depth = Math.max(0, depth - 1);
      }
    } else if (depth === 0 && char === "{") {
      end = index;
      break;
    } else if (depth === 0 && char === "=") {
      const next = text[index + 1];
      const previous = text[index - 1] ?? "";
      if (next === ">") {
        // An arrow: keep it — it is what says the binding holds a function — and drop the body.
        end = index + 2;
        break;
      }
      const comparison = next === "=" || "=!<>".includes(previous);
      // Before the parameter list a `=` is the binding's own (`const f = (…) =>`); after it, an
      // expression body (Kotlin's `fun f(x: Int) = x * 2`, Ruby's endless `def f = …`).
      if (!comparison && (cut === "assignment" || sawParameters)) {
        end = index;
        break;
      }
    }
  }
  // The trailing `{`/`:`/`;`/`,` are dropped by hand: as `/[\s{:;,]+$/` the pattern is tried
  // from every position of a run of those characters, quadratic on a crafted one.
  const collapsed = text.slice(0, end).replaceAll(/\s+/gu, " ").trim();
  let length = collapsed.length;
  while (length > 0 && " {:;,".includes(collapsed[length - 1] ?? "")) {
    length -= 1;
  }
  const signature = collapsed.slice(0, length);
  return signature.length > MAX_SIGNATURE_LENGTH
    ? `${signature.slice(0, MAX_SIGNATURE_LENGTH - 1).trimEnd()}…`
    : signature;
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

/** One line of one hunk in unified reading order, with its text. A context line appears once
 * (its new-side copy — the text is the same on both sides), a changed line on its own side. */
type Row = {
  kind: "context" | "addition" | "deletion";
  side: ReviewSide;
  lineNumber: number;
  text: string;
};

function hunkRows(
  hunk: Hunk,
  additionLines: readonly string[],
  deletionLines: readonly string[],
): Row[] {
  const rows: Row[] = [];
  walkHunkLines(hunk, (line) => {
    if (line.kind === "context" && line.side === "deletions") {
      return;
    }
    const texts = line.side === "additions" ? additionLines : deletionLines;
    rows.push({
      kind: line.kind,
      side: line.side,
      lineNumber: line.lineNumber,
      // The parser keeps each line's own newline; nothing here wants it.
      text: (texts[line.index] ?? "").replace(/\r?\n$/u, ""),
    });
  });
  return rows;
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

/** A line that only closes something — `}`, `});`, `)`, `end`. It says where a body *ends*, not
 * how deep the edit is, so it is left out of an edit's depth: `+  doMore();` `+}` `+` `+function
 * next() {` is an edit at depth 2 that runs past its function's closing brace, not an edit at
 * column 0. */
function isCloser(text: string): boolean {
  // On the trimmed line, so no `\s*` sits beside the bracket runs: `[)}\]]+[)}\];,]*` as one
  // pattern split a run of closers every possible way before failing, quadratic on `)))…x`.
  const trimmed = text.trim();
  return trimmed === "end" || /^[)}\]][)}\];,]*$/u.test(trimmed);
}

/** A line that continues the one above it — the `): Promise<void> {` of a parameter list broken
 * over lines. Transparent to the indentation walk: it belongs to the declaration above it. */
function isContinuation(text: string): boolean {
  return /^\s*[)\]]/u.test(text);
}

type Found = OutlineSymbol & {
  /** Position in the file's reading order, for sorting. */
  order: number;
  /** The change block it came from, so a body edit seen on both sides of one block keeps its
   * new-side location. */
  block: number;
};

/** Where the indentation walk from one row ends: at a declaration — or at a refusal, `null` —
 * or off the top of the hunk, where the header is consulted only if it is shallower than
 * `threshold`. */
type WalkEnd =
  | { kind: "found"; declaration: Declaration | null }
  | { kind: "header"; threshold: number };

/** A row the walk can stop at, and where the walk from it ends. */
type Frame = { indent: number; end: WalkEnd };

/** The walk up the indentation (the module header's second source), as one monotonic stack per
 * side fed the hunk's rows in order — rather than a walk back up the hunk for every changed run,
 * which was quadratic in the hunk and took 36 s on 40k interleaved lines.
 *
 * The walk from an edit at depth `d` visits the nearest row above it shallower than `d`, then the
 * nearest row above *that* shallower than it, and so on: each step is "the previous strictly
 * shallower row", which is exactly what a stack kept strictly increasing in indent holds beneath
 * each entry. So a row pushed onto it (after popping everything at least as deep) has its whole
 * walk fixed already — what lies below it cannot change while it is on the stack — and its
 * `WalkEnd` is computed once, from its own declaration and the entry under it. An edit's answer
 * is then a binary search for the topmost entry shallower than `d`, and its `end`.
 *
 * Rows of one side are invisible to the other's stack, as they were to the walk: a context row
 * goes on both, a changed row on its own side's. Blank rows and continuations
 * (`isContinuation`) are transparent and never pushed. */
function indentWalk(): {
  push: (row: Row, declaration: Declaration | null) => void;
  enclosing: (side: ReviewSide, depth: number) => WalkEnd;
} {
  const stacks: Record<ReviewSide, Frame[]> = { additions: [], deletions: [] };
  const pushOn = (stack: Frame[], row: Row, declaration: Declaration | null): void => {
    const indent = indentOf(row.text);
    while ((stack.at(-1)?.indent ?? -1) >= indent) {
      stack.pop();
    }
    const below = stack.at(-1);
    let end: WalkEnd;
    if (declaration !== null) {
      // A changed declaration above the edit means the edit is inside a symbol this same change
      // added or removed — already reported as such, never also "modified".
      end = { kind: "found", declaration: row.kind === "context" ? declaration : null };
    } else if (indent === 0) {
      // A column-0 line that declares nothing — an import, a closing brace — ends the walk.
      end = { kind: "found", declaration: null };
    } else {
      end = below?.end ?? { kind: "header", threshold: indent };
    }
    stack.push({ indent, end });
  };
  return {
    push: (row, declaration) => {
      if (isBlank(row.text) || isContinuation(row.text)) {
        return;
      }
      if (row.kind === "context") {
        pushOn(stacks.additions, row, declaration);
        pushOn(stacks.deletions, row, declaration);
      } else {
        pushOn(stacks[row.side], row, declaration);
      }
    },
    enclosing: (side, depth) => {
      const stack = stacks[side];
      // The topmost entry shallower than `depth`; indents rise strictly up the stack.
      let low = 0;
      let high = stack.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((stack[middle]?.indent ?? 0) < depth) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return stack[low - 1]?.end ?? { kind: "header", threshold: depth };
    },
  };
}

/** The symbol whose body holds an edit, given where its walk ended: the declaration it reached,
 * or the hunk header's function context when that is shallower than the last row the walk
 * passed — see the module header for why the header comes second, and for why every doubtful
 * step answers null. */
function enclosingDeclaration(
  end: WalkEnd,
  hunkContext: string | undefined,
  language: OutlineLanguage,
): Declaration | null {
  if (end.kind === "found") {
    return end.declaration;
  }
  if (hunkContext === undefined || isBlank(hunkContext) || indentOf(hunkContext) >= end.threshold) {
    return null;
  }
  return detectDeclaration(hunkContext, language);
}

/** One answer per parsed file — see the module header. */
const OUTLINES = new WeakMap<PatchFile, readonly OutlineSymbol[]>();

/** Every symbol one file's change touched, uncapped, in reading order. Empty for a binary, for a
 * file with no hunks, for any file whose extension names no outlined language, and for one past
 * the row budget (`tooLargeToRead`). Computed once per `PatchFile` and shared: the array is the
 * cache's, so it is read-only. */
export function outlineFile(file: PatchFile): readonly OutlineSymbol[] {
  const cached = OUTLINES.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const symbols = readOutline(file);
  OUTLINES.set(file, symbols);
  return symbols;
}

function readOutline(file: PatchFile): OutlineSymbol[] {
  const language = outlineLanguage(file.path);
  if (language === null || file.isBinary || tooLargeToRead(file)) {
    return [];
  }
  const { additionLines, deletionLines } = file.fileDiff;
  const declared: Found[] = [];
  const bodies: Found[] = [];
  let order = 0;
  let block = 0;

  for (const hunk of file.fileDiff.hunks) {
    const rows = hunkRows(hunk, additionLines, deletionLines);
    const walk = indentWalk();
    let index = 0;
    while (index < rows.length) {
      const first = rows[index];
      if (first === undefined) {
        index += 1;
        continue;
      }
      if (first.kind === "context") {
        walk.push(first, detectDeclaration(first.text, language));
        index += 1;
        continue;
      }
      // One run: consecutive changed rows on one side. A change block is its deletion run then
      // its addition run, so the two runs of one block share `block`.
      const runStart = index;
      while (rows[index]?.kind === first.kind) {
        index += 1;
      }
      if (first.kind === "deletion" || rows[runStart - 1]?.kind === "context" || runStart === 0) {
        block += 1;
      }
      const run = rows.slice(runStart, index);
      const status: OutlineStatus = first.side === "additions" ? "added" : "removed";
      const declarations = run.map((row) => detectDeclaration(row.text, language));

      // Declarations on the run's lines; everything before the first one is the run's prefix —
      // the part that may be an edit to an existing body. What follows a declaration belongs to
      // it.
      let prefixEnd = run.length;
      for (const [offset, row] of run.entries()) {
        const declaration = declarations[offset] ?? null;
        if (declaration === null) {
          continue;
        }
        prefixEnd = Math.min(prefixEnd, offset);
        declared.push({
          ...declaration,
          status,
          previousSignature: null,
          side: row.side,
          line: row.lineNumber,
          source: "declaration",
          order: order + offset,
          block,
        });
      }

      // The edit's depth: its shallowest line that is neither blank nor only a closer. A loop,
      // never `Math.min(...rows)` — see the module header.
      let depth = Number.POSITIVE_INFINITY;
      let firstEdit: Row | undefined;
      for (const row of run.slice(0, prefixEnd)) {
        if (isBlank(row.text)) {
          continue;
        }
        firstEdit ??= row;
        if (!isCloser(row.text)) {
          depth = Math.min(depth, indentOf(row.text));
        }
      }
      if (depth !== Number.POSITIVE_INFINITY && firstEdit !== undefined) {
        const enclosing = enclosingDeclaration(
          walk.enclosing(first.side, depth),
          hunk.hunkContext,
          language,
        );
        if (enclosing !== null) {
          bodies.push({
            ...enclosing,
            status: "modified",
            previousSignature: null,
            side: firstEdit.side,
            line: firstEdit.lineNumber,
            source: "hunk-context",
            order,
            block,
          });
        }
      }
      // Only now onto the stack: the walk from this run looks at the rows above it.
      for (const [offset, row] of run.entries()) {
        walk.push(row, declarations[offset] ?? null);
      }
      order += run.length;
    }
  }

  return [...pairDeclarations(declared), ...dedupeBodies(bodies, declared)]
    .toSorted((a, b) => a.order - b.order)
    .map(({ order: _order, block: _block, ...symbol }) => symbol);
}

/** An added and a removed declaration of one name are one symbol, modified: first added with
 * first removed, in reading order. The pair is reported at the added line, carrying the removed
 * signature only when it differs, and sorted where the new declaration reads — git re-emitting an unchanged declaration line as `-`/`+` (it
 * does, when it realigns a body) is a body edit, not a signature change. The removed ones wait
 * in a queue per name, so a rewrite of a file of thousands of declarations pairs in one pass. */
function pairDeclarations(declared: readonly Found[]): Found[] {
  const removed = declared.filter((found) => found.status === "removed");
  const waiting = new Map<string, { queue: Found[]; next: number }>();
  for (const found of removed) {
    const entry = waiting.get(found.name) ?? { queue: [], next: 0 };
    entry.queue.push(found);
    waiting.set(found.name, entry);
  }
  const paired = new Set<Found>();
  const result: Found[] = [];
  for (const found of declared) {
    if (found.status !== "added") {
      continue;
    }
    const entry = waiting.get(found.name);
    const partner = entry?.queue[entry.next];
    if (entry === undefined || partner === undefined) {
      result.push(found);
      continue;
    }
    entry.next += 1;
    paired.add(partner);
    result.push({
      ...found,
      status: "modified",
      previousSignature: partner.signature === found.signature ? null : partner.signature,
    });
  }
  return [...result, ...removed.filter((found) => !paired.has(found))];
}

/** Body edits, one per symbol: a name whose declaration line changed anywhere in the file is
 * reported from that line and not again from context; the rest collapse on name + signature,
 * keeping the first — except that a deletion-side sighting gives way to the new-side one from
 * the same change block, the side a reader opens. */
function dedupeBodies(bodies: readonly Found[], declared: readonly Found[]): Found[] {
  const declaredNames = new Set(declared.map((found) => found.name));
  const byKey = new Map<string, Found>();
  for (const body of bodies) {
    if (declaredNames.has(body.name)) {
      continue;
    }
    const key = `${body.name}\u0000${body.signature}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, body);
    } else if (
      existing.block === body.block &&
      existing.side === "deletions" &&
      body.side === "additions"
    ) {
      byKey.set(key, { ...body, order: existing.order });
    }
  }
  return [...byKey.values()];
}

/** The outline of a whole diff, in diff order: one entry per file that touched at least one
 * symbol, capped at `MAX_SYMBOLS_PER_FILE` each. */
export function outlineDiff(
  files: readonly PatchFile[],
  options: OutlineOptions = {},
): FileOutline[] {
  const outlines: FileOutline[] = [];
  for (const file of files) {
    if (options.skip?.(file) === true) {
      continue;
    }
    const symbols = outlineFile(file);
    if (symbols.length === 0) {
      continue;
    }
    outlines.push({
      path: file.path,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
      omitted: Math.max(0, symbols.length - MAX_SYMBOLS_PER_FILE),
    });
  }
  return outlines;
}
