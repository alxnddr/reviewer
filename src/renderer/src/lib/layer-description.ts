// A layer's chapter-intro description: a deliberately small markdown tier, not the
// full spec. Block level: paragraphs on blank lines, `#` headings, `-`/`1.` lists,
// `>` quotes, ``` fences, and `---` rules. Inline: `` `code` `` spans, `[label](path)`
// links, `**strong**`, and `*emphasis*`. A code span or link `path` that names a file
// present in the diff resolves to a clickable file chip (`file` set); anything else
// stays inert (`file: null`), failing soft. Pure: the diff is injected as a path set,
// so the parser has no I/O and is fully testable.

export type DescriptionRun =
  | { kind: "text"; text: string }
  /** Inline `code`; `file` is set when the span names a file in the diff, which
   * promotes it to a clickable chip at render. */
  | { kind: "code"; text: string; file: string | null }
  /** `[label](path)` link; `file` is the resolved diff path, or null when the
   * target is not in the diff (rendered muted, never navigable). */
  | { kind: "link"; label: string; path: string; file: string | null }
  /** `**strong**` — nests the runs inside the markers, so a bolded phrase keeps
   * its code spans and links live. */
  | { kind: "strong"; runs: DescriptionRun[] }
  /** `*emphasis*` (or `_emphasis_` between non-word characters), nesting like strong. */
  | { kind: "emphasis"; runs: DescriptionRun[] };

export type DescriptionBlock =
  /** A run of inline segments. Blank-line separated in the source; a single
   * newline inside is a soft wrap. */
  | { kind: "paragraph"; runs: DescriptionRun[] }
  /** `#`–`######` heading. `level` is the authored hash count; the renderer clamps
   * it to the ranks a description may sit under. */
  | { kind: "heading"; level: number; runs: DescriptionRun[] }
  /** A run of `-`/`*`/`+` bullets or `1.`/`1)` numbers. `start` is the first
   * authored number (1 for a bulleted list); indented follow-on lines soft-wrap
   * into their item. */
  | { kind: "list"; ordered: boolean; start: number; items: DescriptionRun[][] }
  /** `>`-prefixed lines, soft-wrapped into one aside. */
  | { kind: "quote"; runs: DescriptionRun[] }
  /** A ``` fence, verbatim — no inline parsing, no soft wrap. The info string
   * (language tag) is dropped: nothing here highlights. */
  | { kind: "codeBlock"; text: string }
  /** `---` thematic break. */
  | { kind: "rule" };

// Inline grammar, one alternation so left-to-right order decides ties at a given
// index: a link swallows any backticks in its label, `**` is tried before `*`, and
// the `_` forms demand a non-word neighbourhood so snake_case never italicises.
// Emphasis content excludes its own marker and bare edge whitespace — `2 * 3 * 4`
// stays arithmetic.
const LINK_SOURCE = String.raw`\[(?<linkLabel>[^\]]+)\]\((?<linkPath>[^)]+)\)`;
const CODE_SOURCE = "`(?<code>[^`]+)`";
const STRONG_SOURCE = String.raw`\*\*(?<strong>[^\s*](?:[^*]*[^\s*])?)\*\*`;
const STRONG_UNDERSCORE_SOURCE = String.raw`(?<![\w_])__(?<strongUnderscore>[^\s_](?:[^_]*[^\s_])?)__(?![\w_])`;
const EMPHASIS_SOURCE = String.raw`\*(?<emphasis>[^\s*](?:[^*]*[^\s*])?)\*`;
const EMPHASIS_UNDERSCORE_SOURCE = String.raw`(?<![\w_])_(?<emphasisUnderscore>[^\s_](?:[^_]*[^\s_])?)_(?![\w_])`;

/** Fresh per call: a global regex carries `lastIndex` state that must not leak
 * across blocks. */
function tokenPattern(): RegExp {
  return new RegExp(
    [
      LINK_SOURCE,
      CODE_SOURCE,
      STRONG_SOURCE,
      STRONG_UNDERSCORE_SOURCE,
      EMPHASIS_SOURCE,
      EMPHASIS_UNDERSCORE_SOURCE,
    ].join("|"),
    "g",
  );
}

function resolve(path: string, diffFiles: ReadonlySet<string>): string | null {
  return diffFiles.has(path) ? path : null;
}

function inlineRuns(text: string, diffFiles: ReadonlySet<string>): DescriptionRun[] {
  // Soft-wrap: a single newline inside a block is a space, matching how the
  // reading band flows the text; block splits already happened above.
  const flowed = text.replace(/\s*\n\s*/g, " ");
  const runs: DescriptionRun[] = [];
  const pattern = tokenPattern();
  let cursor = 0;
  for (const match of flowed.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) {
      runs.push({ kind: "text", text: flowed.slice(cursor, start) });
    }
    const groups = match.groups ?? {};
    const strong = groups["strong"] ?? groups["strongUnderscore"];
    const emphasis = groups["emphasis"] ?? groups["emphasisUnderscore"];
    if (groups["linkLabel"] !== undefined && groups["linkPath"] !== undefined) {
      runs.push({
        kind: "link",
        label: groups["linkLabel"],
        path: groups["linkPath"],
        file: resolve(groups["linkPath"], diffFiles),
      });
    } else if (groups["code"] !== undefined) {
      runs.push({ kind: "code", text: groups["code"], file: resolve(groups["code"], diffFiles) });
    } else if (strong !== undefined) {
      // Recurse so a bolded phrase keeps its inner spans; the shrinking input bounds it.
      runs.push({ kind: "strong", runs: inlineRuns(strong, diffFiles) });
    } else if (emphasis !== undefined) {
      runs.push({ kind: "emphasis", runs: inlineRuns(emphasis, diffFiles) });
    }
    cursor = start + match[0].length;
  }
  if (cursor < flowed.length) {
    runs.push({ kind: "text", text: flowed.slice(cursor) });
  }
  return runs;
}

const FENCE = /^\s*```/;
const CLOSING_FENCE = /^\s*```\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/;
const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_LINE = /^\s*>\s?(.*)$/;

/** Would this line open a non-paragraph block? One answer for both what ends a
 * paragraph and what ends a list item's soft-wrapped continuation, or the two drift. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET_ITEM.test(line) ||
    ORDERED_ITEM.test(line) ||
    QUOTE_LINE.test(line)
  );
}

/** Parse a description into blocks of resolved inline runs. Empty in → empty out
 * (the caller falls back to the one-line `summary`). */
export function parseLayerDescription(
  description: string,
  diffFiles: ReadonlySet<string>,
): DescriptionBlock[] {
  const lines = description.split("\n");
  const blocks: DescriptionBlock[] = [];
  let index = 0;

  const collectListItems = (matchItem: (line: string) => string | null): DescriptionRun[][] => {
    const items: string[][] = [];
    while (index < lines.length) {
      const line = lines[index] ?? "";
      const item = matchItem(line);
      if (item !== null) {
        items.push([item]);
        index += 1;
        continue;
      }
      // An indented plain line soft-wraps into the item above; anything else —
      // blank line, new block, or an unindented paragraph line — ends the list.
      const continues =
        items.length > 0 && line.trim() !== "" && /^\s/.test(line) && !startsBlock(line);
      if (!continues) {
        break;
      }
      items[items.length - 1]?.push(line.trim());
      index += 1;
    }
    return items.map((item) => inlineRuns(item.join("\n"), diffFiles));
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      // Verbatim until the closing fence; an unclosed fence soft-fails by running
      // to the end rather than erasing the rest of the description.
      index += 1;
      const content: string[] = [];
      while (index < lines.length && !CLOSING_FENCE.test(lines[index] ?? "")) {
        content.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "codeBlock", text: content.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        runs: inlineRuns(heading[2] ?? "", diffFiles),
      });
      index += 1;
      continue;
    }

    // Before the bullet test: `- - -` reads as a rule, not a list of dashes.
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (BULLET_ITEM.test(line)) {
      const items = collectListItems((candidate) => BULLET_ITEM.exec(candidate)?.[1] ?? null);
      blocks.push({ kind: "list", ordered: false, start: 1, items });
      continue;
    }

    const ordered = ORDERED_ITEM.exec(line);
    if (ordered !== null) {
      const items = collectListItems((candidate) => ORDERED_ITEM.exec(candidate)?.[2] ?? null);
      blocks.push({ kind: "list", ordered: true, start: Number(ordered[1] ?? "1"), items });
      continue;
    }

    if (QUOTE_LINE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const inner = QUOTE_LINE.exec(lines[index] ?? "")?.[1];
        if (inner === undefined) {
          break;
        }
        quoted.push(inner);
        index += 1;
      }
      blocks.push({ kind: "quote", runs: inlineRuns(quoted.join("\n"), diffFiles) });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "" || startsBlock(next)) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", runs: inlineRuns(paragraph.join("\n"), diffFiles) });
  }

  return blocks;
}

/** Every inline run a block carries, flattened through strong/emphasis nesting —
 * the gate walks this to apply its dead-link rule wherever prose can hold a link,
 * without re-stating the block shapes. */
export function blockInlineRuns(block: DescriptionBlock): DescriptionRun[] {
  const flatten = (runs: DescriptionRun[]): DescriptionRun[] =>
    runs.flatMap((run) =>
      run.kind === "strong" || run.kind === "emphasis" ? [run, ...flatten(run.runs)] : [run],
    );
  switch (block.kind) {
    case "paragraph":
    case "heading":
    case "quote":
      return flatten(block.runs);
    case "list":
      return flatten(block.items.flat());
    case "codeBlock":
    case "rule":
      return [];
  }
}
