import { useState, type ReactElement } from "react";
import { ChevronDown, ChevronUp, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/Markdown";

// What the author ran to confirm a finding, folded under it. A field rather than a
// convention for a reason the renderer makes concrete: `Markdown` has no `rehype-raw`, so a
// `<details>` written into a body is dropped — an author cannot fold anything themselves,
// and the alternative they are left with is pasting a command and forty lines of output
// inline, where it buries the sentence that matters. The authoring skill says a card that
// turns into a document stops being a comment; this is what makes that rule followable.
//
// Closed on first render, always. The state is local and deliberately not persisted
// anywhere: read progress is the reader's and lives in `~/.rvw` (`main/review/progress.ts`),
// and whether a disclosure happens to be open is not progress — it is where the pointer
// was a second ago. Remembering it would also mean a comment that re-opens expanded, which
// is the layout this fold exists to avoid.
//
// The disclosure vocabulary is `UnplaceableComments`': a ghost button carrying the label
// and the chevron, the content below it, no chrome of its own. A second vocabulary for the
// same gesture is how two widgets in one column drift apart.

/** Evidence under a comment body, folded. Rendered through the same `Markdown` the body
 * takes — a fenced command and its output is the expected content, and the body's grammar
 * is the one grammar the app renders — but as a *sibling* block, never part of the body:
 * `CommentBody` renders a body and nothing else, and the rail's one-line preview flattens
 * that body alone, so evidence can never leak into the preview. */
export function CommentEvidence({ evidence }: { evidence: string }): ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        // A quiet line, not a call to action: the claim above it is what the reader came
        // for, and this says the receipts exist. Hover brightens the ink only.
        className="-ml-1.5 h-6 gap-1.5 px-1.5 text-xs text-text-muted hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
      >
        <FlaskConical aria-hidden="true" className="size-3.5" />
        Evidence
        {expanded ? (
          <ChevronUp aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-3.5" />
        )}
      </Button>
      {expanded && (
        <Markdown
          text={evidence}
          // A step down in size and ink from the body above it: the claim keeps the card's
          // reading register and the receipts sit under it as supporting material. The
          // scroll cap is what keeps a comment a comment — a hundred lines of captured
          // output scrolls in place instead of pushing the diff off screen.
          className="mt-1 max-h-64 space-y-2 overflow-y-auto text-sm break-words text-text-muted select-text"
        />
      )}
    </div>
  );
}
