// A layer's chapter-intro description: a deliberately small markdown-lite tier, not
// full Markdown. Blank lines separate paragraphs; within a paragraph,
// `[label](path)` links and `` `code` `` spans interleave with plain text. A code
// span or link `path` that names a file present in the diff resolves to a clickable
// file chip (`file` set); anything else stays inert (`file: null`), failing soft.
// Pure: the diff is injected as a path set, so the parser has no I/O and is fully
// testable.

export type DescriptionRun =
  | { kind: "text"; text: string }
  /** Inline `code`; `file` is set when the span names a file in the diff, which
   * promotes it to a clickable chip at render. */
  | { kind: "code"; text: string; file: string | null }
  /** `[label](path)` link; `file` is the resolved diff path, or null when the
   * target is not in the diff (rendered muted, never navigable). */
  | { kind: "link"; label: string; path: string; file: string | null };

/** One paragraph — a run of inline segments. Blank-line separated in the source. */
export type DescriptionParagraph = { runs: DescriptionRun[] };

const LINK_SOURCE = String.raw`\[([^\]]+)\]\(([^)]+)\)`;
const CODE_SOURCE = "`([^`]+)`";

/** Fresh per call: a global regex carries `lastIndex` state that must not leak
 * across paragraphs. */
function tokenPattern(): RegExp {
  return new RegExp(`${LINK_SOURCE}|${CODE_SOURCE}`, "g");
}

function resolve(path: string, diffFiles: ReadonlySet<string>): string | null {
  return diffFiles.has(path) ? path : null;
}

function paragraphRuns(text: string, diffFiles: ReadonlySet<string>): DescriptionRun[] {
  // Soft-wrap: a single newline inside a paragraph is a space, matching how the
  // reading band flows the text; blank-line splits already happened above.
  const flowed = text.replace(/\s*\n\s*/g, " ");
  const runs: DescriptionRun[] = [];
  const pattern = tokenPattern();
  let cursor = 0;
  for (const match of flowed.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) {
      runs.push({ kind: "text", text: flowed.slice(cursor, start) });
    }
    const [, linkLabel, linkPath, code] = match;
    if (linkLabel !== undefined && linkPath !== undefined) {
      runs.push({
        kind: "link",
        label: linkLabel,
        path: linkPath,
        file: resolve(linkPath, diffFiles),
      });
    } else if (code !== undefined) {
      runs.push({ kind: "code", text: code, file: resolve(code, diffFiles) });
    }
    cursor = start + match[0].length;
  }
  if (cursor < flowed.length) {
    runs.push({ kind: "text", text: flowed.slice(cursor) });
  }
  return runs;
}

/** Split a description into paragraphs of resolved inline runs. Empty in → empty
 * out (the caller falls back to the one-line `summary`). */
export function parseLayerDescription(
  description: string,
  diffFiles: ReadonlySet<string>,
): DescriptionParagraph[] {
  return description
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => ({ runs: paragraphRuns(paragraph, diffFiles) }));
}
