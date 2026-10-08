import { describe, expect, it } from "vitest";
import { resolveAnchor } from "./anchor";
import {
  backtrackingLines,
  buildExportsPatch,
  buildHugeAdditionPatch,
  MOVED_BLOCK_PATCH,
  MULTI_STATUS_PATCH,
  ONE_HUNK_PATCH,
  OUTLINE_PATCH,
  RENAMES_PATCH,
  TWO_HUNKS_PATCH,
} from "./fixtures";
import {
  DECLARATION_PATTERNS,
  detectDeclaration,
  MAX_READ_LINE_LENGTH,
  MAX_READ_ROWS_PER_FILE,
  MAX_SIGNATURE_LENGTH,
  MAX_SYMBOLS_PER_FILE,
  outlineDiff,
  outlineFile,
  outlineLanguage,
  signatureOf,
  tooLargeToRead,
  type OutlineLanguage,
  type OutlineSymbol,
} from "./outline";
import { parsePatch, type PatchFile } from "./patch";
import { walkFileLines } from "./walk";

// The outline is a claim about code the reader has not opened yet, so its tests pin both halves
// of "conservative": what it finds on a real captured diff (`OUTLINE_PATCH`, file by file), and
// what it refuses — prose, locals, control flow, a hunk header that names the wrong function.
// The invariant test at the bottom is the contract with the UI: every symbol opens on a changed
// line that an anchor places on.

const files = parsePatch(OUTLINE_PATCH, "outline-test");

function file(path: string): PatchFile {
  const found = files.find((candidate) => candidate.path === path);
  if (found === undefined) {
    throw new Error(`fixture has no ${path}`);
  }
  return found;
}

/** `status kind name @side:line (source)` — the readable form for whole-file assertions. */
function trace(symbols: readonly OutlineSymbol[]): string[] {
  return symbols.map(
    (symbol) =>
      `${symbol.status} ${symbol.kind} ${symbol.name} @${symbol.side}:${symbol.line} (${symbol.source})`,
  );
}

describe("outlineFile on a real diff", () => {
  it("pairs signature changes, finds added arrow consts, and attributes a body edit from in-hunk context", () => {
    const symbols = outlineFile(file("src/blob.ts"));
    expect(trace(symbols)).toEqual([
      "modified function loadBlob @additions:4 (declaration)",
      "added function patchText @additions:8 (declaration)",
      "modified method record @additions:15 (declaration)",
      "modified method size @additions:21 (hunk-context)",
    ]);
    expect(symbols[0]).toMatchObject({
      signature: "export async function loadBlob(path: string, attempts = 3): Promise<string>",
      previousSignature: "export function loadBlob(path: string): Promise<string>",
    });
    expect(symbols[1]?.signature).toBe(
      "export const patchText = (previous: string, next: string): string =>",
    );
    expect(symbols[2]?.previousSignature).toBe("record(path: string): void");
    // A body edit carries no previous signature: the declaration line did not change.
    expect(symbols[3]).toMatchObject({ signature: "size(): number", previousSignature: null });
  });

  it("never lists an unexported const, which is a local of the module rather than its surface", () => {
    expect(outlineFile(file("src/blob.ts")).map((symbol) => symbol.name)).not.toContain(
      "blobCache",
    );
    expect(outlineFile(parsePatch(buildHugeAdditionPatch(40), "outline-test")[0]!)).toEqual([]);
  });

  it("names the function the edit is in, not the one git's hunk header names", () => {
    const handlers = file("src/handlers.ts");
    // The premise, read off the parse: git's funcname is the column-0 line above the hunk.
    expect(handlers.fileDiff.hunks[0]?.hunkContext).toBe("export function first(): number {");
    expect(trace(outlineFile(handlers))).toEqual([
      // Seen on both sides of one block; reported once, at the new side.
      "modified function second @additions:7 (hunk-context)",
      "removed function third @deletions:10 (declaration)",
    ]);
  });

  it("falls back to the header's function context when the hunk holds no declaration", () => {
    expect(trace(outlineFile(file("cmd/server.go")))).toEqual([
      "added struct Server @additions:5 (declaration)",
      "modified function serve @additions:9 (declaration)",
      "modified method Handle @additions:19 (hunk-context)",
    ]);
    expect(outlineFile(file("cmd/server.go"))[1]?.previousSignature).toBe(
      "func serve(addr string) error",
    );
  });

  it("reads Python by indentation, and attributes a deep edit to the class the header names", () => {
    expect(trace(outlineFile(file("tools/sync.py")))).toEqual([
      "modified class Syncer @additions:14 (hunk-context)",
      "added function backoff @additions:23 (declaration)",
    ]);
    expect(outlineFile(file("tools/sync.py"))[1]?.signature).toBe(
      "def backoff(attempt: int) -> float",
    );
  });

  it("finds a shell function and attributes a top-level edit to nothing", () => {
    expect(trace(outlineFile(file("scripts/install.sh")))).toEqual([
      "added function install_bin @additions:4 (declaration)",
    ]);
  });

  it("does not outline prose, however much a line reads like a declaration", () => {
    expect(outlineFile(file("README.md"))).toEqual([]);
  });

  it("reports a function moved between files as removed from one and added to the other", () => {
    const moved = parsePatch(MOVED_BLOCK_PATCH, "outline-test");
    expect(moved.map((current) => trace(outlineFile(current)))).toEqual([
      ["removed function formatTitle @deletions:3 (declaration)"],
      ["added function formatTitle @additions:3 (declaration)"],
    ]);
  });
});

describe("outlineDiff", () => {
  it("lists only files that touched a symbol, in diff order", () => {
    expect(outlineDiff(files).map((outline) => outline.path)).toEqual([
      "cmd/server.go",
      "scripts/install.sh",
      "src/blob.ts",
      "src/handlers.ts",
      "tools/sync.py",
    ]);
  });

  it("leaves out whatever the caller's predicate skips", () => {
    const outlines = outlineDiff(files, { skip: (current) => current.path.startsWith("src/") });
    expect(outlines.map((outline) => outline.path)).toEqual([
      "cmd/server.go",
      "scripts/install.sh",
      "tools/sync.py",
    ]);
  });

  it("caps a file's list and counts the rest", () => {
    const [outline] = outlineDiff(
      parsePatch(buildExportsPatch(MAX_SYMBOLS_PER_FILE + 7), "outline-test"),
    );
    expect(outline?.symbols).toHaveLength(MAX_SYMBOLS_PER_FILE);
    expect(outline?.omitted).toBe(7);
    expect(outline?.symbols[0]?.signature).toBe("export function step0(): number");
  });

  it("outlines nothing in a diff that declares nothing, binaries and renames included", () => {
    for (const patch of [RENAMES_PATCH, ONE_HUNK_PATCH, TWO_HUNKS_PATCH]) {
      expect(outlineDiff(parsePatch(patch, "outline-test"))).toEqual([]);
    }
  });

  it("reads an edit that runs past its function's closing brace as an edit to that function", () => {
    // `greet.ts`: `-  return …` / `+  return …` `+}` `+` `+export function shout(…) {` — git
    // aligned greet's own `}` with shout's, so greet's closing brace is a `+` line in the run.
    // The rest of the diff is a binary, a pure rename and text files, none of which outline.
    const outlines = outlineDiff(parsePatch(MULTI_STATUS_PATCH, "outline-test"));
    expect(outlines.map((outline) => [outline.path, trace(outline.symbols)])).toEqual([
      [
        "greet.ts",
        [
          "modified function greet @additions:2 (hunk-context)",
          "added function shout @additions:5 (declaration)",
        ],
      ],
    ]);
  });

  it("opens every symbol on a changed line that an anchor places on", () => {
    for (const patch of [OUTLINE_PATCH, MOVED_BLOCK_PATCH, buildExportsPatch(3)]) {
      const parsed = parsePatch(patch, "outline-test");
      for (const outline of outlineDiff(parsed)) {
        const current = parsed.find((candidate) => candidate.path === outline.path)!;
        const changed = new Set<string>();
        walkFileLines(current.fileDiff, (line) => {
          if (line.kind !== "context") {
            changed.add(`${line.side}:${line.lineNumber}`);
          }
        });
        for (const symbol of outline.symbols) {
          expect(changed.has(`${symbol.side}:${symbol.line}`)).toBe(true);
          const anchor = {
            file: outline.path,
            side: symbol.side,
            startLine: symbol.line,
            endLine: symbol.line,
          };
          expect(resolveAnchor(anchor, { kind: "derived", file: current.fileDiff }).status).toBe(
            "placed",
          );
        }
      }
    }
  });
});

describe("outlineLanguage", () => {
  it("reads the family off the extension and nothing else", () => {
    expect(outlineLanguage("src/a.tsx")).toBe("js");
    expect(outlineLanguage("lib/x.PY")).toBe("python");
    expect(outlineLanguage("README.md")).toBeNull();
    expect(outlineLanguage("bun.lock")).toBeNull();
    expect(outlineLanguage("package.json")).toBeNull();
    expect(outlineLanguage("scripts/install")).toBeNull();
    expect(outlineLanguage(".bashrc")).toBeNull();
  });
});

describe("detectDeclaration", () => {
  /** `[line, kind name]` rows per language; `null` where the line must be refused. */
  const cases: Record<OutlineLanguage, [string, string | null][]> = {
    js: [
      ["export default async function* walk<T>(root: T) {", "function walk"],
      ["export abstract class Store<T> extends Base {", "class Store"],
      ["export interface Props {", "interface Props"],
      ["export type Pair<A = string> = [A, A];", "type Pair"],
      ["export const enum Mode {", "enum Mode"],
      ["declare namespace NodeJS {", "module NodeJS"],
      ["const handler = async (event: Event): Promise<void> => {", "function handler"],
      ["export const id = x => x;", "function id"],
      ["export const DIFF_ARGS = [", "variable DIFF_ARGS"],
      ["  private async record(path: string): Promise<void> {", "method record"],
      ["  constructor(private readonly store: Store) {", "method constructor"],
      // Refusals: locals, control flow, calls, callbacks, and the word "type" as a key.
      ["const cache = new Map();", null],
      ["  const onClick = () => {", null],
      ["  if (ready) {", null],
      ["  } else if (ready) {", null],
      ["  switch (kind) {", null],
      ["  useEffect(() => {", null],
      ['  describe("outline", () => {', null],
      ["  doThing(a, b);", null],
      ['  type: "added",', null],
      [" * function documented() in a JSDoc block", null],
    ],
    python: [
      ["def run(self, items):", "function run"],
      ["    async def fetch(self) -> bytes:", "method fetch"],
      ["class Syncer(Base):", "class Syncer"],
      ["    result = define(x)", null],
      ["    if x:", null],
    ],
    go: [
      ["func (s *Server) Handle(path string) string {", "method Handle"],
      ["func Map[T any](xs []T) []T {", "function Map"],
      ["type Server struct {", "struct Server"],
      ["type Reader interface {", "interface Reader"],
      ["type ID = string", "type ID"],
      ["type (", null],
      ["\tgo func() {", null],
    ],
    rust: [
      ['pub(crate) async unsafe extern "C" fn poll(&mut self) -> Poll<()> {', "function poll"],
      ["    fn len(&self) -> usize {", "method len"],
      ["pub struct Tree<T> {", "struct Tree"],
      ["pub enum Event {", "enum Event"],
      ["pub trait Visit {", "trait Visit"],
      ["mod tests {", "module tests"],
      ["pub type Result<T> = std::result::Result<T, Error>;", "type Result"],
      ["impl Display for Tree {", null],
      ["    let fn_name = 1;", null],
    ],
    swift: [
      ["    public static func make(with value: Int) -> Self {", "method make"],
      ["final class Loader: NSObject {", "class Loader"],
      ["struct Point {", "struct Point"],
      ["protocol Shape {", "interface Shape"],
      ["    class func shared() -> Loader {", "method shared"],
      ["    class var current: Loader {", null],
      ["extension Loader {", null],
    ],
    kotlin: [
      ["suspend fun load(id: String): Blob {", "function load"],
      ["    override fun <T> List<T>.second(): T = this[1]", "method second"],
      ["data class Point(val x: Int, val y: Int)", "class Point"],
      ["sealed interface Event", "interface Event"],
      ["object Registry {", "class Registry"],
      ["    companion object {", null],
      ["    val fun1 = 2", null],
    ],
    java: [
      ["public final class Loader extends Base {", "class Loader"],
      ["public record Point(int x, int y) {", "class Point"],
      ["  public static <T> List<T> copy(List<T> source) {", "method copy"],
      ["  private Map<String, List<Blob>> index(String key) throws IOException {", "method index"],
      ["    int total = count(items);", null],
      ["    return new Loader(path);", null],
      ["  private final Map<String, X> cache = new HashMap<>();", null],
    ],
    ruby: [
      ["  def self.build(attrs = {})", "method self.build"],
      ["def valid?", "function valid?"],
      ["class Loader < Base", "class Loader"],
      ["module Reviewer", "module Reviewer"],
      ["  class << self", null],
      ["  define_method(:x) { 1 }", null],
    ],
    shell: [
      ["install_bin() {", "function install_bin"],
      ["function cleanup {", "function cleanup"],
      ['echo "install_bin() is ready"', null],
      ["install_bin rvw", null],
    ],
  };

  for (const [language, rows] of Object.entries(cases) as [OutlineLanguage, typeof cases.js][]) {
    it(`reads ${language}`, () => {
      const read = rows.map(([line]) => {
        const declaration = detectDeclaration(line, language);
        return declaration === null ? null : `${declaration.kind} ${declaration.name}`;
      });
      expect(read).toEqual(rows.map(([, expected]) => expected));
    });
  }
});

describe("signatureOf", () => {
  it("cuts at the body's brace, not at a brace inside the parameters or a string", () => {
    expect(signatureOf("function f(a: { x: number }, sep = '{') {", "body")).toBe(
      "function f(a: { x: number }, sep = '{')",
    );
  });

  it("keeps an arrow and drops what it returns", () => {
    expect(signatureOf("const f = <T>(a: T): T => a;", "body")).toBe("const f = <T>(a: T): T =>");
  });

  it("drops an expression body after the parameters, and a trailing colon", () => {
    expect(signatureOf("fun twice(x: Int): Int = x * 2", "body")).toBe("fun twice(x: Int): Int");
    expect(signatureOf("def run(self, items):", "body")).toBe("def run(self, items)");
  });

  it("does not let -> close a generic", () => {
    expect(signatureOf("fn f() -> Result<Vec<u8>, E> {", "body")).toBe(
      "fn f() -> Result<Vec<u8>, E>",
    );
  });

  it("stops an assignment at its name", () => {
    expect(signatureOf("export type Pair<A = string> = [A, A];", "assignment")).toBe(
      "export type Pair<A = string>",
    );
  });

  it("collapses whitespace and caps the length", () => {
    expect(signatureOf("  function   f(a,   b) {", "body")).toBe("function f(a, b)");
    const long = signatureOf(`function f(${"a: string, ".repeat(20)}) {`, "body");
    expect(long).toHaveLength(MAX_SIGNATURE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});

// A PR's patch is someone else's input, read inside a render, so the outline has to stay linear
// on whatever shape of line or hunk they chose (the module header's four rules). Each case is the
// input that once broke it. The time bounds are generous — tens of times what the linear code
// takes, a fraction of what the old code did — so a slow machine passes and a polynomial does not.
describe("stays linear on adversarial input", () => {
  const LANGUAGES: readonly OutlineLanguage[] = [
    "js",
    "python",
    "go",
    "rust",
    "swift",
    "kotlin",
    "java",
    "ruby",
    "shell",
  ];

  it("matches every pattern in time linear in the line, far past the length budget", () => {
    // 20,000 characters: a linear pattern fails in well under a millisecond; each of the old
    // polynomial ones took 0.4 s to 3 s on one such line. The budget would hide them at 400.
    let slowest = { ms: 0, at: "" };
    for (const language of LANGUAGES) {
      for (const { pattern, rest } of DECLARATION_PATTERNS[language]) {
        for (const line of backtrackingLines(20_000)) {
          const started = performance.now();
          pattern.exec(line);
          rest?.(line, 0);
          const ms = performance.now() - started;
          if (ms > slowest.ms) {
            slowest = {
              ms,
              at: `${language} ${String(pattern)} on ${JSON.stringify(line.slice(0, 12))}…`,
            };
          }
        }
      }
    }
    const started = performance.now();
    for (const line of backtrackingLines(20_000)) {
      signatureOf(line, "body");
      signatureOf(line, "assignment");
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(slowest.ms, slowest.at).toBeLessThan(100);
  });

  it("matches a line at the length budget quickly, in every language", () => {
    const lines = backtrackingLines(MAX_READ_LINE_LENGTH);
    const started = performance.now();
    for (const language of LANGUAGES) {
      for (const line of lines) {
        detectDeclaration(line, language);
      }
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("never hands a line past the budget to a pattern", () => {
    const started = performance.now();
    expect(detectDeclaration(`function f(${" ".repeat(20_000)}) {`, "js")).toBeNull();
    expect(detectDeclaration(" ".repeat(20_000) + "x", "js")).toBeNull();
    expect(detectDeclaration("  f():" + " ".repeat(20_000) + "x", "js")).toBeNull();
    // Each of these took 0.4–0.7 s before the budget.
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("still reads method headers whose tail it checks by hand", () => {
    for (const line of [
      "  async load(path: string): Promise<void> {",
      "  render() {",
      "  private static parse<T>(text: string, into: (value: T) => void): T | null {",
      "  get size():  number  {  ",
    ]) {
      expect(detectDeclaration(line, "js")?.kind).toBe("method");
    }
    for (const line of [
      "  run(task);",
      "  items.forEach((item) => {",
      "  f(): { a: number } {",
      "  f() = {",
    ]) {
      expect(detectDeclaration(line, "js")).toBeNull();
    }
  });

  it("finds the enclosing symbol of every edit in one pass over a large hunk", () => {
    // Every other line changed, in one hunk just under the row budget: 13,000 lines, 19,500 rows.
    // The walk back up the hunk per run took 3.5 s on this; the stack takes tens of ms.
    const count = 13_000;
    const body = Array.from({ length: count }, (_, index) =>
      index % 2 === 0 ? `   x${index},` : `-  y${index},\n+  z${index},`,
    );
    const patch = [
      "diff --git a/data.ts b/data.ts",
      "index 0000001..1111111 100644",
      "--- a/data.ts",
      "+++ b/data.ts",
      `@@ -1,${count} +1,${count} @@ export const table = [`,
      ...body,
      "",
    ].join("\n");
    const [data] = parsePatch(patch, "outline-test");
    expect(tooLargeToRead(data!)).toBe(false);
    const started = performance.now();
    const symbols = outlineFile(data!);
    expect(performance.now() - started).toBeLessThan(1500);
    // Every one of the 6,500 edits sits in the header's `table`, reported once at the first.
    expect(trace(symbols)).toEqual(["modified variable table @additions:2 (hunk-context)"]);
  });

  it("attributes edits under nested symbols through the stack, popping what closed", () => {
    const [nested] = parsePatch(
      [
        "diff --git a/src/shapes.ts b/src/shapes.ts",
        "index 1111111..2222222 100644",
        "--- a/src/shapes.ts",
        "+++ b/src/shapes.ts",
        "@@ -1,13 +1,13 @@",
        " export class Shapes {",
        "   area(): number {",
        "     if (this.round) {",
        "-      return 3;",
        "+      return Math.PI;",
        "     }",
        "     return 1;",
        "   }",
        " ",
        "   perimeter(): number {",
        "     const sides = 4;",
        "-    return sides;",
        "+    return sides * this.side;",
        "   }",
        " }",
        "",
      ].join("\n"),
      "outline-test",
    );
    expect(trace(outlineFile(nested!))).toEqual([
      "modified method area @additions:4 (hunk-context)",
      "modified method perimeter @additions:11 (hunk-context)",
    ]);
  });

  it("returns the same answer for the same parsed file without reading it again", () => {
    const [steps] = parsePatch(buildExportsPatch(5), "outline-test");
    expect(outlineFile(steps!)).toBe(outlineFile(steps!));
  });

  it("leaves a file past the row budget unread instead of throwing or stalling", () => {
    // 150,000 added lines: `Math.min(...rows)` threw RangeError past ~120k of them.
    const [huge] = parsePatch(buildHugeAdditionPatch(150_000), "outline-test");
    expect(tooLargeToRead(huge!)).toBe(true);
    const started = performance.now();
    expect(outlineDiff([huge!])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
    const [under] = parsePatch(buildHugeAdditionPatch(MAX_READ_ROWS_PER_FILE), "outline-test");
    expect(tooLargeToRead(under!)).toBe(false);
  });
});
