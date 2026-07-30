import { type ReactElement, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GLASS_MUTED } from "@/components/Glass";
import { useCopyFeedback } from "@/lib/copy-feedback";
import { cn } from "@/lib/utils";

// The sentence that starts the whole loop, and the block it is handed over in.
//
// It lives in one module because it is said in two places that must never drift: the last
// stop of the first-run guide, and the start screen a reader lands on every time they have no
// review open. Those are the app's only two "what do I do now" surfaces, and the answer is
// the same one.
//
// The block shows a whole prompt and offers half of it. That asymmetry is the point. The
// review itself is the reader's own — their skill, their wording, their `CLAUDE.md`, their
// idea of what a bug is — and a block that hands over one canonical prompt teaches the
// opposite: that Reviewer has a command you run, and that the review it produces is ours.
// What is actually ours is one trailing clause saying where the findings go. So the first
// half is set as a placeholder — greyed, plainly a stand-in for whatever the reader already
// types — and the clause is marked as an addition to it, in the diff's own colour, with the
// copy button pointed at that and nothing else.

/** The half of the line that belongs to the reader: a stand-in for however they already ask
 * for a review. Not copyable, and deliberately unremarkable — naming a specific harness's
 * command here (`/code-review`, an effort flag, a skill name) would read as the required
 * incantation rather than as an example of one. */
export const AGENT_REVIEW_COMMAND = "/code-review this branch against main";

/** The half that is ours, and the only part worth copying.
 *
 * It names `rvw` and stops there on purpose. An agent told to use a CLI runs it, and running
 * `rvw` opens with the line that says to read the `present-review` skill first — so the
 * procedure lives in the tool, where it is version-locked to the tool, instead of in a string
 * someone pasted into a chat weeks ago. Every clause left out here is a clause that cannot go
 * stale, and this one is short enough to retype from memory.
 *
 * It opens with the dash, so pasting it onto the end of a prompt produces the sentence above
 * rather than two clauses jammed together. */
export const AGENT_PROMPT_CLAUSE = "— then present the findings using the rvw CLI.";

/** The prompt, and one button that copies the clause. The line is selectable too — a reader
 * who wants the whole example, or half the clause, is not blocked by what the button chose.
 *
 * The button sits immediately after the marked clause, on the clause's own line. It used to sit
 * at the far end of the label row above, which put a control that copies one specific span
 * diagonally across the block from the span it copies — the reader has to read a label to find
 * out what it takes. Abutting the band, it needs no label beyond "Copy": what is next to it is
 * what it copies, and the band is already the thing marked out from the rest of the line.
 *
 * `label` is the surface's own sentence, above the prompt. The block carries no caption of its
 * own — the marking and the adjacency say it.
 *
 * The button wears the glass action wash rather than the ghost variant's own hover for the
 * reason `Glass.tsx` gives: this block is shown on the first-run card, which is translucent,
 * and an opaque `bg-muted` hover there punches a hole in the panel under the pointer. The
 * wash is a tint either way, so one class serves both surfaces. */
export function AgentPromptBlock({
  label,
  note,
}: {
  label?: ReactNode;
  note?: ReactNode;
}): ReactElement {
  const { copied, confirm } = useCopyFeedback();

  return (
    <div className="flex flex-col gap-1.5">
      {label === undefined ? null : <p className="text-sm text-text-muted">{label}</p>}
      {/* No box around it. A bordered, filled panel is a third rectangle on a screen that
          already has a strip of tabs and a list of rows, and the two things a box would be
          saying here are said better by the type itself: mono is machine text, and the band is
          the part to take. */}
      <p className="font-mono text-[13px] leading-5 text-foreground select-text">
        {/* Faint, not muted: this is the one span the reader is meant to replace rather than
            read, and it has to lose to the clause under it. */}
        <span className="text-text-faint">{AGENT_REVIEW_COMMAND}</span>
        {/* On its own line, and the app's own device used on the app's own instructions: the
            clause is an addition to the reader's prompt, so it wears the added-line band and
            sits under what it is added to. Two lines rather than one wrapped sentence is what
            makes "this half is yours, this half is ours" legible at a glance.
            `-ml-1.5` cancels the band's own inset so both lines start on one left edge, and
            `decoration-clone` keeps the padding and corners on every fragment when a narrow
            pane wraps the clause anyway. */}
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="-ml-1.5 box-decoration-clone rounded bg-diff-add-bg px-1.5 py-0.5 text-foreground">
            {AGENT_PROMPT_CLAUSE}
          </span>
          {/* Next to what it copies. The accessible name stays explicit — a screen reader
              hears the button without the band beside it doing the explaining. */}
          <Button
            variant="ghost"
            size="xs"
            aria-label={copied ? "Clause copied" : "Copy the clause"}
            className={cn("shrink-0 rounded-full font-sans", GLASS_MUTED)}
            onClick={() => {
              navigator.clipboard.writeText(AGENT_PROMPT_CLAUSE).then(
                confirm,
                // A refused clipboard only costs the check glyph; the text is selectable right
                // there, and a block of instructions is no place for an error surface.
                () => {},
              );
            }}
          >
            {copied ? (
              <>
                <Check aria-hidden="true" className="text-diff-add-fg" />
                Copied
              </>
            ) : (
              <>
                <Copy aria-hidden="true" />
                Copy
              </>
            )}
          </Button>
        </span>
      </p>
      {/* Reading size, the same as the label above the block. It is a footnote by position, not
          by rank — dropping it a step would put the app's one "this is not Claude-only" claim
          at a size the reader has to lean in for. */}
      {note !== undefined && (
        <p className="px-0.5 text-sm leading-relaxed text-text-muted">{note}</p>
      )}
    </div>
  );
}

/** A path or command named inside a sentence on glass. `InlineCode`'s tinted chip is skipped
 * here: over a translucent surface its fill reads as a smudge rather than a marked span, so
 * the mono face does the marking on its own. */
export function Mono({ children }: { children: ReactNode }): ReactElement {
  return <span className="font-mono text-[0.95em] text-foreground/80">{children}</span>;
}

/** The note both surfaces carry under the prompt: this is not a Claude-only trick. */
export function AnyAgentNote(): ReactElement {
  return (
    <>
      Any agent works — <Mono>rvw skills</Mono> lists what ships with the CLI.
    </>
  );
}
