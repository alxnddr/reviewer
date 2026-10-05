import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { CommentProse } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type CommentEditorProps = {
  /** Which of the comment's prose this edits, which decides the surface it is drawn on and
   * the words that say what goes in it (`editorFace`). */
  field: CommentProse;
  /** Empty for a new comment, the current text for an edit. A postable is only ever edited —
   * the agent writes it, the app never starts one (`CommentPostable`) — so for that field this
   * is always the postable as it stands. */
  initialText: string;
  /** The primary action's label — "Comment" when adding, "Save" when editing. */
  saveLabel: string;
  onSave: (text: string) => void;
  onCancel: () => void;
};

/** What differs between the two editors: the surface, the words, and what empty text means.
 * Everything else — the keys, the focus — is one behaviour, which is why this is one
 * component that takes the field rather than a second editor beside it.
 *
 * Empty text is where the two fields part: a comment cannot lose its body, so an empty body
 * is nothing to save and the action is disabled; a postable can be removed — the reader
 * deciding this finding is not to be posted — so on empty text the action stays enabled,
 * reads "Remove", and hands `onSave` the empty string (`editComment` removes the key).
 *
 * The body's editor is the card, for the reason the component's own doc gives. The
 * postable's is drawn *bare*: it opens inside the card, under the finding it is rewriting for
 * the author, in the inset block the finished postable sits in (`CommentPostable`), which
 * carries the rule and the focus. A card edge inside a card edge would read as a second
 * comment. Its type is the block's step down too, so the text does not change size between
 * writing it and reading it back. */
function editorFace(field: CommentProse): {
  surface: string;
  inner: string;
  text: string;
  placeholder: string;
  label: string;
  /** Whether saving empty text removes the field rather than being nothing to save. */
  removable: boolean;
} {
  switch (field) {
    case "body":
      return {
        surface:
          "rounded-lg border border-border-strong bg-comment-surface shadow-surface transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        inner: "px-4 py-3",
        // md:text-base overrides the Textarea composite's md:text-sm control-shrink so the
        // field matches the 14px reading register of the body it edits.
        text: "text-base md:text-base",
        placeholder: "Leave a comment",
        label: "Comment body",
        removable: false,
      };
    case "postable":
      return {
        surface: "",
        inner: "",
        text: "text-sm md:text-sm",
        placeholder: "The comment as you would post it to the change's author",
        label: "Comment for the author",
        removable: true,
      };
  }
}

/** The add/edit surface, slotted beneath the anchored line. Uncontrolled: the
 * textarea owns its text so keystrokes never re-render the diff item (a body
 * change reaches the store only on Save). Save is the one accented action here
 * (the accent budget); Cancel stays neutral.
 *
 * The composer is the *same card* the finished comment becomes — one surface, one
 * border, one radius, the same `--comment-surface` fill, inside the same band —
 * rather than a bare field floating on the code. The textarea gives up its own
 * chrome to make that true: the card is the input, so the focus ring lands on the
 * card edge and writing a comment reads as filling in the thing you are about to
 * leave behind, not as opening a form over the diff. */
export function CommentEditor({
  field,
  initialText,
  saveLabel,
  onSave,
  onCancel,
}: CommentEditorProps): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [empty, setEmpty] = useState(initialText.trim() === "");
  const face = editorFace(field);
  const removing = empty && face.removable;

  // Focus on mount with the caret after the existing text, so an edit continues
  // where it left off. Instant — an opened editor is a keyboard/click action.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const save = (): void => {
    const text = textareaRef.current?.value ?? "";
    if (text.trim() !== "" || face.removable) {
      onSave(text);
    }
  };

  return (
    <div className={cn("font-sans", face.surface)}>
      <div className={cn("flex flex-col gap-2", face.inner)}>
        <Textarea
          ref={textareaRef}
          defaultValue={initialText}
          onInput={(event) => setEmpty(event.currentTarget.value.trim() === "")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              save();
            }
          }}
          rows={3}
          placeholder={face.placeholder}
          aria-label={face.label}
          // Stripped to raw text: no border, no fill, no focus ring of its own — the surface
          // around it carries all three (focus-within), so the two never draw two nested
          // boxes.
          className={cn(
            "min-h-16 rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent",
            face.text,
          )}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {/* Removal wears the destructive tone Discard does, so the one press that takes
              something away never looks like the one that keeps it. */}
          <Button
            size="sm"
            variant={removing ? "destructive" : "default"}
            onClick={save}
            disabled={empty && !face.removable}
          >
            {removing ? "Remove" : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
