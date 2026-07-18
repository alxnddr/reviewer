import { useDeferredValue, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { ArrowUpDown } from "lucide-react";
import type { BranchName } from "../../../shared/git";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

type BranchFieldProps = {
  label: string;
  branches: BranchName[];
  value: BranchName | null;
  onChange: (branch: BranchName) => void;
};

function BranchField({ label, branches, value, onChange }: BranchFieldProps): ReactElement {
  const [query, setQuery] = useState("");
  // Typing stays responsive on huge branch lists; the filtered list follows a
  // frame later.
  const deferredQuery = useDeferredValue(query);
  const filter = ComboboxPrimitive.useFilter({ sensitivity: "base", value });
  const filtered = useMemo(
    () => branches.filter((branch) => filter.contains(branch, deferredQuery)),
    [branches, filter, deferredQuery],
  );

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <Combobox
        items={branches}
        filteredItems={filtered}
        value={value}
        onValueChange={(branch) => {
          if (branch !== null) {
            onChange(branch);
          }
        }}
        onInputValueChange={setQuery}
      >
        <ComboboxInput
          placeholder="Select branch"
          title={value ?? undefined}
          className="h-8 font-mono text-sm"
        />
        <ComboboxContent>
          <ComboboxEmpty>No branches match.</ComboboxEmpty>
          <ComboboxList>
            {(branch: BranchName): ReactNode => (
              <ComboboxItem key={branch} value={branch} className="font-mono text-sm">
                <span className="truncate" title={branch}>
                  {branch}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </label>
  );
}

type BranchComparePickerProps = {
  branches: BranchName[];
};

/** Base vs head, base preselected to the repo's default branch. */
export function BranchComparePicker({ branches }: BranchComparePickerProps): ReactElement {
  const base = useReviewStore((state) => selectActiveSlice(state)?.base ?? null);
  const head = useReviewStore((state) => selectActiveSlice(state)?.head ?? null);
  const setBase = useReviewStore((state) => state.setBase);
  const setHead = useReviewStore((state) => state.setHead);
  const swapBranches = useReviewStore((state) => state.swapBranches);

  if (branches.length === 0) {
    return <p className="px-2 py-3 text-xs text-text-muted">This repository has no branches.</p>;
  }

  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      <BranchField label="Base" branches={branches} value={base} onChange={setBase} />
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => swapBranches()}
          disabled={base === null || head === null}
          aria-label="Swap base and head"
          className="text-sm text-text-muted hover:bg-border/60"
        >
          <ArrowUpDown aria-hidden="true" />
          Swap
        </Button>
      </div>
      <BranchField label="Head" branches={branches} value={head} onChange={setHead} />
    </div>
  );
}
