import { Fragment, useEffect, useId, type ReactElement, type ReactNode } from "react";
import { ArrowRight, Check, LoaderCircle, TerminalIcon } from "lucide-react";
import { AgentPromptBlock, AnyAgentNote, Mono } from "@/components/AgentPrompt";
import { Button } from "@/components/ui/button";
import { GLASS_MUTED } from "@/components/Glass";
import { shortcutBlocked } from "@/lib/shortcut-guard";
import { cn } from "@/lib/utils";
import { ONBOARDING_STEPS, useOnboardingStore } from "@/stores/onboarding";

// The first-run guide: three stops, one card, and nothing to fill in.
//
// The app is unusable until two things are true — `rvw` is on the reader's PATH, and their
// agent has been told to publish through it — and neither is discoverable from an empty
// window. So the guide's job is not to tour the interface (the interface is a diff; it tours
// itself) but to get those two facts across and hand over the one sentence that starts the
// loop. Three steps is the shortest form that still answers what it is, why the command
// exists, and what to type; anything the reader can do without is not here.
//
// It is not a modal and does not float: it is the card the start screen shows first, in place
// of the document that screen becomes once the guide has run (see StartScreen). On first launch
// there is nothing behind it to be modal over, and a scrim over a blank page is a shadow cast
// by nothing — so there is no scrim, no overlay, and no z-index. Whether it is on screen at
// all is the start screen's decision, not this component's.

/** The title takes a node rather than a string for one word's sake: `rvw` is a command, and
 * a command set in the sans of a headline reads as a typo.
 *
 * There is no eyebrow over it. Three cards with a kicker each ("What this is", "How to use
 * it") is a label saying what the sentence under it is about to say — and it earned its
 * place by being set small, which is the one size a screen someone is reading for the first
 * time cannot afford. */
type StepCopy = { title: ReactNode; body: string };

const COPY: readonly StepCopy[] = [
  {
    title: "Your agent turns a big diff into a walkthrough",
    body: "It groups the change into named layers and puts them in an order that explains it — the new data structure before the code that uses it.",
  },
  {
    title: (
      <>
        Install the <Mono>rvw</Mono> command-line tool
      </>
    ),
    body: "Your agent pipes its review into rvw, which opens it in the app. Nothing reaches Reviewer until rvw is on your PATH.",
  },
  {
    // No colon, and nothing that points forward. Every step shows its picture first and
    // explains it underneath, so a body that introduces the block above it is aimed at the
    // wrong half of the card — this one says what to do with what the reader has just read.
    title: "Ask your agent for a review",
    body: "Add the clause to however you already ask for one, from inside the repo you want reviewed. Reviewer opens the moment the review lands.",
  },
];

export function OnboardingCard(): ReactElement | null {
  const step = useOnboardingStore((state) => state.step);
  const finish = useOnboardingStore((state) => state.finish);
  const next = useOnboardingStore((state) => state.next);
  const back = useOnboardingStore((state) => state.back);
  const goTo = useOnboardingStore((state) => state.goTo);
  const titleId = useId();

  // Esc leaves, like every other dismissible surface in the app. Skipping and finishing are
  // the same act (see the store), so this is the same call the Skip button makes.
  //
  // Through the shared guard, like every other window-level key: this one used to take an
  // Escape off `window` and act on it whatever else was up, so the sheet or the recents picker
  // opened over the guide — both of which close on Escape themselves — would have been
  // dismissed *and* had the guide vanish behind them from the one press. The card carries no
  // text field today, so `isEditable` is a latent arm of the same guard rather than a live one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !shortcutBlocked(event)) {
        event.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish]);

  const copy = COPY[step] ?? COPY[0];
  if (copy === undefined) {
    return null;
  }
  const last = step === ONBOARDING_STEPS - 1;

  return (
    <section
      aria-labelledby={titleId}
      data-glass
      className="relative w-[min(44rem,calc(100%-5rem))] rounded-2xl p-7 duration-200 animate-in fade-in zoom-in-95"
    >
      <header className="flex items-center justify-between">
        <StepDots step={step} onSelect={goTo} />
        <Button variant="ghost" className={cn("rounded-full", GLASS_MUTED)} onClick={finish}>
          Skip
        </Button>
      </header>

      {/* Keyed by step so each stop fades in as its own thing. The stage keeps a floor
            height and the prose a floor of its own, so the card holds one size across all
            three — a panel that resizes under the pointer between steps reads as a page
            reloading rather than as one object being turned over. */}
      <div key={step} className="mt-4 duration-200 animate-in fade-in slide-in-from-bottom-1">
        <Stage>
          {step === 0 ? (
            <LayerStage />
          ) : step === 1 ? (
            <CliStage />
          ) : (
            <AgentPromptBlock
              label="Add the marked clause to however you ask"
              note={<AnyAgentNote />}
            />
          )}
        </Stage>
        <h2 id={titleId} className="mt-6 text-lg leading-7 font-medium text-foreground">
          {copy.title}
        </h2>
        {/* A floor, not a height: the three bodies differ by a line, and without it the card
            grows and shrinks under the pointer as you step through. */}
        <p className="mt-2 min-h-[3.5rem] text-base leading-relaxed text-text-muted">{copy.body}</p>
      </div>

      <footer className="mt-5 flex items-center justify-between gap-2">
        {/* The back door is present from the second stop on and absent — not disabled — on
              the first: a permanently dead control is a question the reader has to answer
              every time they look at the row. */}
        <div>
          {step > 0 && (
            <Button variant="ghost" className={cn("rounded-full", GLASS_MUTED)} onClick={back}>
              Back
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {step === 1 ? (
            <CliActions onContinue={next} />
          ) : (
            <Button className="rounded-lg" onClick={last ? finish : next}>
              {last ? "Done" : "Continue"}
              {!last && <ArrowRight aria-hidden="true" data-icon="inline-end" />}
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}

/** Where the reader is, and the only navigation that skips: three dots, the current one
 * stretched into a pill. The pills are 6px tall and the buttons around them are not — the
 * target is padded out to a real one, because a 6px dot is a decoration you can click by
 * accident, not a control. */
function StepDots({
  step,
  onSelect,
}: {
  step: number;
  onSelect: (step: number) => void;
}): ReactElement {
  return (
    <nav aria-label="Guide steps" className="-m-1 flex items-center">
      {Array.from({ length: ONBOARDING_STEPS }, (_, index) => (
        <button
          key={index}
          type="button"
          aria-label={`Step ${index + 1} of ${ONBOARDING_STEPS}`}
          aria-current={index === step ? "step" : undefined}
          onClick={() => onSelect(index)}
          className="cursor-pointer rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
        >
          <span
            className={cn(
              "block h-1.5 rounded-full transition-all duration-200",
              index === step
                ? "w-6 bg-foreground/70"
                : "w-1.5 bg-foreground/25 hover:bg-foreground/45",
            )}
          />
        </button>
      ))}
    </nav>
  );
}

/** The well every step's illustration sits in: a recess cut into the glass, one size for all
 * three so the card never changes shape between them. The floor is the tallest tenant's own
 * height (the layer outline's, at 186px) rather than a round number — a stage shorter than
 * one of its three occupants is a floor that does not do its job. */
function Stage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-48 flex-col justify-center rounded-xl border border-foreground/10 bg-foreground/4 p-3.5 dark:bg-foreground/6">
      {children}
    </div>
  );
}

/** The layers a walkthrough is made of, as the reader will meet them: numbered, named for
 * what that part of the change does, and one of them open. */
const STAGE_LAYERS: readonly { ordinal: string; label: string }[] = [
  { ordinal: "1", label: "Add the settings schema" },
  { ordinal: "2", label: "Load settings at startup" },
  { ordinal: "3", label: "Drop the env-var fallback" },
];

/** The open one, by index — the row the hunk hangs under. */
const STAGE_OPEN = 1;

/** Step one says what the app is for, and the answer is not "it shows diffs": it is that a
 * change arrives as an ordered set of named layers instead of as a folder of touched files.
 * So the picture leads with the outline and hangs the code off it, rather than showing a hunk
 * with an outline somewhere beside it — a reader who takes only the arrangement away from this
 * screen should take away that the review has chapters and that each one is a piece of the diff.
 *
 * It is a diagram, not a screenshot: in the app the outline is a rail down the left and the
 * soloed hunks fill the pane beside it. Nesting the code under its own row is the one thing
 * that says "these rows *are* the diff" in a well this small, and the guide's other two stages
 * are diagrams already.
 *
 * The sample is ordinary application code, for the same reason a screenshot of a text editor
 * shows a letter and not the editor's changelog. Anything about how Reviewer works internally
 * is a detour on the first screen someone ever sees.
 *
 * It is also chosen to argue the copy's point rather than merely sit under it: the open layer's
 * `+` line calls the schema the layer above it adds, so the reader can see for themselves why
 * one comes before the other. The two changed lines differ by a single token, which is as much
 * as anyone reads off a three-line hunk at 13px — a bigger edit would be a puzzle, not a
 * picture. */
function LayerStage(): ReactElement {
  return (
    <div className="flex flex-col gap-1 text-[13px]">
      {STAGE_LAYERS.map((layer, index) => (
        <Fragment key={layer.ordinal}>
          {/* The app's one selection fill on the open row, and muted ink on the rest: the
              outline is something you navigate by, so a column of full ink would shout over
              the code it is introducing. Same rule as the rail — see components/rail.tsx. */}
          <p
            className={cn(
              "flex h-7 items-center gap-2 rounded-md px-2",
              index === STAGE_OPEN ? "bg-selected text-foreground" : "text-text-muted",
            )}
          >
            <span className="shrink-0 tabular-nums">{layer.ordinal}</span>
            <span className="truncate">{layer.label}</span>
          </p>
          {index === STAGE_OPEN && (
            <div className="ml-6 overflow-hidden rounded-lg border border-foreground/10 bg-diff-surface font-mono leading-5">
              <DiffRow tone="context" text="const raw = await readFile(path)" />
              <DiffRow tone="del" text="const settings = JSON.parse(raw)" />
              <DiffRow tone="add" text="const settings = Settings.parse(raw)" />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function DiffRow({ tone, text }: { tone: "context" | "add" | "del"; text: string }): ReactElement {
  const marker = tone === "add" ? "+" : tone === "del" ? "−" : " ";
  return (
    <p
      className={cn(
        "flex gap-2 px-2.5",
        tone === "add" && "bg-diff-add-bg",
        tone === "del" && "bg-diff-del-bg",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-2 shrink-0",
          tone === "add" ? "text-diff-add-fg" : tone === "del" ? "text-diff-del-fg" : "",
        )}
      >
        {marker}
      </span>
      <span className="truncate text-foreground/75">{text}</span>
    </p>
  );
}

/** Step two says why a command-line tool is in the middle of this at all: it is the pipe.
 * The row is the whole architecture — the app has no other input, and nothing in it reaches
 * out. The middle chip wears a terminal glyph because "rvw" alone is a word the reader has
 * never seen, and the one thing they most need to know about it is what kind of thing it is. */
function CliStage(): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-center gap-2.5 text-sm">
        <Chip>your agent</Chip>
        <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-text-faint" />
        <Chip mono>
          <TerminalIcon aria-hidden="true" className="size-3.5" />
          rvw
        </Chip>
        <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-text-faint" />
        <Chip>Reviewer</Chip>
      </div>
      {/* One line, always in the same place, saying where the launcher stands. It is the
          only part of the guide that reports rather than explains — so it is the only part
          set apart as a readout, and the only part announced: a reader who authorized an
          admin prompt needs the outcome even if they were not watching this spot. */}
      <p
        aria-live="polite"
        className="flex min-h-12 items-center gap-2 rounded-lg border border-foreground/10 bg-background/50 px-3.5 py-2 text-sm leading-5 text-text-muted"
      >
        <CliStatusLine />
      </p>
    </div>
  );
}

function CliStatusLine(): ReactElement {
  const cli = useOnboardingStore((state) => state.cli);
  const installing = useOnboardingStore((state) => state.installing);
  const problem = useOnboardingStore((state) => state.problem);
  const path = cli?.path ?? "/usr/local/bin/rvw";

  if (installing) {
    return (
      <>
        <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
        Waiting for the password prompt…
      </>
    );
  }
  // Shadowed outranks installed: the launcher being on disk is not the claim the reader
  // needs, "the agent will run ours" is, and a rival earlier on the PATH makes that false
  // while every other signal here says otherwise.
  if (cli !== null && cli.shadowedBy !== null) {
    return (
      <span>
        Another <Mono>rvw</Mono> at <Mono>{cli.shadowedBy}</Mono> answers first. Installing points
        it here too.
      </span>
    );
  }
  if (cli?.installed === true) {
    return (
      <>
        <Check aria-hidden="true" className="size-3.5 shrink-0 text-diff-add-fg" />
        <span>
          Installed at <Mono>{path}</Mono>
        </span>
      </>
    );
  }
  if (problem === "missingBundle") {
    return (
      <span>
        This build ships no CLI — run <Mono>bun run build:cli</Mono>.
      </span>
    );
  }
  if (problem === "writeFailed") {
    return (
      <span>
        <Mono>{path}</Mono> was not written — the install needs an admin password.
      </span>
    );
  }
  if (cli !== null && !cli.supported) {
    return (
      <span>
        Only macOS installs the launcher. Elsewhere, run <Mono>node …/dist/rvw.js</Mono>.
      </span>
    );
  }
  return (
    <span>
      Writes <Mono>{path}</Mono>. macOS asks for your password once.
    </span>
  );
}

/** Step two's buttons, which are the step's actual work — so they replace the generic
 * Continue rather than sitting beside it. Once the launcher is there the primary goes back
 * to being Continue: offering to install what is installed is the one thing this screen
 * must never do. */
function CliActions({ onContinue }: { onContinue: () => void }): ReactElement {
  const cli = useOnboardingStore((state) => state.cli);
  const installing = useOnboardingStore((state) => state.installing);
  const installCli = useOnboardingStore((state) => state.installCli);
  // Installed is not the same as reachable: a launcher from an earlier setup answering to
  // `rvw` leaves this step unfinished, and the same button resolves it.
  const done = cli === null || !cli.supported || (cli.installed && cli.shadowedBy === null);

  if (done) {
    return (
      <Button className="rounded-lg" onClick={onContinue}>
        Continue
        <ArrowRight aria-hidden="true" data-icon="inline-end" />
      </Button>
    );
  }
  return (
    <>
      {/* An out, and a quiet one: an install that needs a password is a real decision, and a
          reader who wants to make it in their own terminal should not have to guess that
          Skip is how you say so. */}
      <Button variant="ghost" className={cn("rounded-full", GLASS_MUTED)} onClick={onContinue}>
        Later
      </Button>
      <Button className="rounded-lg" disabled={installing} onClick={() => void installCli()}>
        {installing && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        {cli !== null && cli.installed ? "Fix rvw" : "Install rvw"}
      </Button>
    </>
  );
}

function Chip({ children, mono = false }: { children: ReactNode; mono?: boolean }): ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-foreground/12 px-3 py-1 whitespace-nowrap",
        mono
          ? "bg-foreground/8 font-mono text-[13px] font-medium text-foreground"
          : "text-text-muted",
      )}
    >
      {children}
    </span>
  );
}
