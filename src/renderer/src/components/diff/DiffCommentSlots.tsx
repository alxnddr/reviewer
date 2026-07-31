import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import type { CodeViewProps } from "@pierre/diffs/react";
import type { ReviewAnchor } from "../../../../shared/review";
import type { CommentDraft, CommentSlot } from "../../../../shared/diff/comment-annotations";
import { CommentEditor } from "@/components/CommentEditor";
import { CommentThread } from "@/components/CommentThread";

type AnnotationRenderer = NonNullable<CodeViewProps<CommentSlot>["renderAnnotation"]>;

/** The curation half of the diff surface: which comment is open for editing, the
 * in-flight new one, and what each annotation slot draws. */
export type CommentSlots = {
  /** Folded into the items' annotations, so a version bump follows every visible
   * change — CodeView reuses an item record and only re-renders its slots when the
   * version changes. */
  editingId: string | null;
  draft: CommentDraft | null;
  /** Open a new-comment editor on an anchor — the gutter `+`'s one gesture. */
  openDraft: (fileId: string, anchor: ReviewAnchor) => void;
  renderAnnotation: AnnotationRenderer;
};

export type CommentSlotHandlers = {
  onAddComment: (anchor: ReviewAnchor, body: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDiscardComment: (commentId: string) => void;
};

/** Comment cards, their editors, and the two pieces of state that say which is which.
 * Kept together because they are one closed loop: the state decides what a slot draws,
 * and every slot's save or cancel is what clears it. The writes themselves belong to the
 * session's slice and are handed in. */
export function useCommentSlots({
  onAddComment,
  onEditComment,
  onDiscardComment,
}: CommentSlotHandlers): CommentSlots {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);

  // One editor is on-screen at a time: opening a draft closes any open edit, and
  // opening an edit closes any in-flight draft — the two-editor state is never
  // reachable from either direction.
  const openDraft = useCallback((fileId: string, anchor: ReviewAnchor) => {
    setEditingId(null);
    setDraft({ fileId, anchor });
  }, []);
  const openEdit = useCallback((commentId: string) => {
    setDraft(null);
    setEditingId(commentId);
  }, []);

  const renderAnnotation = useCallback<AnnotationRenderer>(
    (annotation): ReactNode => {
      const slot = annotation.metadata;
      if (slot.kind === "draft") {
        return (
          <CommentAnnotationFrame twoColumn={slot.twoColumn}>
            <CommentEditor
              initialBody=""
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
      if (slot.editing) {
        return (
          <CommentAnnotationFrame twoColumn={slot.twoColumn}>
            <CommentEditor
              initialBody={slot.comment.body}
              saveLabel="Save"
              onSave={(body) => {
                onEditComment(slot.comment.id, body);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
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
            onEdit={() => openEdit(slot.comment.id)}
            onDiscard={() => onDiscardComment(slot.comment.id)}
          />
        </CommentAnnotationFrame>
      );
    },
    [openEdit, onAddComment, onEditComment, onDiscardComment],
  );

  return { editingId, draft, openDraft, renderAnnotation };
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
