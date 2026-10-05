import { useMemo, type ReactElement } from "react";
import { ExternalLink, Send } from "lucide-react";
import { countLabel } from "../../../shared/plural";
import { pullRequestLabel } from "../../../shared/pull-request";
import { NO_RESOLUTIONS } from "../../../shared/comment-resolution";
import type { Comment } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipHint } from "@/components/ui/tooltip";
import { RailFoot } from "@/components/rail";
import { githubFilesPageUrl } from "@/lib/github-links";
import { githubPostFailureMessage } from "@/lib/github-failure-message";
import { pendingCount, postAllBatch, tokenCovers, unverifiedReason } from "@/lib/github-posting";
import { selectActiveSlice, useReviewStore } from "@/stores/review";
import { useGitHubStore } from "@/stores/github";

// The review-level half of posting comments to a pull request (Layer C): "Post all (N)",
// "Open on GitHub" once something is pending, and the question a moved pull request raises. The
// per-card half — Post, the state — is `CommentPostable`'s. Which comments Post all sends is
// `postAllBatch`'s rule: every one that can go, less those marked skipped or disagree.
//
// **Why the foot of the Comments section.** `rail.tsx` already has the vocabulary: a `RailFoot` is
// "the line under a list: how far through it you are, how to select more of it", and an action
// over that very list is exactly that. The section bar's `action` slot was the
// other candidate and is already the agent-bound action (Copy all as prompt): two actions bound
// for two different readers — the agent and the PR's author — side by side on one 36px bar would
// read as one kind of thing. A floating control over the diff (the doc-return pill's place) was
// the third, and is wrong for a reason of its own: the batch spans the whole review, and a pill
// would claim the bottom of the pane the comment stepper already shares. So the foot, drawn under
// the list whether the list is open or folded — the reader marks cards in the diff, often with
// the list folded, and the count has to be where they will look for it — and only while there is
// something to say: comments to post, a pending draft, a post on its way or a failure.
//
// **What the foot says.** The pull request by name (`owner/repo#n`) in its tooltips, so the
// reader knows where the batch goes; a failure that stopped a post, or stopped it partway ("before
// the rest"); and, quietly, when the states on the cards were not checked against GitHub just now
// — they are the record's last word then, not GitHub's.
//
// **"Open on GitHub" goes to the pull request's Files tab**, where GitHub's own Submit review is.
// Through `window.open`, which main hands to `external-links.ts` — https only, the one way any
// link leaves the app — so this adds no new path out.
//
// **The head-moved question is a dialog**, not a line in the foot: Post on a card can raise it
// with the rail put away (⌘B), and it is the one moment the app asks before posting.

const EMPTY_COMMENTS: Comment[] = [];

/** The foot under the Comments section — or nothing, when there is nothing to post or open. */
export function PostAllFoot(): ReactElement | null {
  const pr = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin?.pr ?? null);
  const covered = useGitHubStore((state) => tokenCovers(state.status, pr));
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const posting = useReviewStore((state) => selectActiveSlice(state)?.posting ?? null);
  const check = useReviewStore((state) => selectActiveSlice(state)?.githubCheck ?? null);
  const marks = useReviewStore(
    (state) => selectActiveSlice(state)?.resolvedComments ?? NO_RESOLUTIONS,
  );
  const postComments = useReviewStore((state) => state.postComments);
  const batch = useMemo(
    () => (posting === null ? [] : postAllBatch(comments, posting, check, marks)),
    [comments, posting, check, marks],
  );

  if (pr === null || posting === null) {
    return null;
  }
  const pending = pendingCount(posting);
  const unverified = unverifiedReason(posting);
  const showPost = covered && batch.length > 0;
  if (
    !showPost &&
    pending === 0 &&
    !posting.busy &&
    posting.failure === null &&
    unverified === null
  ) {
    return null;
  }
  const where = pullRequestLabel(pr);
  return (
    // The sentence, when there is one, takes a line of its own above the two buttons: at the
    // rail's width a sentence beside them would leave each a word wide.
    <RailFoot className="flex-wrap">
      {posting.busy ? (
        <span className="w-full">Posting to {where}…</span>
      ) : (
        posting.failure !== null && (
          <span className="w-full text-warning">
            {posting.stoppedPartway ? "Stopped before the rest: " : ""}
            {githubPostFailureMessage(posting.failure)}
          </span>
        )
      )}
      {/* The states on the cards are the record's last word when GitHub could not be asked
          just now — said here, quietly, so they are not read as fact. */}
      {!posting.busy && unverified !== null && (
        <span className="w-full text-text-faint">
          Not checked against GitHub just now: {githubPostFailureMessage(unverified)}
        </span>
      )}
      {showPost && (
        <TooltipHint
          content={`Post every comment not marked skipped or disagree to ${where} as pending drafts. Only you see them until you submit the review on GitHub.`}
          side="top"
          align="end"
        >
          <Button
            variant="chrome"
            size="xs"
            disabled={posting.busy}
            onClick={() => void postComments(batch.map((comment) => comment.id))}
          >
            <Send />
            Post all ({batch.length})
          </Button>
        </TooltipHint>
      )}
      {pending > 0 && (
        <TooltipHint
          content={`${countLabel(pending, "comment")} pending on ${where}. Your pending review waits on the pull request's Files tab for you to submit it there.`}
          side="top"
          align="end"
        >
          <Button
            variant="chrome"
            size="xs"
            onClick={() => window.open(githubFilesPageUrl(pr), "_blank", "noopener")}
          >
            <ExternalLink />
            Open on GitHub
          </Button>
        </TooltipHint>
      )}
    </RailFoot>
  );
}

/** "The pull request has moved — post anyway?", for the session on screen. */
export function HeadMovedDialog(): ReactElement {
  const question = useReviewStore((state) => selectActiveSlice(state)?.posting.headMoved ?? null);
  const reviewedHead = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewOrigin?.reviewedHead ?? null,
  );
  const pr = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin?.pr ?? null);
  const confirmHeadMoved = useReviewStore((state) => state.confirmHeadMoved);
  const dismissHeadMoved = useReviewStore((state) => state.dismissHeadMoved);
  const count = question?.ids.length ?? 0;

  return (
    <Dialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) {
          dismissHeadMoved();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {pr === null ? "The pull request" : pullRequestLabel(pr)} has moved on
          </DialogTitle>
          <DialogDescription>
            Posting {countLabel(count, "comment")} to it. GitHub&apos;s head is now{" "}
            <code className="font-mono">{question?.head.slice(0, 7) ?? ""}</code>, past the commit
            this review read
            {reviewedHead === null ? "" : " "}
            {reviewedHead !== null && <code className="font-mono">{reviewedHead.slice(0, 7)}</code>}
            . {count === 1 ? "The comment is" : "The comments are"} pinned to the reviewed commit,
            so GitHub will show {count === 1 ? "it" : "them"} as outdated — the lines may have
            changed since.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => dismissHeadMoved()}>
            Don&apos;t post
          </Button>
          <Button onClick={() => void confirmHeadMoved()}>
            {count === 1 ? "Post anyway" : `Post ${count} anyway`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
