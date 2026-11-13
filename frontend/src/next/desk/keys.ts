/** The desk's keys (ADR 0023, #299): j and k move the selection through the table's rows in the
 *  order the table draws them, and Enter opens the inspector on it. Escape, which closes the
 *  inspector, was the inspector's before these and stays in `DeskBook`.
 *
 *  A key does nothing when it is someone else's:
 *  - with Ctrl, ⌘ or Alt held — that is another chord, and the browser's — or while an input
 *    method is composing a word, or when something earlier already handled the key;
 *  - while the focus is where a key is TYPED: an input, a textarea, a select, an editable region;
 *  - while a dialog is open — the palette, Settings, a column picker — which owns the keyboard;
 *  - while the focus is in the closed trades' fold (#373), whose rows are not the table's;
 *  - while a form is open in the desk (the inspector's editors, a delete asked about) or the add
 *    panel is: j would move the inspector out from under a draft, and with it the draft. The
 *    palette keeps the same rule (`holdOnDesk`): while a form holds, it lands on nothing and opens
 *    no other form, and says so. The fold's own forms are not the desk's here: a correction
 *    left open in it holds no row of the table.
 *  Enter is also left to any control that has the focus, which answers it itself.
 *
 *  Only the desk mounts this, so the phone registers nothing (ADR 0023: parity is by touch there).
 */
import { useEffect, useRef } from "react";

import type { Hold } from "../commands";

/** Where the table's selection is, and whether the inspector is open on it. */
export interface DeskSelection {
  id: string | null;
  open: boolean;
  /** a request from outside the table — the palette's — counted so the same one twice is two, and
   *  what to do once it lands: show the row, or open its Monitor's editor or its close form */
  request?: { n: number; then: "inspect" | "edit" | "close" };
}

export const NOTHING_SELECTED: DeskSelection = { id: null, open: false };

/** Whether a key pressed at `target` is being typed into something. */
export function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  // the attribute as well as the property: what inherits it is editable too, and jsdom has no
  // `isContentEditable` at all
  return (target instanceof HTMLElement && target.isContentEditable)
    || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** The closed trades' fold (#373), the last thing in the desk's book: it is not the table, and a
 *  correction drawn in it holds nothing of the table's — a jump moves no draft of the fold's, which
 *  stays mounted. Its own keys are its own: a key pressed inside it is never the table's. */
const FOLD = ".nxj-fold";

/** The forms, and whatever else holds, in the TABLE and its inspector: never the fold's. */
function holding(desk: Element | null, selector: string): Element[] {
  return [...(desk?.querySelectorAll(selector) ?? [])].filter((el) => el.closest(FOLD) === null);
}

/** Whether something else owns the keyboard now: a dialog, or a form open on the desk. */
export function keysAreElsewhere(desk: Element | null): boolean {
  if (document.querySelector('[role="dialog"], [role="alertdialog"], .nx-add-panel')) return true;
  return holding(desk, 'form, [data-poll="hold"]').length > 0;
}

/** Whether a key pressed at `target` was pressed inside the closed trades' fold. */
export function inFold(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FOLD) !== null;
}

/** What holds the desk, for the palette (`Hold` in commands.ts): read from the page as it stands. */
export function holdOnDesk(desk: Element | null): Hold {
  const held = holding(desk, '[data-poll="hold"]');
  if (held.length === 0) return null;
  const inspector = desk!.querySelector(".nxd-inspector");
  const form = held[0]!;
  if (held.length === 1 && inspector?.contains(form)) {
    // the selected rule's controls are the inspector's first; a rule under it has its own
    if (form.matches("form.nx-mon-form") && form.closest(".nx-mon") === inspector.querySelector(".nx-mon")) return "edit";
    const pressed = inspector.querySelector('.nx-hold-actions button[aria-expanded="true"]');
    if (form.closest(".nx-hold") && pressed?.textContent === "Close…") return "close";
  }
  return "other";
}

/** What a control with the focus answers Enter with itself. */
const ANSWERS_ENTER = 'button, a[href], summary, [role="button"], [role="link"], [role="option"], [tabindex]:not([tabindex="-1"])';

export function useDeskKeys({ ids, selection, setSelection, desk }: {
  /** every row's id, in the order the table draws them */
  ids: string[];
  selection: DeskSelection;
  setSelection: (s: DeskSelection) => void;
  desk: React.RefObject<HTMLElement | null>;
}) {
  // read through refs, so the listener is added once per mount and removed on unmount
  const now = useRef({ ids, selection, setSelection });
  now.current = { ids, selection, setSelection };
  const moved = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== "j" && e.key !== "k" && e.key !== "Enter") return;
      if (typingInto(e.target) || inFold(e.target) || keysAreElsewhere(desk.current)) return;
      const { ids, selection: s, setSelection: set } = now.current;
      if (e.key === "Enter") {
        if (s.id === null || s.open) return;
        if (e.target instanceof Element && e.target.closest(ANSWERS_ENTER)) return;
        e.preventDefault();
        set({ id: s.id, open: true });
        return;
      }
      if (ids.length === 0) return;
      const at = s.id === null ? -1 : ids.indexOf(s.id);
      const to = e.key === "j"
        ? (at < 0 ? 0 : Math.min(at + 1, ids.length - 1))
        : (at < 0 ? ids.length - 1 : Math.max(at - 1, 0));
      e.preventDefault();
      moved.current = true;
      set({ id: ids[to]!, open: s.open });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [desk]);

  // the row a key landed on is brought into view and, with the inspector shut, given the focus —
  // which is what makes it the place Enter opens; an open inspector takes the focus itself
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const row = rowElement(desk.current, selection.id);
    row?.scrollIntoView?.({ block: "nearest" });
    if (!selection.open) row?.querySelector<HTMLElement>(".nxd-name")?.focus();
  }, [selection.id, selection.open, desk]);
}

export function rowElement(desk: Element | null, id: string | null): HTMLElement | null {
  if (id === null) return null;
  return [...(desk?.querySelectorAll<HTMLElement>(".nxd-row[data-ref]") ?? [])].find((r) => r.dataset.ref === id) ?? null;
}
