import { useRef, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { TooltipHint } from "@/components/ui/tooltip";

// The rail's whole vocabulary: the section bars, the rows inside them, and the small
// print at the top and bottom of a section. Four widgets sit in this column — the diff
// picker, the walkthrough, the comment overview, the file tree — and they stack
// directly on top of each other down the left edge, where any difference in height,
// inset, ink or type size reads as a mistake rather than as a distinction.
//
// So they are not four widgets that happen to look alike: they are one row style doing
// several jobs, defined once here. It was five copies before, and they had drifted
// exactly as far as five copies drift — 28px rows next to 32px rows next to a 44px row
// with 4px of padding; three different hover inks; one list whose selection band grew
// rounded corners nothing else in the rail has. None of that was decided; it accreted.
//
// The semantics stay with the widgets. A layer row is a `treeitem`, a commit row an
// `option` in a multiselect listbox, a comment row a button — those are real
// differences and they belong to the list that owns the keyboard. What is shared is
// the box and its states, so `RailRow` spreads whatever ARIA its caller hands it.

/** The focus ring every rail control takes: inset, because these run edge to edge and
 * an outset ring would be clipped by the rail's own boundary. */
export const RAIL_FOCUS =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none";

/** A list whose items are not focusable: the container holds the DOM focus and names the
 * current item with `aria-activedescendant` (the layer tree, the commit listbox — both
 * need one keyboard focus and many rows). Pair it with `RAIL_ACTIVE_ITEM` on that item,
 * and give the list a cursor so that on arrival there is always an item to name — see
 * either widget's `onFocus`.
 *
 * It takes `group` and *no ring of its own*: a ring around the whole list says the list
 * is the thing you are on, when the thing you are on is one row of it — which is also
 * the ring the reader has to look past to find out which row that is. */
export const RAIL_LIST = "group outline-none";

/** …and the ring the current item wears while its list has the keyboard. This is the
 * focus indicator those lists actually show, moved by hand onto the row the arrow keys
 * are pointing at, because no browser will put it there for us.
 *
 * A hairline, not the 2px a standalone control takes: on a 28px row running the full
 * width of a 208px rail, 2px of saturated accent is a box drawn around the text rather
 * than a mark on it, and these rows already carry a selection fill underneath. One
 * pixel of the same colour is unmistakable at this size without shouting. */
export const RAIL_ACTIVE_ITEM =
  "group-focus-visible:ring-1 group-focus-visible:ring-ring group-focus-visible:ring-inset";

/** The glyph size the whole rail is drawn at — twisties, section icons, row markers. */
export const RAIL_GLYPH = "size-3.5 shrink-0";

/** The rail's row height in px, and the two-line row's. Each is the same fact as the
 * `h-7`/`h-11` in `railRowVariants`, said twice — Tailwind cannot hand a number to a
 * virtualizer, and the commit list is virtualized off the tall one — so they move
 * together or that list drifts out of its own scroll container. */
export const RAIL_ROW_PX = 28;
export const RAIL_ROW_TALL_PX = 44;

/** The rail's left inset, in px. Rows that indent (a nested layer, a comment under its
 * file) add to it rather than inventing their own margin. */
const RAIL_INSET_PX = 8;

// ── Section bars ─────────────────────────────────────────────────────────────────

// The top level of the rail's outline — Diff, Overview, Layers, Comments — at 14px,
// the same size as the rows they head. The 12px they used to take was borrowed from
// the metadata register (a row's line number, the tree's status line), and these are
// not metadata: they are the first thing a reader looks at to find out what is here.
// At 12px muted they were the hardest text in the app to read and the least skippable.

type RailSectionProps = {
  /** The disclosure state, or null for a bar that opens nothing (Overview). Null still
   * holds the twisty's slot, so a row that discloses nothing keeps its glyph and label
   * on the same left edge as every other section. */
  expanded: boolean | null;
  /** The section's icon, in `RAIL_GLYPH`. */
  icon: ReactNode;
  /** The label line. A bar whose label is a value rather than a name (the diff bar's
   * selection, the comment count) passes its own truncating node. */
  children: ReactNode;
  /** Whether this section is the reader's current stop — only the Overview bar can be,
   * and it takes the row's selection fill like a selected row does. */
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** A control that acts on the section, at the far end of its bar (Layers' "View
   * all"). Outside the bar's own button, so it is not part of the disclosure's hit
   * target. */
  action?: ReactNode;
  /** The bar's own bottom rule. A section that opens into a resize panel lets the seam
   * handle draw it instead, so it passes false while it is open. */
  bordered: boolean;
  /** A readout for the whole bar (Layers' coverage). Anchored to the row rather than
   * the button, so it clears the rail's width instead of the trigger's — which the
   * `action` shortens whenever it is present. */
  tooltip?: ReactNode;
  tooltipDisabled?: boolean;
} & Omit<ComponentProps<"button">, "children" | "disabled" | "onSelect">;

export function RailSection({
  expanded,
  icon,
  children,
  selected = false,
  disabled = false,
  onSelect,
  action,
  bordered,
  tooltip,
  tooltipDisabled = false,
  className,
  ...rest
}: RailSectionProps): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);
  const bar = (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      {...(expanded === null ? {} : { "aria-expanded": expanded })}
      className={cn(
        "flex h-full min-w-0 flex-1 items-center gap-1.5 text-sm",
        RAIL_FOCUS,
        // Held-open-and-inert (the diff bar with no diff to go back to) and selected
        // (the doc, while it is the stop) both stop the row lighting up under the
        // pointer: neither has anywhere left to go.
        selected ? "text-foreground" : "text-text-muted enabled:hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {expanded === null ? (
        <span aria-hidden="true" className={RAIL_GLYPH} />
      ) : expanded ? (
        <ChevronDown aria-hidden="true" className={RAIL_GLYPH} />
      ) : (
        <ChevronRight aria-hidden="true" className={RAIL_GLYPH} />
      )}
      {icon}
      {/* The label truncates here rather than at each call site: a section's name is a
          fixed string and a rail is a draggable width, so *every* bar can run out of
          room — and a bar that wraps stops being a 36px row. */}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
    </button>
  );

  return (
    <div
      ref={rowRef}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 px-2",
        selected && "bg-selected",
        bordered && "border-b border-border",
      )}
    >
      {tooltip === undefined ? (
        bar
      ) : (
        <TooltipHint
          disabled={tooltipDisabled}
          side="right"
          align="center"
          anchor={rowRef}
          content={tooltip}
        >
          {bar}
        </TooltipHint>
      )}
      {action}
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────────

// Two heights, and only two. Almost every row in the rail — a layer, a comment, a
// source, a file — is 28px and one line of 14px text, because they are all the same
// kind of thing: an item in a list you scan down the left edge, whose whole content is
// its name.
//
// A commit is not that. It has a name (its subject) *and* an identity (its sha and its
// author), and both are read: the subject to find the change, the sha and author to be
// sure it is the one you meant. Those do not fit on one line at rail width and do not
// belong in a hover hint, which is for what a row could not show rather than for what
// it should. So there is a second height for exactly that shape — and no third: a row
// needing more than two lines is a row that has stopped being a list item.
const railRowVariants = cva(
  "flex w-full min-w-0 cursor-default pr-2 pl-2 text-left text-sm select-none",
  {
    variants: {
      /** One line, or two: what it is, then which one it is. The tall row is
       * `RAIL_ROW_TALL_PX`; keep the two in step. */
      lines: {
        one: "h-7 items-center gap-1.5",
        two: "h-11 flex-col justify-center gap-0",
      },
      /** The one selection fill the whole app uses (`--selected`), and full ink with it.
       * Hover sits one step below it and never joins it — a hovered row beside a selected
       * one must still read as two different things. */
      selected: {
        true: "bg-selected text-foreground",
        false: "hover:bg-border/30 hover:text-foreground",
      },
      /** Resting ink. Muted is for rows that are an *outline* of something else — a
       * layer, a comment, a section you navigate by — where a column of full ink would
       * shout. A row whose text is the content itself, in a list long enough to read
       * rather than glance at (the commit history), sets `quiet={false}`: thirty rows of
       * muted grey is a wall, and the thing you are trying to read is on every one of
       * them. It is also what a row on the trail to the soloed layer takes, so "part of
       * what you are looking at" shows without a second fill competing with the first. */
      quiet: { true: "text-text-muted", false: "text-foreground" },
    },
    defaultVariants: { lines: "one", selected: false, quiet: true },
  },
);

type RailRowProps = {
  /** Extra left inset in px, added to the rail's own. A nesting level, a row aligning
   * under a heading's glyph — never a margin invented at the call site. */
  indent?: number;
  children: ReactNode;
} & VariantProps<typeof railRowVariants>;

type RowStyleProps = VariantProps<typeof railRowVariants> & {
  indent?: number | undefined;
  className?: string | undefined;
};

function rowProps({ lines, selected, quiet, indent, className }: RowStyleProps): {
  className: string;
  style?: { paddingLeft: number };
} {
  return {
    className: cn(railRowVariants({ lines, selected, quiet }), RAIL_FOCUS, className),
    // Inline, so it overrides the base inset rather than fighting it in the cascade.
    ...(indent === undefined ? {} : { style: { paddingLeft: RAIL_INSET_PX + indent } }),
  };
}

/** A row that is not itself a control — one whose list owns the pointer and the
 * keyboard (the layer tree, the commit listbox). It takes whatever role and ARIA that
 * list needs; this only draws the box. */
export function RailRow({
  lines,
  selected,
  quiet,
  indent,
  className,
  children,
  ...rest
}: RailRowProps & ComponentProps<"div">): ReactElement {
  return (
    <div {...rowProps({ lines, selected, quiet, indent, className })} {...rest}>
      {children}
    </div>
  );
}

/** The same row where the row *is* the control — one click, one destination. */
export function RailRowButton({
  lines,
  selected,
  quiet,
  indent,
  className,
  children,
  ...rest
}: RailRowProps & ComponentProps<"button">): ReactElement {
  return (
    <button type="button" {...rowProps({ lines, selected, quiet, indent, className })} {...rest}>
      {children}
    </button>
  );
}

/** The one fact a row carries at its outer edge — a comment's line, a commit's age. One
 * column, one size, one ink, so the right edge of the rail reads as a column rather than
 * as whatever each list happened to put there. */
export function RailRowMeta({ children }: { children: ReactNode }): ReactElement {
  return <span className="shrink-0 text-xs tabular-nums text-text-faint">{children}</span>;
}

// ── Small print ──────────────────────────────────────────────────────────────────

/** The line above a list: what it is of. Sits in the metadata register, one line, and
 * never repeats a fact the section bar above it already carries. */
export function RailCaption({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("flex h-7 shrink-0 items-center gap-1.5 px-2 text-xs", className)}>
      {children}
    </div>
  );
}

/** The line under a list: how far through it you are, how to select more of it. The
 * bordered strip a desktop app has always put a count of what is above it in. */
export function RailFoot({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div
      // 12px, the rail's metadata size — not the 11px it used to take. The rail sets its
      // rows at 14px on purpose (see RailSection); a foot two steps under them was the
      // hardest line in the sidebar to read and, being an affordance, one of the few that
      // has to be read at all.
      //
      // `min-h-8`, not a fixed height: at the rail's 208px minimum a sentence-length foot
      // wraps, and a fixed box would have let it hang out of its own border. It only ever
      // grows when the width forces it to.
      className={cn(
        "flex min-h-8 shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5 text-xs leading-tight text-text-muted",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** What a section says when it has no rows to show — a failure, an empty set, a state
 * that cannot be narrowed. One inset and one register for all of them; they used to
 * land on three. */
export function RailNote({ children }: { children: ReactNode }): ReactElement {
  return <p className="px-2 py-3 text-xs text-text-muted">{children}</p>;
}
