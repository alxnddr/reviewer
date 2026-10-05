import { type ReactElement, type ReactNode } from "react";
import { Check, Copy, ExternalLink, MessageSquareShare, Pencil, Send, Trash2 } from "lucide-react";
import type { Comment } from "../../../shared/review";
import {
  hasPostable,
  postableComment,
  postableReferencesFor,
  type PostableOptions,
} from "../../../shared/postable-comment";
import type { PatchFile } from "../../../shared/diff/patch";
import { pullRequestLabel } from "../../../shared/pull-request";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { CommentEditor } from "@/components/CommentEditor";
import { Markdown } from "@/components/Markdown";
import { useCopyFeedback } from "@/lib/copy-feedback";
import { githubPostFailureMessage } from "@/lib/github-failure-message";
import {
  cardNote,
  cardNoteText,
  editedSincePosted,
  postable,
  postedStateOf,
  tokenCovers,
  unverifiedReason,
} from "@/lib/github-posting";
import {
  OPEN_ON_GITHUB_LABEL,
  OUTSIDE_GITHUB_DIFF_HINT,
  OUTSIDE_GITHUB_DIFF_NOTE,
  githubDiffPath,
  githubFilesPageUrl,
  githubCheckNote,
  githubFilesUrl,
  githubHeadOf,
  openOnGitHubHint,
  outsideGitHubDiff,
  prHeadDrift,
  reviewedFilesFor,
  sha256Hex,
} from "@/lib/github-links";
import { reviewDrift } from "@/lib/review-drift";
import { headShaOf } from "@/lib/session-projection";
import { cn } from "@/lib/utils";
import { selectActiveSlice, useReviewStore } from "@/stores/review";
import { useGitHubStore } from "@/stores/github";
import { useSettingsStore } from "@/stores/settings";

// The comment as it would be posted to the change's author, under the finding it came from.
// A card has two readers when the change is someone else's: the reader of the review, who
// wants the finding and the receipts, and the author, who wants a courteous comment they can
// act on. `body` is the first; this is the second (`ReviewComment`'s header has the split).
//
// **The agent's output, or nothing.** A postable is written by the agent during the review,
// while it still has the context — and in whatever voice the reader's own writing guide asks
// for, which the skill tells it to follow. The app never invents one: there is no "write one"
// affordance and nothing seeded from `body`, because a reader drafting author-facing prose
// from the briefing is exactly the rewrite the field exists to avoid, and a body that slipped
// out as a postable would put the agent's voice in front of the author. A comment without one
// (absent, or blank — `hasPostable`) is simply not for posting, and this block draws nothing
// at all for it: on a review of the reader's own branch, which is most of them, a card reads
// exactly as it did before the field existed.
//
// **Visible, never folded.** Evidence folds because it is the receipts a doubtful reader goes
// looking for. This is the opposite: deciding whether to post a finding means reading exactly
// what would be posted, card by card, so it is on the card.
//
// **Its own section of the card** (`CommentThread`): under a full-width divider, with a header
// row — the "For the author" label on the left, this text's actions on the right — and the text
// under it. A section and not an inset inside the finding's padding, so the buttons in its
// header are plainly about this text and the toolbar over the card is plainly about the finding.
//
// **A sibling of `CommentBody`, never part of it** — the rule `CommentEvidence` follows, for
// the same reason: the rail's one-line preview flattens `body` alone, and the author's text
// must never become the preview of the reader's finding.
//
// **Its actions sit in its own header row, not in the card's hover toolbar.** They act on this
// text, not on the finding the toolbar's glyphs are about, so putting them beside this
// section's label is what says which text Copy copies and which Edit edits.
//
// **Refined in place, because the reader is signing it.** An existing postable can be edited
// before it leaves: the editor opens inside this block, under the finding, so the claim stays
// in view while the wording is adjusted. Saving it empty removes it — the reader deciding this
// finding is not to be posted — and the button says "Remove" while it would; with the text
// gone the block goes with it, and nothing brings it back but a re-emitted review. The open
// editor is the diff surface's state (`DiffCommentSlots`), not this component's, so the "one
// editor on screen at a time" rule holds for this one too.
//
// **A review that knows its pull request adds "Copy & open on GitHub"** beside Copy: the same
// text on the clipboard, then the pull request's Files view opened at the comment's lines in
// the reader's browser, where they click `+`, paste, and start a pending review themselves
// (`lib/github-links.ts` has the anchor, how much of it is verified, and its limits). Both
// buttons copy the same text — file references as links at the reviewed commit once the
// review names its PR, inline whenever the loaded diff cannot vouch for being the reviewed one
// (`postableNow`) — because the text is bound for the same place whichever one put it on the
// clipboard.
//
// **A comment GitHub's own diff leaves out says so, beside the button** (B4): "Not in GitHub's
// diff", in the label row's faint ink, with what it means in its tooltip. A note and not a
// disabled button, because the link still opens the right file and the newer Files page lets a
// person comment on any line of a changed file by hand; what it warns about is the classic page
// and the API, which take a line comment only inside the diff's hunks. Known only for a review
// GitHub was asked about and answered at the reviewed commit (`outsideGitHubDiff`); otherwise the
// block reads as it always did.
//
// **Posting it as a pending comment (Layer C)** sits in the same row, and only where it can
// happen: a review that names its pull request, and a token in Settings that covers the pull
// request's owner. One control, Post, labelled in words because it is the one action here that
// reaches another person; the rail's Post all (`GitHubPosting.tsx`) is the other way out. Without
// a token, Copy and Copy & open on GitHub are how the text gets there, by the reader's hand. Post
// is not drawn for a comment GitHub's diff leaves out — the note above already says why — nor
// once it is on GitHub, where the row says so instead: "Pending on GitHub", with
// a way to take the draft back off, or "Submitted on GitHub", with nothing to offer. A pending
// comment whose text was edited after it went says "Edited since posted" instead — GitHub still
// has the old words — and its tooltip says how to send the new ones (remove, post again). Every
// tooltip names the pull request it is about. A state not checked against GitHub just now says
// so in its tooltip. A post that failed for this comment — or a batch that stopped before it —
// says "Not posted" in the row, quietly, with the reason in its tooltip
// (`lib/github-posting.ts`'s `cardNoteText`); a line outside GitHub's diff is said once, by the
// B4 note when it is there. Post is not drawn for a review opened before per-review records
// existed (no `reviewPath`), which could not post. Every one of these reads the store, for the
// reason below.
//
// **What the PR buttons know, they read from the store, not from props.** This block renders
// inside a CodeView portal that re-renders only when its slot's `version` changes, so a value
// threaded down as a prop is a value frozen at the last fingerprint. Folding the pull request,
// the reviewed head and the drift into the slot would bump every card's version on every log
// re-walk to keep a tooltip current. The diff surface's other leaf controls already answer
// this the same way (`CopyPromptButton.tsx`, `FileReadToggle`): subscribe to the active
// session for what is drawn, and read the rest — the diff's files, the evidence setting — at
// the click.

type CommentPostableProps = {
  comment: Comment;
  editing: boolean;
  onEdit: () => void;
  onSave: (postable: string) => void;
  onCancel: () => void;
};

/** The postable block or its editor — or nothing, for a comment the agent wrote no postable
 * for. */
export function CommentPostable({
  comment,
  editing,
  onEdit,
  onSave,
  onCancel,
}: CommentPostableProps): ReactElement | null {
  // Checked before `editing`, so even a stale open-editor state cannot conjure an editor for a
  // comment that has nothing to refine.
  if (!hasPostable(comment)) {
    return null;
  }

  if (editing) {
    return (
      <PostableFrame editing>
        <div className={HEADER_CLASS}>
          <PostableLabel />
        </div>
        <div className="px-4 pb-3">
          <CommentEditor
            field="postable"
            initialText={comment.postable}
            saveLabel="Save"
            onSave={onSave}
            onCancel={onCancel}
          />
        </div>
      </PostableFrame>
    );
  }

  return (
    <PostableFrame editing={false}>
      <div className={HEADER_CLASS}>
        <PostableLabel />
        {/* A row rather than one button: Copy is the first way this text leaves the app, and
            a review that knows its pull request adds the one that opens it there beside it. */}
        <span className="ml-auto flex items-center gap-0.5">
          <OutsideGitHubDiffNote commentId={comment.id} />
          <PostControls comment={comment} />
          <CopyPostableButton comment={comment} />
          <OpenOnGitHubButton comment={comment} />
          <TooltipHint content="Edit for the author" side="top" align="end">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Edit the comment for the author"
              className={ACTION_CLASS}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
          </TooltipHint>
        </span>
      </div>
      <Markdown
        text={comment.postable}
        // A step down from the finding, like the evidence, but at full ink: this is text the
        // reader has to read in full before they send it, not supporting material.
        className="space-y-2 px-4 pb-3 text-sm break-words text-foreground select-text"
      />
    </PostableFrame>
  );
}

/** The ink and hover the card's hover toolbar gives its glyphs, so the two rows of actions on
 * one card read as one vocabulary. */
const ACTION_CLASS =
  "text-text-muted hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10";

/** The section's header row: the label left, the actions right, one row high whatever it
 * holds, so the text under it starts at the same place in both states. */
const HEADER_CLASS = "flex h-9 items-center gap-1.5 px-4";

/** The section, in both of its states. While editing, its left edge takes the focus colour —
 * the editor is drawn bare (`CommentEditor`'s `editorFace`) and this is the edge that says
 * where the caret is. An inset shadow rather than a border, so the text does not move. */
function PostableFrame({
  editing,
  children,
}: {
  editing: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col transition-shadow",
        editing && "focus-within:shadow-[inset_2px_0_0_var(--ring)]",
      )}
    >
      {children}
    </div>
  );
}

function PostableLabel(): ReactElement {
  return (
    <span className="flex items-center gap-1.5 text-xs text-text-muted">
      <MessageSquareShare aria-hidden="true" className="size-3.5" />
      For the author
    </span>
  );
}

/** How the text leaves the app right now, and the diff that decided it: the evidence setting,
 * and the references the active review calls for — links into its pull request at the reviewed
 * commit, or inline (`postableReferencesFor`). The files are the *reviewed* diff's, or null
 * when the loaded diff cannot vouch for being it (`reviewedFilesFor`: a narrowed review, or a
 * branch that moved past `reviewedHead`), never simply what is on screen. Read at the click
 * rather than rendered, so a change in Settings or a re-derived diff applies to the next copy
 * without repainting a card. */
function postableNow(): { options: PostableOptions; reviewedFiles: readonly PatchFile[] | null } {
  const slice = selectActiveSlice(useReviewStore.getState());
  const origin = slice?.reviewOrigin ?? null;
  const reviewedHead = origin?.reviewedHead ?? null;
  const reviewedFiles =
    slice === null
      ? null
      : reviewedFilesFor({
          reviewDiff: slice.reviewDiff,
          reviewSubrange: slice.reviewSubrange,
          reviewedHead,
          currentHead: headShaOf(slice.log),
          files: slice.diff.phase === "loaded" ? slice.diff.files : null,
        });
  return {
    options: {
      includeEvidence: useSettingsStore.getState().resolved.postableIncludesEvidence,
      references: postableReferencesFor(origin?.pr ?? null, reviewedHead, reviewedFiles),
    },
    reviewedFiles,
  };
}

/** "Not in GitHub's diff", for a comment GitHub's diff at the reviewed commit leaves out — or
 * nothing. Subscribes to one boolean, so a check landing repaints only the cards it is about. */
function OutsideGitHubDiffNote({ commentId }: { commentId: string }): ReactElement | null {
  const outside = useReviewStore((state) =>
    outsideGitHubDiff(selectActiveSlice(state)?.githubCheck ?? null, commentId),
  );
  if (!outside) {
    return null;
  }
  return (
    <TooltipHint content={OUTSIDE_GITHUB_DIFF_HINT} side="top" align="end">
      <span tabIndex={0} className="mr-1 cursor-default text-xs text-text-faint">
        {OUTSIDE_GITHUB_DIFF_NOTE}
      </span>
    </TooltipHint>
  );
}

/** The postable text on the clipboard, exactly as it would be posted: references rewritten
 * into the form `postableNow` chose, evidence folded in only if the reader chose that in
 * Settings. The check is the same flash every copy in the app answers with
 * (`lib/copy-feedback.ts`); a refused write shows nothing. */
function CopyPostableButton({ comment }: { comment: Comment }): ReactElement {
  const { copied, confirm } = useCopyFeedback();

  const copy = (): void => {
    const text = postableComment(comment, postableNow().options);
    if (text === null) {
      return;
    }
    navigator.clipboard.writeText(text).then(
      confirm,
      // A refused clipboard only costs the check glyph; the text is on the card to select.
      () => {},
    );
  };

  return (
    <TooltipHint content={copied ? "Copied" : "Copy for the author"} side="top" align="end">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "Copied for the author" : "Copy for the author"}
        className={ACTION_CLASS}
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </TooltipHint>
  );
}

/** Copy, then open the pull request's Files view at this comment's lines — drawn only for a
 * review that names its pull request.
 *
 * The page opens only once the text is on the clipboard: landing on GitHub with nothing to
 * paste would be the one outcome worse than doing nothing, and a refused write already shows
 * nothing, like every copy here. It opens through `window.open`, which main never lets create a
 * window: `setWindowOpenHandler` (`main/window.ts`) hands the URL to `external-links.ts`, whose
 * https-only check is the one path any link takes out of this app — so this button adds no new
 * way to reach the OS, and nothing about that check was widened for it.
 *
 * The tooltip warns when the pull request is known to have moved past the reviewed commit
 * (`prHeadDrift`), because the line it opens at may no longer be the line the comment is about.
 * GitHub's own head, when the session's check got an answer (`githubCheck`), is the first
 * witness; when GitHub could not be asked, or a re-check failed, the tooltip says so in one quiet
 * sentence.
 * The pull request's own head is the sha of its ref (`pullRequestRef`, `refs/rvw/pr/<owner>/<repo>/<n>`) as Review Pull Request… last
 * fetched it, which the session reads from the review's repository (`prHead`, re-read after
 * every such fetch); until something has fetched it, it is null and the branch the review
 * follows answers instead. */
function OpenOnGitHubButton({ comment }: { comment: Comment }): ReactElement | null {
  const { copied, confirm } = useCopyFeedback();
  const pr = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin?.pr ?? null);
  // The drift line's inputs, each read on its own (the `OverviewScreen` idiom) so the button
  // re-renders for a moved branch or a re-fetched pull request and for nothing else.
  const reviewedHead = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewOrigin?.reviewedHead ?? null,
  );
  const reviewDiff = useReviewStore((state) => selectActiveSlice(state)?.reviewDiff ?? null);
  const log = useReviewStore((state) => selectActiveSlice(state)?.log ?? null);
  const prHead = useReviewStore((state) => selectActiveSlice(state)?.prHead ?? null);
  const githubCheck = useReviewStore((state) => selectActiveSlice(state)?.githubCheck ?? null);

  if (pr === null) {
    return null;
  }
  const drift = prHeadDrift({
    reviewedHead,
    githubHead: githubHeadOf(githubCheck),
    prHead,
    branchDrift: reviewDrift({ reviewedHead, reviewDiff, log }),
  });
  const hint = openOnGitHubHint(drift, githubCheckNote(githubCheck));

  const open = (): void => {
    const { options, reviewedFiles } = postableNow();
    const text = postableComment(comment, options);
    if (text === null) {
      return;
    }
    const lines = { side: comment.side, startLine: comment.startLine, endLine: comment.endLine };
    navigator.clipboard.writeText(text).then(
      () => {
        // The copy counted whatever happens next: the text is on the clipboard.
        confirm();
        sha256Hex(githubDiffPath(comment.file, reviewedFiles)).then(
          (digest) => window.open(githubFilesUrl(pr, digest, lines), "_blank", "noopener"),
          // No digest, no line to land on — but still the right page: the Files view itself,
          // where the reader finds the file by hand. Quieter than an error for a step that
          // cannot really fail (WebCrypto is always present in the app's secure context).
          () => window.open(githubFilesPageUrl(pr), "_blank", "noopener"),
        );
      },
      // A refused clipboard opens nothing: see above.
      () => {},
    );
  };

  return (
    <TooltipHint content={copied ? "Copied — opening GitHub" : hint} side="top" align="end">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "Copied for the author, opening GitHub" : OPEN_ON_GITHUB_LABEL}
        className={ACTION_CLASS}
        onClick={open}
      >
        {copied ? <Check /> : <ExternalLink />}
      </Button>
    </TooltipHint>
  );
}

/** The posting controls for one card, or its state on GitHub — see the header. */
function PostControls({ comment }: { comment: Comment }): ReactElement | null {
  const pr = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin?.pr ?? null);
  // A review opened before per-review records existed cannot post (`noRecord`); no Post for it.
  const recorded = useReviewStore((state) => selectActiveSlice(state)?.reviewPath != null);
  const covered = useGitHubStore((state) => tokenCovers(state.status, pr));
  const posted = useReviewStore((state) => {
    const slice = selectActiveSlice(state);
    return slice === null ? null : postedStateOf(slice.posting, comment.id);
  });
  const edited = useReviewStore((state) => {
    const slice = selectActiveSlice(state);
    return slice !== null && editedSincePosted(slice.posting, comment);
  });
  const unverified = useReviewStore((state) => {
    const slice = selectActiveSlice(state);
    return slice === null ? null : unverifiedReason(slice.posting);
  });
  const offered = useReviewStore((state) => {
    const slice = selectActiveSlice(state);
    return slice !== null && postable(comment, slice.posting, slice.githubCheck);
  });
  const outside = useReviewStore((state) =>
    outsideGitHubDiff(selectActiveSlice(state)?.githubCheck ?? null, comment.id),
  );
  const busy = useReviewStore((state) => selectActiveSlice(state)?.posting.busy ?? false);
  const note = useReviewStore((state) => {
    const slice = selectActiveSlice(state);
    return slice === null ? null : cardNote(slice.posting, comment.id);
  });
  const postComments = useReviewStore((state) => state.postComments);
  const removePendingComment = useReviewStore((state) => state.removePendingComment);

  if (pr === null) {
    return null;
  }
  const where = pullRequestLabel(pr);
  /** Said after a state's own sentence when the state was not checked against GitHub just now. */
  const stale =
    unverified === null
      ? ""
      : ` Not checked against GitHub just now: ${githubPostFailureMessage(unverified)}`;
  const noteText = cardNoteText(note, outside);
  const noteView =
    noteText === null ? null : (
      <TooltipHint content={noteText.hint} side="top" align="end">
        <span tabIndex={0} className="mr-1 cursor-default text-xs text-warning">
          {noteText.label}
        </span>
      </TooltipHint>
    );

  switch (posted) {
    case "submitted":
      return (
        <TooltipHint
          content={`It went out with a review you submitted on ${where}.${stale}`}
          side="top"
          align="end"
        >
          <span tabIndex={0} className="mr-1 cursor-default text-xs text-text-faint">
            Submitted on GitHub
          </span>
        </TooltipHint>
      );
    case "pending":
      return (
        <>
          {noteView}
          <TooltipHint
            content={
              edited
                ? `GitHub has the text from before your edit. Remove the draft and post again to send this text.${stale}`
                : `A draft in your pending review on ${where}: only you can see it until you submit the review on GitHub.${stale}`
            }
            side="top"
            align="end"
          >
            <span
              tabIndex={0}
              className={cn(
                "mr-1 cursor-default text-xs",
                edited ? "text-warning" : "text-text-muted",
              )}
            >
              {edited ? "Edited since posted" : "Pending on GitHub"}
            </span>
          </TooltipHint>
          {covered && (
            <TooltipHint content={`Remove the draft from ${where}`} side="top" align="end">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove the pending draft from GitHub"
                className={ACTION_CLASS}
                disabled={busy}
                onClick={() => void removePendingComment(comment.id)}
              >
                <Trash2 />
              </Button>
            </TooltipHint>
          )}
        </>
      );
    case null:
      break;
  }
  if (!covered || !offered || !recorded) {
    return noteView;
  }
  return (
    <>
      {noteView}
      <TooltipHint
        content={`Post to ${where} as a pending draft. Only you see it until you submit the review on GitHub.`}
        side="top"
        align="end"
      >
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Post to ${where} as a pending draft`}
          className={ACTION_CLASS}
          disabled={busy}
          onClick={() => void postComments([comment.id])}
        >
          <Send />
          Post
        </Button>
      </TooltipHint>
    </>
  );
}
