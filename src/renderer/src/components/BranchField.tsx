import {
  useDeferredValue,
  useId,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import type { BranchName } from "../../../shared/git";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { InputGroupAddon } from "@/components/ui/input-group";
import { TooltipHint } from "@/components/ui/tooltip";

// The one branch input in the app. The picker asks two different questions with it —
// which history to list, and which two refs to compare — and they must not be two
// different fields with two different manners.

type BranchFieldProps = {
  /** The caption above the field. Omitted where the field is the only one in its
   * section and its icon already says what it picks — the caption would then be a label
   * on a list of one. `aria-label` carries the name in that case. */
  label?: string | undefined;
  branches: BranchName[];
  value: BranchName | null;
  onChange: (branch: BranchName) => void;
  /** A leading glyph inside the field, in the file filter's manner: what this input is
   * about, said once, without spending a caption row on it. */
  icon?: ReactNode | undefined;
  /** The accessible name when there is no visible caption. */
  ariaLabel?: string | undefined;
  /** What the field says while it holds nothing. The comparison ref is genuinely
   * optional, so its empty state is a state and not a prompt to fill it in. */
  placeholder?: string | undefined;
  /** Offered when the field's value is optional and set — the way back to empty. */
  onClear?: (() => void) | undefined;
  /** A control that belongs to the field but is not part of it — today only the swap,
   * which rides the Head caption's own line rather than floating in the gap between
   * the two fields, where it read as a third, unlabelled input. */
  action?: ReactNode | undefined;
};

export function BranchField({
  label,
  branches,
  value,
  onChange,
  action,
  icon,
  ariaLabel,
  placeholder = "Select branch",
  onClear,
}: BranchFieldProps): ReactElement {
  const [query, setQuery] = useState("");
  const inputId = useId();
  // Typing stays responsive on huge branch lists; the filtered list follows a
  // frame later.
  const deferredQuery = useDeferredValue(query);
  const filter = ComboboxPrimitive.useFilter({ sensitivity: "base", value });
  const filtered = useMemo(
    () => branches.filter((branch) => filter.contains(branch, deferredQuery)),
    [branches, filter, deferredQuery],
  );

  return (
    <div className="flex flex-col gap-1">
      {/* The caption is its own row rather than a wrapping <label>, so a control can
          sit at its far end without landing inside the field's own hit target. */}
      {(label !== undefined || action !== undefined) && (
        <div className="flex h-4 items-center justify-between gap-2">
          {label === undefined ? (
            <span />
          ) : (
            <label htmlFor={inputId} className="text-xs text-text-muted">
              {label}
            </label>
          )}
          {action}
        </div>
      )}
      <Combobox
        items={branches}
        filteredItems={filtered}
        value={value}
        onValueChange={(branch) => {
          if (branch === null) {
            // Base UI clears to null; only a field that offers clearing means anything
            // by it, so the rest ignore it rather than reporting an empty pick.
            onClear?.();
          } else {
            onChange(branch);
          }
        }}
        onInputValueChange={setQuery}
      >
        {/* A long branch name scrolls out of the field, so the full value stays
            recoverable — but only once it actually does. */}
        <TooltipHint content={value} whenTruncated side="top" align="start">
          <ComboboxInput
            id={inputId}
            placeholder={placeholder}
            showClear={onClear !== undefined}
            className="h-8 text-sm"
            {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
          >
            {icon === undefined ? null : (
              <InputGroupAddon align="inline-start">{icon}</InputGroupAddon>
            )}
          </ComboboxInput>
        </TooltipHint>
        <ComboboxContent>
          <ComboboxEmpty>No branches match.</ComboboxEmpty>
          <ComboboxList>
            {(branch: BranchName): ReactNode => (
              <ComboboxItem key={branch} value={branch} className="text-sm">
                <TooltipHint content={branch} whenTruncated side="right" align="center">
                  <span className="truncate">{branch}</span>
                </TooltipHint>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
