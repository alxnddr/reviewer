import { useEffect, type ReactElement } from "react";
import { LoaderCircle, XIcon } from "lucide-react";
import type { CliInstallProblem } from "../../../shared/cli";
import { Button } from "@/components/ui/button";
import { GLASS_DIVIDER, GLASS_MUTED, GLASS_PRIMARY } from "@/components/Glass";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useOnboardingStore } from "@/stores/onboarding";

// The standing notice that the app has no way in.
//
// Everything Reviewer shows arrives through `rvw`: without it on the PATH the window is a
// diff viewer that no agent can reach, and the reader has no way to discover that from the
// inside — the app looks like it is working. So the condition is checked at every launch and
// every time the window comes back to the front, and while it holds, it is said.
//
// Glass, and floating, for the reason the other two glass surfaces are: this is not an event
// that happened (the failure bars in the shell's banner slot are, and they dock as solid
// strips because they are gone as soon as they are read) — it is a condition that lasts as
// long as it is true. A solid bar would push the whole app down for the duration and put a
// permanent horizontal rule across the top of someone's diff. A pill laid over the content
// belongs to the app, not to the page under it.
//
// Dismissing it lasts the session, never longer: see `cliBannerDismissed`.

export function CliBanner(): ReactElement | null {
  const cli = useOnboardingStore((state) => state.cli);
  const installing = useOnboardingStore((state) => state.installing);
  const problem = useOnboardingStore((state) => state.problem);
  const dismissed = useOnboardingStore((state) => state.cliBannerDismissed);
  const guideOpen = useOnboardingStore((state) => state.open);
  const refreshCli = useOnboardingStore((state) => state.refreshCli);
  const installCli = useOnboardingStore((state) => state.installCli);
  const dismiss = useOnboardingStore((state) => state.dismissCliBanner);

  // Every launch, and every return to the window: `rvw` is installed from a terminal at
  // least as often as from this app (`bun run build:cli`, a fresh clone, a reinstall), and
  // the reader should not have to relaunch Reviewer to be believed.
  useEffect(() => {
    void refreshCli();
    const onFocus = (): void => void refreshCli();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshCli]);

  // Two ways to be unreachable — nothing installed, or something else answering to `rvw` —
  // and one button for both: installing writes our launcher over every rival it finds, so
  // there is never a state this notice describes and cannot resolve.
  const shadowed = cli !== null && cli.shadowedBy !== null;
  if (cli === null || !cli.supported || dismissed || guideOpen || (cli.installed && !shadowed)) {
    return null;
  }

  return (
    // The strip spans the window so the pill can centre on it, and takes no pointer events
    // so the content under it stays live right up to the pill's own edge. top-13 clears the
    // 40px title bar with the same 12px inset the overview's island keeps from its edge.
    <div className="pointer-events-none fixed inset-x-0 top-13 z-30 flex justify-center px-4">
      <div
        data-glass
        role="status"
        className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-1 rounded-full py-1 pr-1 pl-3.5 duration-200 animate-in fade-in slide-in-from-top-1"
      >
        <p className="min-w-0 truncate text-sm text-foreground">
          <BannerText
            installing={installing}
            problem={problem}
            path={cli.path}
            shadowedBy={cli.shadowedBy}
          />
        </p>
        <span aria-hidden="true" className={GLASS_DIVIDER} />
        <Button
          variant="ghost"
          disabled={installing}
          className={cn("rounded-full", GLASS_PRIMARY)}
          onClick={() => void installCli()}
        >
          {installing && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {problem === null ? (shadowed ? "Fix" : "Install") : "Try again"}
        </Button>
        <TooltipHint content="Not now" side="bottom" align="end">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            className={cn("rounded-full", GLASS_MUTED)}
            onClick={dismiss}
          >
            <XIcon className="size-3.5" />
          </Button>
        </TooltipHint>
      </div>
    </div>
  );
}

/** What the pill says, in one line. It names the consequence rather than the fact — "rvw is
 * not installed" is only alarming to someone who already knows what rvw is, and the reader
 * this is for does not. */
function BannerText({
  installing,
  problem,
  path,
  shadowedBy,
}: {
  installing: boolean;
  problem: CliInstallProblem | null;
  path: string;
  shadowedBy: string | null;
}): ReactElement {
  if (installing) {
    return <>Waiting for the password prompt…</>;
  }
  if (shadowedBy !== null) {
    return (
      <>
        Another <span className="font-mono text-[0.95em]">rvw</span> at{" "}
        <span className="font-mono text-[0.95em]">{shadowedBy}</span> answers first — agents reach
        that one, not Reviewer.
      </>
    );
  }
  if (problem === "missingBundle") {
    return (
      <>
        This build ships no <span className="font-mono text-[0.95em]">rvw</span> — run{" "}
        <span className="font-mono text-[0.95em]">bun run build:cli</span>.
      </>
    );
  }
  if (problem === "writeFailed") {
    return (
      <>
        <span className="font-mono text-[0.95em]">{path}</span> was not written — the install needs
        an admin password.
      </>
    );
  }
  return (
    <>
      <span className="font-mono text-[0.95em]">rvw</span> is not installed — no agent can send a
      review here.
    </>
  );
}
