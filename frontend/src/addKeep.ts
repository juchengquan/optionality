import type { AddDraft } from "./add";
import type { ContractDraft } from "./contract";

/** What the Add form holds: which form is showing, and each one's draft. */
interface AddDrafts {
  kind: "spread" | "contract";
  spread: AddDraft;
  contract: ContractDraft;
}

/** The Add form's drafts, kept by the PAGE rather than the form. The form is drawn in the phone's
 *  bottom sheet or the desk's side sheet, and a switch of arrangement — a window dragged across
 *  900px, a phone turned — draws it in the other one: a new form, which started with an empty draft
 *  and lost whatever was typed. Kept here, the new form starts from it.
 *
 *  A box, not React state: the form writes it as it changes and reads it only when it mounts, so a
 *  keystroke redraws the form and not the page. The page empties it whenever the form opens or
 *  closes, so a draft is carried across a switch of arrangement and nowhere else. */
export interface DraftKeeper {
  read: () => AddDrafts | null;
  keep: (drafts: AddDrafts) => void;
  clear: () => void;
}

export function draftKeeper(): DraftKeeper {
  let kept: AddDrafts | null = null;
  return {
    read: () => kept,
    keep: (drafts) => { kept = drafts; },
    clear: () => { kept = null; },
  };
}
