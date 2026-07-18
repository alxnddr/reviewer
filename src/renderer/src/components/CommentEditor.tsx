import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type CommentEditorProps = {
  /** Empty for a new comment, the current body for an edit. */
  initialBody: string;
  /** The primary action's label — "Comment" when adding, "Save" when editing. */
  saveLabel: string;
  onSave: (body: string) => void;
  onCancel: () => void;
};

/** The add/edit surface, slotted beneath the anchored line. Uncontrolled: the
 * textarea owns its text so keystrokes never re-render the diff item (a body
 * change reaches the store only on Save). Save is the one accented action here
 * (the accent budget); Cancel stays neutral. */
export function CommentEditor({
  initialBody,
  saveLabel,
  onSave,
  onCancel,
}: CommentEditorProps): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [empty, setEmpty] = useState(initialBody.trim() === "");

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
    const body = textareaRef.current?.value ?? "";
    if (body.trim() !== "") {
      onSave(body);
    }
  };

  return (
    <div className="flex flex-col gap-2 font-sans">
      <Textarea
        ref={textareaRef}
        defaultValue={initialBody}
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
        placeholder="Leave a comment"
        aria-label="Comment body"
        // md:text-base overrides the Textarea composite's md:text-sm control-shrink
        // so the edit field matches the 14px reading register of the body it edits.
        className="min-h-16 text-base md:text-base"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={empty}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
