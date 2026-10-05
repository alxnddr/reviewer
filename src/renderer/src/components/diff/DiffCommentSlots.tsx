import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import type { CodeViewProps } from "@pierre/diffs/react";
import type { CommentProse, ReviewAnchor } from "../../../../shared/review";
import type {
  CommentDraft,
  CommentEditTarget,
  DiffSlot,
} from "../../../../shared/diff/comment-annotations";
import type { ReferenceSpan } from "../../../../shared/markdown";
import type { CommentResolution } from "../../../../shared/review-progress";
import { CommentEditor } from "@/components/CommentEditor";
import { CommentThread } from "@/components/CommentThread";
import { MovedBlockNote } from "@/components/diff/MovedBlockNote";

type AnnotationRenderer = NonNullable<CodeViewProps<DiffSlot>["renderAnnotation"]>;

/** The curation half of the diff surface — which comment is open for editing, the in-flight
 * new one — and what each annotation slot draws, which since moved-block notes is a little
 * more than curation: Pierre takes one `renderAnnotation` per view, so every slot kind the
 * items carry is drawn through this one callback. */
export type CommentSlots = {
  /** Folded into the items' annotations, so a version bump follows every visible
   * change — CodeView reuses an item record and only re-renders its slots when the
   * version changes. */
  editing: CommentEditTarget | null;
  draft: CommentDraft | null;
  /** Open a new-comment editor on an anchor — the gutter `+`'s one gesture. */
  openDraft: (fileId: string, anchor: ReviewAnchor) => void;
  renderAnnotation: AnnotationRenderer;
};

export type CommentSlotHandlers = {
  onAddComment: (anchor: ReviewAnchor, body: string) => void;
  onEditComment: (commentId: string, field: CommentProse, text: string) => void;
  onDiscardComment: (commentId: string) => void;
  onSetCommentResolution: (commentId: string, resolution: CommentResolution | null) => void;
  /** Go to a moved block's other end — the one handler here that is not curation. It is in
   * this hook because Pierre takes exactly one `renderAnnotation` for the whole view, so
   * every slot kind is drawn by this one callback; splitting the moved note into a hook of
   * its own would mean two render props the surface has no way to accept. */
  onFollowMove: (path: string, span: ReferenceSpan) => void;
};

/** Comment cards, their editors, and the two pieces of state that say which is which.
 * Kept together because they are one closed loop: the state decides what a slot draws,
 * and every slot's save or cancel is what clears it. The writes themselves belong to the
 * session's slice and are handed in. */
export function useCommentSlots({
  onAddComment,
  onEditComment,
  onDiscardComment,
  onSetCommentResolution,
  onFollowMove,
}: CommentSlotHandlers): CommentSlots {
  const [editing, setEditing] = useState<CommentEditTarget | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);

  // One editor is on-screen at a time: opening a draft closes any open edit, and
  // opening an edit closes any in-flight draft — the two-editor state is never
  // reachable from either direction. An edit names its field as well as its comment, so
  // the postable's editor is held to the same rule as the body's rather than living in a
  // card's local state, where a draft could open beside it.
  const openDraft = useCallback((fileId: string, anchor: ReviewAnchor) => {
    setEditing(null);
    setDraft({ fileId, anchor });
  }, []);
  const openEdit = useCallback((commentId: string, field: CommentProse) => {
    setDraft(null);
    setEditing({ commentId, field });
  }, []);

  const renderAnnotation = useCallback<AnnotationRenderer>(
    (annotation): ReactNode => {
      const slot = annotation.metadata;
      // Not a comment and not in the frame comments share: a provenance note is a caption on
      // the line above it, one row high, and it renders first when a comment sits on the
      // same line (`moved-annotations.ts` has the collision reasoning).
      if (slot.kind === "moved") {
        return <MovedBlockNote slot={slot} onFollow={onFollowMove} />;
      }
      if (slot.kind === "draft") {
        return (
          <CommentAnnotationFrame twoColumn={slot.twoColumn}>
            <CommentEditor
              field="body"
              initialText=""
              saveLabel="Comment"
              onSave={(body) => {
                onAddComment(slot.anchor, body);
                setDraft(null);
              }}
              onCancel={() => setDraft(null)}
            />
          </CommentAnnotationFrame>
        );
      }
      // The body's editor takes the card's place; the postable's opens inside the card,
      // under the finding it is being rewritten from (`CommentPostable`).
      if (slot.editing === "body") {
        return (
          <CommentAnnotationFrame twoColumn={slot.twoColumn}>
            <CommentEditor
              field="body"
              initialText={slot.comment.body}
              saveLabel="Save"
              onSave={(body) => {
                onEditComment(slot.comment.id, "body", body);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          </CommentAnnotationFrame>
        );
      }
      return (
        <CommentAnnotationFrame twoColumn={slot.twoColumn}>
          <CommentThread
            comment={slot.comment}
            outdated={slot.outdated}
            active={slot.active}
            resolution={slot.resolution}
            editingPostable={slot.editing === "postable"}
            onEdit={(field) => openEdit(slot.comment.id, field)}
            onSavePostable={(postable) => {
              onEditComment(slot.comment.id, "postable", postable);
              setEditing(null);
            }}
            onCancelEdit={() => setEditing(null)}
            onDiscard={() => onDiscardComment(slot.comment.id)}
            onSetResolution={(resolution) => onSetCommentResolution(slot.comment.id, resolution)}
          />
        </CommentAnnotationFrame>
      );
    },
    [openEdit, onAddComment, onEditComment, onDiscardComment, onSetCommentResolution, onFollowMove],
  );

  return { editing, draft, openDraft, renderAnnotation };
}

type CommentAnnotationFrameProps = { twoColumn: boolean; children: ReactNode };

/** The band a comment sits in, and the inset that keeps it readable.
 *
 * Two elements, because they do opposite jobs. The outer one takes the annotation
 * slot's full line width and paints `--comment-band`: on a light theme the card
 * wants to be white — paper, at full text contrast — and a white card on a white
 * diff has nothing left to make it *noticeable*, so the emphasis moves off the card
 * and onto the row holding it. The inner one caps the measure.
 *
 * The cap is set against the *lane*, so it follows how this particular file is
 * painting — `twoColumn`, not the view's mode, since a new or deleted file stays
 * single-column even in split (see `rendersTwoColumns`). Beside two columns a
 * comment belongs to the file, not to one column of it, and has to read as clearly
 * out-spanning a lane: anything near a single lane width looks like a mistake, so it
 * takes `5xl` and claims well past the half. Against one column there is nothing to
 * out-span and the cap goes back to serving the prose — `2xl` is around 75
 * characters, and the width the split case needs would only be line length here. */
function CommentAnnotationFrame({
  twoColumn,
  children,
}: CommentAnnotationFrameProps): ReactElement {
  return (
    <div className="bg-comment-band py-3 pr-4 pl-14">
      <div className={twoColumn ? "max-w-5xl" : "max-w-2xl"}>{children}</div>
    </div>
  );
}
