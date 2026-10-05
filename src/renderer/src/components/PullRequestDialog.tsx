import { useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Check, Copy, FolderGit2, GitPullRequest, LoaderCircle, RefreshCw } from "lucide-react";
import type {
  GitHubFailure,
  GitHubInboxItem,
  GitHubPullRequestInfo,
} from "../../../shared/github-ipc";
import { pullRequestLabel, pullRequestUrl, type PullRequest } from "../../../shared/pull-request";
import type {
  BaseSuggestion,
  PullRequestFailure,
  PullRequestWorktree,
  WorktreeChange,
} from "../../../shared/pull-request-ipc";
import { githubLogin } from "../../../shared/settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TooltipHint } from "@/components/ui/tooltip";
import { useCopyFeedback } from "@/lib/copy-feedback";
import { githubUncheckedReason, inboxFailureMessage } from "@/lib/github-failure-message";
import {
  pullRequestFailureMessage,
  pullRequestInputMessage,
} from "@/lib/pull-request-failure-message";
import { readPullRequestInput } from "@/lib/pull-request-input";
import { absoluteTime, shortAge } from "@/lib/relative-time";
import { useCoarseNow } from "@/lib/use-coarse-now";
import { suggestedBase, usePullRequestStore, validBase } from "@/stores/pull-request";
import { useReviewStore } from "@/stores/review";
import { useSettingsStore } from "@/stores/settings";

// File ▸ Review Pull Request… (⇧⌘P): someone else's pull request, made ready for the reader's
// own agent (`next-features.md`, B3). Paste its address; the dialog finds a checkout of its
// repository the app already knows (or asks for one, or — as a last resort — clones one),
// fetches the pull request into it with the reader's own git credentials, gives it a worktree,
// and copies a prompt that tells the agent where to review and how to hand the findings back.
// The agent is the reader's to run: Reviewer prepares the checkout and hands over words.
//
// **The menu is the only door.** The start screen names two things and stays at two
// (`StartScreen.tsx`); this lives in File, in the `?` sheet, and nowhere else.
//
// **The slab, not the glass lens** (`ui/dialog.tsx`): this asks questions — which pull request,
// which base — and is dismissed once answered. Sized like Settings rather than the default
// card, because it carries a list.
//
// **One column of sections, in the order the work goes:** the address, then the checkout it
// resolved to and the base to compare against, then the prepared worktree and its prompt, then
// the inbox of pull requests waiting on the reader (B5), then every worktree made so far with
// the way to remove each. Pasting stays the first thing and the list it fills sits under it: a
// row picked from the inbox takes the paste's own path (`setInput`, then `locate`), so the two
// cannot diverge.
//
// **GitHub as a refinement.** The inbox and the pull request's title, state and base come from
// GitHub's API (`main/github/`). The inbox is always asked without a sign-in — public repositories
// only, which it says in one quiet line. The pull request's own lookup uses the reader's token for
// its owner when main holds one (Layer C), so a private repository's title and base can come
// back too; without one it is anonymous, as before. Nothing in the flow waits on either — a
// private repository's pull request is pasted and fetched with the reader's own git credentials
// exactly as before, with the base guessed locally and a line saying why GitHub did not answer.
//
// Sections read the store (`stores/pull-request.ts`), the rail's rule (`ReviewRail.tsx`): each
// is mounted once and names its own state; a worktree row is drawn per item and takes props.

export function PullRequestDialog(): ReactElement {
  const open = usePullRequestStore((state) => state.open);
  const openDialog = usePullRequestStore((state) => state.openDialog);
  const close = usePullRequestStore((state) => state.close);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openDialog() : close())}>
      <DialogContent className="top-[10vh] flex max-h-[80vh] w-[min(40rem,calc(100%-4rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <header className="flex shrink-0 flex-col gap-1 border-b border-border px-5 py-4 pr-12">
          <DialogPrimitive.Title className="text-base leading-none font-medium text-foreground">
            Review Pull Request
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-text-muted">
            Fetches it into a worktree beside your checkout and copies a prompt for your agent. Your
            branch and your uncommitted work are not touched.
          </DialogPrimitive.Description>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-5 py-4">
          <AddressSection />
          <CheckoutSection />
          <PrepareSection />
          <InboxSection />
          <WorktreesSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A section's heading, in the settings sheet's register. */
function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return (
    <h3 className="text-xs font-medium tracking-wide text-text-muted uppercase">{children}</h3>
  );
}

/** A sentence that explains a refusal, under the control it is about. */
function Problem({ children }: { children: ReactNode }): ReactElement {
  return (
    <p role="alert" className="text-sm leading-snug text-destructive">
      {children}
    </p>
  );
}

function Spinner(): ReactElement {
  return <LoaderCircle aria-hidden="true" className="animate-spin" />;
}

/** The address field. Read as it is typed, so a problem is named before anything is asked of
 * main; Enter or Find looks the checkout up. */
function AddressSection(): ReactElement {
  const input = usePullRequestStore((state) => state.input);
  const setInput = usePullRequestStore((state) => state.setInput);
  const locate = usePullRequestStore((state) => state.locate);
  const busy = usePullRequestStore((state) => state.busy);
  const read = readPullRequestInput(input);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (read.kind === "pullRequest") {
      void locate(read.pullRequest);
    }
  };

  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit}>
      <label htmlFor="pull-request-address" className="text-sm text-foreground">
        Pull request
      </label>
      <div className="flex gap-2">
        <Input
          id="pull-request-address"
          autoFocus
          value={input}
          placeholder="https://github.com/owner/repo/pull/123 or owner/repo#123"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={read.kind === "problem"}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={read.kind !== "pullRequest" || busy !== null}
        >
          {busy === "locating" && <Spinner />}
          Find
        </Button>
      </div>
      {read.kind === "problem" && <Problem>{pullRequestInputMessage(read.problem)}</Problem>}
    </form>
  );
}

/** Where the pull request will be fetched: the checkout found (with its remote, and the base to
 * compare against), or — when none is known — the two ways to name one. */
function CheckoutSection(): ReactElement | null {
  const target = usePullRequestStore((state) => state.target);
  const checkout = usePullRequestStore((state) => state.checkout);
  const busy = usePullRequestStore((state) => state.busy);
  const failure = usePullRequestStore((state) => state.failure);
  const prepared = usePullRequestStore((state) => state.prepared);
  const pickCheckout = usePullRequestStore((state) => state.pickCheckout);
  const cloneCheckout = usePullRequestStore((state) => state.cloneCheckout);
  const info = usePullRequestStore((state) => state.info);

  if (target === null) {
    return null;
  }
  // A failure before any checkout is known (a located directory refused, a clone that failed)
  // is told here; once one is known, the prepare section owns the failures.
  const ownFailure = checkout.kind !== "found" && failure !== null && prepared === null;

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>Checkout of {pullRequestLabel(target)}</SectionTitle>
      {info.phase === "loaded" && <PullRequestSummary info={info.info} />}
      {checkout.kind === "none" && busy === "locating" && (
        <p className="text-sm text-text-muted">Looking among the repositories Reviewer knows…</p>
      )}
      {checkout.kind === "found" && (
        <div className="flex items-start gap-2">
          <FolderGit2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-muted" />
          <p className="min-w-0 flex-1 text-sm break-words text-foreground">
            {checkout.checkout.repo.path}
            <span className="text-text-muted"> · remote {checkout.checkout.remote}</span>
          </p>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-text-muted"
            disabled={busy !== null}
            onClick={() => void pickCheckout()}
          >
            Use another…
          </Button>
        </div>
      )}
      {checkout.kind === "notFound" && (
        <>
          <p className="text-sm text-text-muted">
            None of the repositories Reviewer knows has a remote for {target.owner}/{target.repo}.
            Point it at your checkout — it is remembered for this repository&apos;s next pull
            request.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={busy !== null} onClick={() => void pickCheckout()}>
              {busy === "picking" && <Spinner />}
              Locate Repository…
            </Button>
            {/* The fallback, never the default: a second copy of a repository the reader
                already has somewhere is worse than being asked where it is. */}
            <Button variant="ghost" disabled={busy !== null} onClick={() => void cloneCheckout()}>
              {busy === "cloning" && <Spinner />}
              {busy === "cloning" ? "Cloning…" : "No checkout? Clone one…"}
            </Button>
            {busy === "cloning" && <CancelButton />}
          </div>
          {/* Accurate about what "partial" saves: the clone's own checkout of the default
              branch downloads every file there; what waits is every *other* version's
              contents — the pull request's changed files arrive when its worktree is made. */}
          <p className="text-xs text-text-faint">
            A clone is partial: the history and the default branch&apos;s files now, any other
            version of a file only when something needs it.
          </p>
        </>
      )}
      {ownFailure && <FailureLine failure={failure} />}
    </section>
  );
}

/** The base, the fetch, and what came of it: the worktree and the prompt, copied the moment it
 * exists. One component for the button and the result so the one copy flash
 * (`useCopyFeedback`) answers both the automatic copy and the Copy button after it. */
function PrepareSection(): ReactElement | null {
  const target = usePullRequestStore((state) => state.target);
  const checkout = usePullRequestStore((state) => state.checkout);
  const base = usePullRequestStore((state) => state.base);
  const setBase = usePullRequestStore((state) => state.setBase);
  const busy = usePullRequestStore((state) => state.busy);
  const failure = usePullRequestStore((state) => state.failure);
  const prepared = usePullRequestStore((state) => state.prepared);
  const prepare = usePullRequestStore((state) => state.prepare);
  const info = usePullRequestStore((state) => state.info);
  const template = useSettingsStore((state) => state.resolved.pullRequestPrompt);
  const refreshPullRequestHeads = useReviewStore((state) => state.refreshPullRequestHeads);
  const { copied, confirm } = useCopyFeedback();
  // Whether the automatic copy landed, so the line under the prompt says so only when it did.
  const [onClipboard, setOnClipboard] = useState(false);

  if (target === null || checkout.kind !== "found") {
    return null;
  }
  const validated = validBase(base);

  const copy = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setOnClipboard(true);
        confirm();
      },
      // A refused clipboard costs the check and the line; the prompt is on screen to select.
      () => setOnClipboard(false),
    );
  };

  const run = (event: FormEvent): void => {
    event.preventDefault();
    setOnClipboard(false);
    void prepare(template).then((result) => {
      if (result === null) {
        return;
      }
      // An open review of this pull request now has a newer head to warn about.
      void refreshPullRequestHeads(target);
      // Copied only into a dialog that is still up: a fetch left running behind a closed dialog
      // must not overwrite the clipboard minutes later, under whatever the reader copied since.
      // The prompt waits in the dialog, with its Copy, for when they reopen it.
      if (usePullRequestStore.getState().open) {
        copy(result.prompt);
      }
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <form className="flex flex-col gap-1.5" onSubmit={run}>
        <label htmlFor="pull-request-base" className="text-sm text-foreground">
          Base branch
        </label>
        <div className="flex gap-2">
          <Input
            id="pull-request-base"
            value={base}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={validated === null}
            className="font-mono md:text-[13px]"
            onChange={(event) => setBase(event.target.value)}
          />
          <Button type="submit" disabled={validated === null || busy !== null}>
            {busy === "preparing" && <Spinner />}
            {busy === "preparing" ? "Fetching…" : "Fetch and make worktree"}
          </Button>
          {busy === "preparing" && <CancelButton />}
        </div>
        <p className="text-xs text-text-faint">
          {baseNote(
            suggestedBase(checkout.suggested, info)?.from ?? null,
            checkout.checkout.remote,
            validated,
            info.phase === "failed" ? info.failure : null,
          )}
        </p>
        {busy === "preparing" && <CancelNote />}
      </form>
      {failure !== null && <FailureLine failure={failure} />}
      {prepared !== null && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <GitPullRequest aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-muted" />
            <span className="min-w-0 break-words">
              {worktreeSentence(prepared.result.change)}{" "}
              <span className="text-text-muted">{prepared.result.worktree}</span>, at{" "}
              <span className="font-mono text-[13px]">{prepared.result.head.slice(0, 12)}</span>.
            </span>
          </p>
          {/* Ligatures off for the reason the Settings field gives (`TextControl`). */}
          <p className="font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-foreground [font-variant-ligatures:none] select-text">
            {prepared.prompt}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => copy(prepared.prompt)}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? "Copied" : "Copy prompt"}
            </Button>
            {onClipboard && (
              <span className="text-xs text-text-muted">
                On your clipboard — paste it into your agent. The template is in Settings.
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Where the prefilled base came from, said plainly — unless GitHub said, it is the one guess
 * in the dialog — and the name the prompt will give it: the remote-tracking branch the fetch
 * refreshes. When GitHub was asked and did not answer, the guess says why it is a guess. */
function baseNote(
  from: BaseSuggestion["from"] | null,
  remote: string,
  base: string | null,
  unanswered: GitHubFailure | null,
): string {
  const compared =
    base === null
      ? ""
      : ` Fetched with the pull request; your agent compares against ${remote}/${base}.`;
  const why =
    unanswered === null ? "" : ` (Not from GitHub: ${githubUncheckedReason(unanswered)}.)`;
  switch (from) {
    case "api":
      return `The branch the pull request targets, from GitHub.${compared}`;
    case "remoteHead":
      return `${remote}'s default branch.${why}${compared}`;
    case "localDefault":
      return `This checkout's default branch — check it is the one the pull request targets.${why}${compared}`;
    case null:
      return `The branch the pull request targets.${compared}`;
  }
}

/** GitHub's word for a pull request's state, the way its own page labels it. A closed or merged
 * pull request is still reviewable; this only says which it is. */
function stateLabel(info: GitHubPullRequestInfo): string {
  switch (info.state) {
    case "open":
      return info.draft ? "Draft" : "Open";
    case "closed":
      return "Closed";
    case "merged":
      return "Merged";
  }
}

/** The pull request's title and state, as GitHub has them — so the reader sees they pasted the
 * one they meant before anything is fetched. */
function PullRequestSummary({ info }: { info: GitHubPullRequestInfo }): ReactElement {
  return (
    <p className="flex items-baseline gap-2 text-sm text-foreground">
      <span className="min-w-0 break-words">{info.title}</span>
      <span className="shrink-0 text-xs text-text-muted">{stateLabel(info)}</span>
    </p>
  );
}

function worktreeSentence(change: WorktreeChange): string {
  switch (change) {
    case "created":
      return "Worktree made at";
    case "moved":
      return "Worktree moved to the pull request's new head at";
    case "current":
      return "Worktree already up to date at";
  }
}

/** Stops the fetch or clone in flight (main lets git clean up, then stops it). A checkout
 * already under way is let finish — a half-made worktree is worse than a late one — so once
 * pressed the button says it is cancelling and the line under the form says why it may take a
 * moment (`CancelNote`). */
function CancelButton(): ReactElement {
  const cancel = usePullRequestStore((state) => state.cancel);
  const cancelling = usePullRequestStore((state) => state.cancelling);
  return (
    <Button
      variant="ghost"
      className="shrink-0"
      disabled={cancelling}
      onClick={() => void cancel()}
    >
      {cancelling ? "Cancelling…" : "Cancel"}
    </Button>
  );
}

function CancelNote(): ReactElement | null {
  const cancelling = usePullRequestStore((state) => state.cancelling);
  return cancelling ? (
    <p className="text-xs text-text-muted">
      Stopping. If the worktree is already being checked out, that finishes first, so it is never
      left half-made.
    </p>
  ) : null;
}

/** A failure under the control it is about — a cancel quietly, as the reader's own act rather
 * than an error. */
function FailureLine({ failure }: { failure: PullRequestFailure }): ReactElement {
  return failure.code === "cancelled" ? (
    <p className="text-sm text-text-muted">{pullRequestFailureMessage(failure)}</p>
  ) : (
    <Problem>{pullRequestFailureMessage(failure)}</Problem>
  );
}

/** The open pull requests on GitHub that request the reader's review (B5), each a row that fills
 * the address and looks it up the way a paste does. Asked when the dialog opens with a username
 * set (unless the list is under a minute old) and on Refresh; never on a timer. Without a
 * username it is one line pointing at Settings, not an empty list — an empty list would claim
 * nothing is waiting. */
function InboxSection(): ReactElement {
  const login = useSettingsStore((state) => githubLogin(state.resolved));
  const inbox = usePullRequestStore((state) => state.inbox);
  const refreshInbox = usePullRequestStore((state) => state.refreshInbox);
  const busy = usePullRequestStore((state) => state.busy);
  const setInput = usePullRequestStore((state) => state.setInput);
  const locate = usePullRequestStore((state) => state.locate);
  const now = useCoarseNow();

  // Once per opening (the dialog's content mounts with it), and again if the username changes
  // while it is up; the store skips a list that is fresh.
  useEffect(() => {
    if (login !== null) {
      void refreshInbox(login);
    }
  }, [login, refreshInbox]);

  if (login === null) {
    return (
      <section className="flex flex-col gap-2">
        <SectionTitle>Waiting on your review</SectionTitle>
        <p className="text-sm text-text-muted">
          Add your GitHub username in Settings ▸ GitHub (⌘,) to list the pull requests that request
          your review.
        </p>
      </section>
    );
  }

  const current = inbox.phase === "idle" || inbox.login !== login ? null : inbox;
  const rows = current?.rows ?? null;
  const loading = current === null || current.phase === "loading";
  const pick = (pr: PullRequest): void => {
    setInput(pullRequestUrl(pr));
    void locate(pr);
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionTitle>Waiting on your review</SectionTitle>
        <TooltipHint content={`Ask GitHub again for ${login}'s review requests`} side="top">
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto text-text-muted"
            aria-label="Refresh the review requests"
            disabled={loading}
            onClick={() => void refreshInbox(login, { force: true })}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </TooltipHint>
      </div>
      {current?.phase === "failed" && (
        // Quiet rather than an alert: the list is an extra, and pasting still works.
        <p className="text-sm text-text-muted">{inboxFailureMessage(current.failure, login)}</p>
      )}
      {rows === null ? (
        loading && <p className="text-sm text-text-muted">Asking GitHub…</p>
      ) : rows.items.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing is waiting on {login}&apos;s review.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {rows.items.map((item) => (
            <InboxRow
              key={pullRequestLabel(item.pullRequest)}
              item={item}
              now={now}
              disabled={busy !== null}
              onPick={() => pick(item.pullRequest)}
            />
          ))}
        </ul>
      )}
      {/* Counted against GitHub's total, not the rows drawn: a row the app could not act on is
          dropped (`main/github/rest.ts`), so "N of M" would misstate one of the two. */}
      {rows !== null && rows.total > rows.items.length && (
        <p className="text-xs text-text-faint">
          GitHub found {rows.total}; these are the most recently updated.
        </p>
      )}
      {rows?.incomplete === true && (
        <p className="text-xs text-text-faint">
          GitHub&apos;s search ran out of time, so this list may be missing some.
        </p>
      )}
      <p className="text-xs text-text-faint">
        Public repositories only: GitHub is asked without a sign-in, so it leaves out private ones.
        Paste those above.
      </p>
    </section>
  );
}

/** One pull request waiting on the reader: where it is, what it is called, who opened it and
 * when it last moved. The whole row is the button. */
function InboxRow({
  item,
  now,
  disabled,
  onPick,
}: {
  item: GitHubInboxItem;
  now: Date;
  disabled: boolean;
  onPick: () => void;
}): ReactElement {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onPick}
        className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{item.title}</span>
          <span className="block truncate text-xs text-text-muted">
            {pullRequestLabel(item.pullRequest)}
            {item.author !== null && ` · ${item.author}`}
            {item.draft && " · draft"}
          </span>
        </span>
        <span
          className="shrink-0 text-xs text-text-faint tabular-nums"
          title={absoluteTime(item.updatedAt)}
        >
          {shortAge(item.updatedAt, now)}
        </span>
      </button>
    </li>
  );
}

/** Every worktree made so far, each with its Remove. */
function WorktreesSection(): ReactElement {
  const worktrees = usePullRequestStore((state) => state.worktrees);
  const removing = usePullRequestStore((state) => state.removing);
  const removeFailure = usePullRequestStore((state) => state.removeFailure);
  const removeWorktree = usePullRequestStore((state) => state.removeWorktree);
  const confirmingRemoval = usePullRequestStore((state) => state.confirmingRemoval);
  const askRemove = usePullRequestStore((state) => state.askRemove);
  const cancelRemove = usePullRequestStore((state) => state.cancelRemove);

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>Worktrees</SectionTitle>
      {worktrees.phase !== "idle" && worktrees.rows.length === 0 ? (
        <p className="text-sm text-text-muted">
          {worktrees.phase === "loading"
            ? "Reading…"
            : "None yet. Each pull request fetched here gets one, kept until you remove it."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {worktrees.rows.map((row) => (
            <WorktreeRow
              key={row.path}
              row={row}
              removing={removing === row.path}
              disabled={removing !== null}
              failure={
                removeFailure?.path === row.path
                  ? pullRequestFailureMessage(removeFailure.failure)
                  : null
              }
              confirming={confirmingRemoval === row.path}
              onAsk={() => askRemove(row.path)}
              onConfirm={() => void removeWorktree(row.path)}
              onKeep={cancelRemove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** What a row says about its worktree when that is anything but "clean, detached, ours". */
function worktreeState(row: PullRequestWorktree): string | null {
  if (row.checkout === null) {
    return "git does not list this as a worktree of its repository — delete the folder by hand if it is not needed";
  }
  if (row.locked !== null) {
    return `locked by git${row.locked === "" ? "" : ` (${row.locked})`} — a checkout that may not have finished; left alone`;
  }
  switch (row.changes) {
    case "uncommitted":
      return "has uncommitted changes — kept until they are dealt with";
    case "commits":
      return "has commits not on any branch — kept until they are on one";
    case "none":
      return row.branch === null ? null : `switched to the branch ${row.branch}`;
  }
}

/** One worktree. Remove is offered on one that holds nothing only — a worktree with changes or
 * stray commits holds work that is somebody's, and the row says why the button is not there
 * rather than letting main refuse it. Remove asks first, in place: it deletes the directory,
 * and with it the ignored files nothing else counts (a build, an installed `node_modules`). */
function WorktreeRow({
  row,
  removing,
  disabled,
  failure,
  confirming,
  onAsk,
  onConfirm,
  onKeep,
}: {
  row: PullRequestWorktree;
  removing: boolean;
  disabled: boolean;
  failure: string | null;
  confirming: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onKeep: () => void;
}): ReactElement {
  const state = worktreeState(row);
  const removable = row.checkout !== null && row.changes === "none" && row.locked === null;
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{pullRequestLabel(row.pullRequest)}</p>
          <p className="truncate text-xs text-text-muted" title={row.path}>
            {row.path}
          </p>
          {state !== null && <p className="text-xs text-text-faint">{state}</p>}
        </div>
        {removable && !confirming && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-text-muted hover:text-destructive"
            disabled={disabled}
            onClick={onAsk}
          >
            {removing && <Spinner />}
            Remove
          </Button>
        )}
      </div>
      {removable && confirming && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/5 px-2 py-1.5">
          <p className="min-w-0 flex-1 text-xs text-foreground">
            Delete this worktree&apos;s folder? Its ignored files go with it — build output, an
            installed node_modules. The pull request&apos;s commits stay in your repository.
          </p>
          <Button variant="destructive" size="xs" onClick={onConfirm}>
            Remove
          </Button>
          <Button variant="ghost" size="xs" onClick={onKeep}>
            Keep
          </Button>
        </div>
      )}
      {failure !== null && <Problem>{failure}</Problem>}
    </li>
  );
}
