import {
  createContext,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import type { PluggableList } from "unified";
import {
  MARKDOWN_PLUGINS,
  readLinkTarget,
  remarkFileReferences,
  type ReferenceSpan,
} from "../../../shared/markdown";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { InlineCode } from "@/components/InlineCode";
import { MermaidDiagram } from "@/components/MermaidDiagram";
import { mermaidSource } from "@/lib/mermaid";
import { cn } from "@/lib/utils";

// The app's one prose tier, rendered: the markdown a layer `description`, the overview
// `body`, and a comment body all share. remark parses it (CommonMark + GFM, see
// `shared/markdown.ts`); everything below is *presentation* — the app's face for each
// element, and nothing about the grammar. One component so the chapter band, the tour
// doc, and the comment card can never render the same prose three different ways, and so
// a surface added later inherits the whole language instead of re-deciding which slice of
// it to support.
//
// `links` is what a surface can *navigate*, and it is optional because navigation is the
// one thing that differs: the artifact's own prose resolves file references against the
// diff, so a chip always lands on something on screen and an absent target is inert — the
// rule `rvw check` gates against. A comment carries no such contract (it is written
// against one line, and a stranded one names a file that left the diff), so it renders
// the same prose with every reference inert. Web links work on every surface: the main
// process hands an outbound navigation to the OS browser, and drops anything not https.
//
// `diagrams` is the other thing a surface chooses, and it is opt-in: the overview and a
// layer description draw a ```mermaid fence as a diagram (`MermaidDiagram`), a comment does
// not. A comment is read beside the code, and a card that unfolds into a figure has stopped
// being a comment — so there a mermaid fence stays what every fence is, its source. Off by
// default rather than on, so a surface added later gets the quiet answer until someone
// decides otherwise, and `MermaidDiagram.test.ts` holds the two comment surfaces to it.

/** Where a reference may land, on a surface that can navigate; undefined on one that
 * cannot, which is the whole difference between the artifact's prose and a comment body —
 * so the set and the way into it arrive together or not at all, rather than as two props
 * that can disagree. */
export type ProseLinks = {
  /** The files a reference may resolve to — the soloed subset in a chapter band, the
   * whole diff in the tour doc. Paths only: whether the *line* a reference names still
   * places is the store's question to answer, since it holds the diff's hunks — so a
   * reference into a file that is here is live, and one whose line has drifted lands on
   * the file the way a stranded comment does. The gate is what makes that rare. */
  paths: readonly string[];
  onSelect: (path: string, span: ReferenceSpan | null) => void;
};

/** Set inside a fenced block, where the `code` element is quoted source rather than an
 * inline token — the one thing the element itself cannot say (hast spells both `code`,
 * and a fence carries a language class only when its author wrote one). */
const InFence = createContext(false);

type FileChipProps = {
  /** What the prose calls it — a link's label, or the path itself. */
  label: ReactNode;
  /** What it resolves to, which is what the icon is drawn from: a chip may be labelled
   * anything, but it always stands for one real file in the diff. */
  path: string;
  /** The line range it points at, or null for the whole file. */
  span: ReferenceSpan | null;
  onSelect: () => void;
};

/** The line marker a chip wears: `:12`, `:12-20` — the grammar's own spelling, so what the
 * reader sees is what the author typed and what an editor or a shell would take. The side is
 * deliberately not printed: it steers where the chip lands, and `@deletions` in the middle of
 * a sentence spends four words' worth of room on a distinction the destination shows for
 * itself. */
function lineMarker(span: ReferenceSpan): string {
  return span.startLine === span.endLine
    ? `:${span.startLine}`
    : `:${span.startLine}-${span.endLine}`;
}

/** A resolved file reference: a chip that jumps the diff to the file. Set in the prose's
 * own face, not mono — it names a file, it does not quote code, and a mono run inside a
 * sentence reads as a foreign body. Sized and padded a step tighter than the button's `xs`
 * so the chip sits *in* the line rather than swelling it.
 *
 * Laid out `inline-block`, not the button's default `inline-flex`: a flex box takes its
 * baseline from its *first item*, which here is the icon — a glyph with no baseline of its
 * own, so the browser synthesises one at its bottom edge and the whole chip rides above the
 * sentence it sits in. As an inline block the baseline comes from the chip's own line of
 * text, which is the label, so the label sits on the prose's baseline exactly as the words
 * either side of it do. Height then follows from the line box (no fixed `h-*`, which an
 * inline block would honour and force the text off-centre inside its own border), and the
 * icon goes back to being an inline glyph nudged onto the text's optical middle. */
function FileChip({ label, path, span, onSelect }: FileChipProps): ReactElement {
  return (
    <Button
      type="button"
      variant="chrome"
      size="xs"
      onClick={onSelect}
      className="mx-0.5 inline-block h-auto rounded border border-border-strong px-1.5 align-baseline text-sm leading-5"
    >
      {/* The file's own type glyph, exactly as the tree and the doc's file rows draw it —
          a file looks like itself wherever the app names it, mid-sentence included. */}
      <FileTypeIcon path={path} className="mr-1 inline size-3.5 align-[-0.2em]" />
      {label}
      {/* Mono and quiet, and no space before it: a line number is a coordinate, not a word,
          and set in the prose face at full contrast it read as part of the label. */}
      {span !== null && (
        <span className="font-mono text-xs text-text-muted">{lineMarker(span)}</span>
      )}
    </Button>
  );
}

/** Unresolved reference on a surface that navigates: the target is not in this diff.
 * Shown as a label, never a dead click — and in the same face and inset as the live chip,
 * so the only difference a reader sees is the one that matters (no border weight, no
 * hover, no icon). */
function DeadRef({ label }: { label: ReactNode }): ReactElement {
  return (
    <TooltipHint content="Not in this diff" side="top" align="center">
      <span className="mx-0.5 rounded border border-border/60 px-1.5 text-sm text-text-muted">
        {label}
      </span>
    </TooltipHint>
  );
}

/** A reference on a surface that navigates nowhere — a comment's `[label](path)`. It reads
 * as its label, in the sentence's own face: a chip would promise a click the surface cannot
 * honour, and the raw path inline would be noise in a body that is three lines long. The
 * dotted underline is the standard "there is more behind this word" mark, and the hint
 * carries what it stands for, so nothing the author wrote is lost. */
function InertRef({ label, path }: { label: ReactNode; path: string }): ReactElement {
  return (
    <TooltipHint content={path} side="top" align="center">
      <span className="underline decoration-text-faint decoration-dotted underline-offset-2">
        {label}
      </span>
    </TooltipHint>
  );
}

/** Markers in the faint ink: they structure the text, they are not the text. */
const LIST_CLASS = "space-y-1 pl-5 marker:text-text-faint";

/** How each element of the grammar is set. Built per surface because two things differ —
 * the anchor (where a reference can go) and whether a mermaid fence is drawn; everything
 * else is the app's fixed face for prose. */
function proseComponents(links: ProseLinks | undefined, diagrams: boolean): Components {
  const diffFiles = new Set(links?.paths ?? []);

  return {
    p: ({ children }) => <p className="break-words">{children}</p>,
    // Two ranks, both under the section headings the prose already sits beneath: `#`/`##`
    // read at the body size in the medium weight (what a nested overview section takes),
    // deeper levels drop to the small size. Rendered as h3/h4 — every surface that shows
    // prose puts its own h1/h2 above it.
    h1: ({ children }) => <h3 className="text-base font-medium break-words">{children}</h3>,
    h2: ({ children }) => <h3 className="text-base font-medium break-words">{children}</h3>,
    h3: ({ children }) => <h4 className="text-sm font-medium break-words">{children}</h4>,
    h4: ({ children }) => <h4 className="text-sm font-medium break-words">{children}</h4>,
    h5: ({ children }) => <h4 className="text-sm font-medium break-words">{children}</h4>,
    h6: ({ children }) => <h4 className="text-sm font-medium break-words">{children}</h4>,
    ul: ({ children, className }) => (
      // A task list carries its own boxes, so it drops the discs it would otherwise
      // double up on (the class is GFM's own mark on the element).
      <ul
        className={`${className?.includes("contains-task-list") === true ? "list-none" : "list-disc"} ${LIST_CLASS}`}
      >
        {children}
      </ul>
    ),
    ol: ({ children, start }) => (
      <ol start={start} className={`list-decimal ${LIST_CLASS}`}>
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="break-words">{children}</li>,
    // Inert by construction — a checkbox in read-only prose reports the author's state,
    // it does not take the reader's.
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <input type="checkbox" checked={checked} readOnly className="mr-1.5 align-[-0.1em]" />
      ) : null,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border-strong pl-3 break-words text-text-muted">
        {children}
      </blockquote>
    ),
    // Quoted code is a foreign body and dresses like one: hairline frame, faint tinted
    // ground, mono a step under the reading size — the diff snippet's own surface. It
    // scrolls sideways rather than wrapping; wrapped code lies about its line breaks.
    //
    // A mermaid fence is decided here and not in `code`, one element down, where the
    // language class actually arrives: by then the block is already inside this `<pre>`,
    // and a diagram is not preformatted text. So the hast node is read for its language
    // (`mermaidSource`), and the fence built below is handed over whole — it is what the
    // diagram shows while it loads and what it falls back to when the text does not parse.
    pre: ({ children, node }) => {
      const fence = (
        <pre className="overflow-x-auto rounded-md border border-border bg-border/20 px-3 py-2 font-mono text-sm leading-6 whitespace-pre">
          <InFence value={true}>{children}</InFence>
        </pre>
      );
      const source = diagrams ? mermaidSource(node) : null;
      return source === null ? fence : <MermaidDiagram source={source} fence={fence} />;
    },
    code: ({ children }) => <CodeSpan>{children}</CodeSpan>,
    // The hairline the doc already draws at its section boundaries.
    hr: () => <hr className="border-border" />,
    // A step past the headings' `font-medium`: a heading gets its contrast from size and
    // placement, an inline bold has only weight — at 500 it disappears into the sentence.
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="text-text-muted line-through">{children}</del>,
    a: ({ children, href }) => (
      <ProseLink href={href ?? ""} links={links} files={diffFiles}>
        {children}
      </ProseLink>
    ),
    // A table is a small figure inside the prose, not a page element: hairlines, a tinted
    // header row, and its own horizontal scroll so a wide one never widens the column.
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-border/20">{children}</thead>,
    tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
    th: ({ children, style }) => (
      <th style={style} className="px-2 py-1 text-left font-medium">
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="px-2 py-1 align-top">
        {children}
      </td>
    ),
  };
}

/** react-markdown's own href sanitizer, minus the one case it gets wrong for this app: it
 * blanks any target whose first colon precedes a `/` and is not a known protocol, which is
 * `index.ts:12` — a line reference to a file at the repo root. A reference is handed through
 * untouched (`ProseLink` renders it as a chip or a dead label, never as an `<a href>`, so
 * nothing it returns can become a navigation), and everything else keeps the library's
 * default, which is what keeps `javascript:` and `data:` out of an href in prose the app did
 * not write. */
function referenceAwareUrlTransform(url: string): string {
  return readLinkTarget(url).kind === "external" ? defaultUrlTransform(url) : url;
}

/** A `code` element, which hast spells the same inside a fence and inside a sentence: in a
 * fence it is the block's own text and takes the block's face, inline it is the chip. */
function CodeSpan({ children }: { children: ReactNode }): ReactElement {
  return useContext(InFence) ? <code>{children}</code> : <InlineCode>{children}</InlineCode>;
}

type ProseLinkProps = {
  href: string;
  links: ProseLinks | undefined;
  /** The files the surface can navigate to, which a reference's *path* is matched against. */
  files: ReadonlySet<string>;
  children: ReactNode;
};

/** A link, read the app's way (`readLinkTarget`, shared with the gate): the web opens in the
 * browser (the main process routes an outbound navigation and refuses anything but https),
 * and a path — with or without a line suffix — is a file reference: a chip when the surface
 * can go there, inert when it cannot.
 *
 * A malformed target takes the dead-reference path rather than one of its own, which is
 * exactly what it is: a reference to a place that is not in this diff, because no such place
 * exists. It is also the one arm the artifact's own prose cannot reach — the gate refuses a
 * draft carrying one — so what it really serves is a comment body, which nothing gates. */
function ProseLink({ href, links, files, children }: ProseLinkProps): ReactElement {
  const target = readLinkTarget(href);
  if (target.kind === "external") {
    return (
      <a href={href} className="underline decoration-text-faint underline-offset-2">
        {children}
      </a>
    );
  }
  const path = target.kind === "reference" ? target.path : href;
  const span = target.kind === "reference" ? target.span : null;
  if (links === undefined) {
    return <InertRef label={children} path={href} />;
  }
  if (!files.has(path)) {
    return <DeadRef label={children} />;
  }
  return (
    <FileChip
      label={children}
      path={path}
      span={span}
      onSelect={() => links.onSelect(path, span)}
    />
  );
}

type MarkdownProps = {
  text: string;
  /** Where a reference may land, on a surface that can navigate; omitted on one that
   * cannot, which renders every reference inert. */
  links?: ProseLinks | undefined;
  className?: string;
  /** Draw ```mermaid fences as diagrams. The artifact's own prose asks for it; a comment
   * surface leaves it off and keeps the fence — see the header. */
  diagrams?: boolean;
  /** The measured block when a caller fits a panel to the prose's own height
   * (`lib/fit-panel.ts`); absent everywhere the prose just flows. */
  ref?: RefObject<HTMLDivElement | null> | undefined;
};

export function Markdown({
  text,
  links,
  diagrams = false,
  className,
  ref,
}: MarkdownProps): ReactElement {
  const paths = links?.paths;
  const onSelect = links?.onSelect;

  // Keyed on the file set rather than the `links` object, which callers build inline: a
  // new plugin list re-parses the prose, and prose does not change because its parent
  // re-rendered.
  const plugins = useMemo<PluggableList>(
    () =>
      paths === undefined
        ? MARKDOWN_PLUGINS
        : [...MARKDOWN_PLUGINS, remarkFileReferences(new Set(paths))],
    [paths],
  );
  const components = useMemo(
    () =>
      proseComponents(
        paths === undefined || onSelect === undefined ? undefined : { paths, onSelect },
        diagrams,
      ),
    [paths, onSelect, diagrams],
  );

  // The pipeline runs on render, and a comment card re-renders with the diff it hangs in —
  // so the parse is held against its three real inputs. Nothing here changes because a
  // parent scrolled.
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        urlTransform={referenceAwareUrlTransform}
      >
        {text}
      </ReactMarkdown>
    ),
    [plugins, components, text],
  );

  return (
    // Prose sets its own whitespace mode wherever it is mounted. A comment card hangs
    // *inside* the diff, which renders `white-space: pre` so a code line keeps its own
    // spaces — inherited into prose, that turns every insignificant newline between two
    // markdown blocks into a blank line on the card. A fence opts back in (above); it is
    // the only part of prose whose line breaks are the author's.
    <div ref={ref} className={cn("whitespace-normal", className)}>
      {rendered}
    </div>
  );
}
