import { create } from "zustand";
import type { CliInstallProblem, CliStatus } from "../../../shared/cli";
import { clamp } from "../../../shared/clamp";

// The first-run guide's state, kept out of the review store on purpose: nothing here belongs
// to a session, and the guide has to be able to run before there is one.
//
// Two facts arrive from main and neither is guessed here — whether the guide has run before,
// and whether `rvw` is on the box. Everything else (which step, how the install went) is
// screen state that dies with the window.

/** How many stops the guide has: what this is, the command that feeds it, how to ask for a
 * review. Exported so the view and the store agree on the last step without either owning
 * the count alone. */
export const ONBOARDING_STEPS = 3;

type OnboardingState = {
  /** Whether the guide is on screen. False until main says this install has never seen it,
   * or the reader asks for it again from the start screen. */
  open: boolean;
  step: number;
  /** null before main answers, and outside Electron (the preview harness), where there is
   * no launcher to have an opinion about. */
  cli: CliStatus | null;
  /** True while the admin prompt is up — a distinct question from `cli.installed`, and the
   * one the button is answering. */
  installing: boolean;
  /** Why the last install did not land, or null. Cleared when another is attempted. */
  problem: CliInstallProblem | null;
  /** Asks main both questions and opens the guide if this install has never seen it. */
  hydrate: () => Promise<void>;
  /** Re-reads where the launcher stands. Cheap (one `existsSync` in main) and worth
   * repeating: `rvw` is installed from a terminal as often as from this app, and a notice
   * that outlives the problem it names is worse than no notice. */
  refreshCli: () => Promise<void>;
  /** Re-opens it on demand — from the start screen, for a reader who skipped. */
  show: () => void;
  goTo: (step: number) => void;
  next: () => void;
  back: () => void;
  /** Closes it and records that it ran. Finishing and skipping are the same act here: both
   * mean "do not open yourself at me again". */
  finish: () => void;
  /** Runs the privileged install and re-reads where it left the launcher. */
  installCli: () => Promise<void>;
};

function clampStep(step: number): number {
  return clamp(step, 0, ONBOARDING_STEPS - 1);
}

/** Whether the standing "rvw is not installed" notice is on screen (see CliBanner).
 *
 * There is no way to dismiss it, and that is the point: without the launcher on the PATH the
 * app cannot receive a single review, so the window is a viewer no agent can reach. A notice a
 * reader can wave off is a notice about a preference; this one is about the app not working,
 * and it stands until it is not true any more — which the same button that raises it is what
 * resolves.
 *
 * Two ways to be unreachable — nothing installed, or another launcher answering to `rvw` — and
 * neither is worth saying while the guide is up, which says it better and is where the install
 * button properly lives.
 *
 * A predicate over the store rather than a condition inside the component so it can be proven
 * without mounting anything, like every other rule in this app that decides whether a surface
 * exists. */
export function cliNoticeShowing(state: Pick<OnboardingState, "cli" | "open">): boolean {
  const cli = state.cli;
  if (cli === null || !cli.supported || state.open) {
    return false;
  }
  return !cli.installed || cli.shadowedBy !== null;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  open: false,
  step: 0,
  cli: null,
  installing: false,
  problem: null,

  hydrate: async () => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    // Both questions in one await: the guide's first frame needs the launcher's state as
    // much as it needs permission to appear — opening and *then* discovering `rvw` is
    // already there would ask the reader to install what they have.
    const [onboarded, cli] = await Promise.all([bridge.getOnboarded(), bridge.getCliStatus()]);
    set((state) => ({ cli, open: state.open || !onboarded }));
  },

  refreshCli: async () => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    const cli = await bridge.getCliStatus();
    // A launcher that turned up while the app was in the background also clears whatever
    // the last failed attempt left on screen — the complaint is about a state that is over.
    set(cli.installed ? { cli, problem: null } : { cli });
  },

  show: () => set({ open: true, step: 0 }),
  goTo: (step) => set({ step: clampStep(step) }),
  next: () => set((state) => ({ step: clampStep(state.step + 1) })),
  back: () => set((state) => ({ step: clampStep(state.step - 1) })),

  finish: () => {
    set({ open: false });
    // Fire-and-forget: main swallows a failed write, and the reader is already out of the
    // guide — nothing on screen is waiting on the answer.
    void window.reviewer?.completeOnboarding();
  },

  installCli: async () => {
    const bridge = window.reviewer;
    if (!bridge || get().installing) {
      return;
    }
    set({ installing: true, problem: null });
    try {
      const result = await bridge.installCli();
      set({ cli: result.status, installing: false, problem: result.problem });
    } catch (error) {
      console.error("rvw could not be installed:", error);
      set({ installing: false, problem: "writeFailed" });
    }
  },
}));
