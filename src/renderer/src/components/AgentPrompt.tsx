import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GLASS_MUTED } from "@/components/Glass";
import { cn } from "@/lib/utils";

// The sentence that starts the whole loop, and the block it is handed over in.
//
// It lives in one module because it is said in two places that must never drift: the last
// stop of the first-run guide, and the empty state a reader lands on every time they have no
// review open. Those are the app's only two "what do I do now" surfaces, and the answer is
// the same one.

/** What the reader pastes into their agent. Two clauses: the review command their harness
 * already ships, and where to send the result.
 *
 * It names `rvw` and stops there on purpose. An agent told to use a CLI runs it, and running
 * `rvw` opens with the line that says to read the `present-review` skill first — so the
 * procedure lives in the tool, where it is version-locked to the tool, instead of in a string
 * someone pasted into a chat weeks ago. Every clause left out here is a clause that cannot go
 * stale, and this one is short enough to retype from memory. */
export const AGENT_PROMPT =
  "/code-review — then present the findings in Reviewer using the rvw CLI.";

/** How long the copied check stands in for the copy glyph, matching the diff header's. */
const COPY_FEEDBACK_MS = 1500;

/** The prompt, and one button that puts it on the clipboard. Selectable too — this is not
 * the only way it gets copied. */
export function AgentPromptBlock({ note }: { note?: ReactNode }): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative rounded-lg border border-foreground/10 bg-background/50 py-3 pr-12 pl-3.5">
        <p className="font-mono text-sm leading-6 text-foreground select-text">{AGENT_PROMPT}</p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? "Prompt copied" : "Copy the prompt"}
          className={cn("absolute top-2 right-2", GLASS_MUTED)}
          onClick={() => {
            navigator.clipboard.writeText(AGENT_PROMPT).then(
              () => setCopied(true),
              // A refused clipboard only costs the check glyph; the text is selectable right
              // there, and a card of instructions is no place for an error surface.
              () => undefined,
            );
          }}
        >
          {copied ? <Check className="text-diff-add-fg" /> : <Copy />}
        </Button>
      </div>
      {/* Reading size, the same as the sentence that introduces the block above it. It is a
          footnote by position, not by rank — dropping it a step would put the app's one
          "this is not Claude-only" claim at a size the reader has to lean in for. */}
      {note !== undefined && (
        <p className="px-0.5 text-base leading-relaxed text-text-muted">{note}</p>
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
