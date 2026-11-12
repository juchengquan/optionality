/** The desk's ⌘K palette (ADR 0023, #299): find a spread, a Monitor or a holding by text and land
 *  on it, or run one of the page's actions. The model — what it finds, which actions, the chord — is
 *  `commands.ts`; this draws it and hands back what was chosen.
 *
 *  A proper dialog, on Base UI's (as Settings and the phone's sheets are): modal, the focus held
 *  inside it, Escape closing it and handing the focus back where it was. Inside, the WAI-ARIA
 *  combobox with a listbox: the focus stays in the box, the arrows move the active option
 *  (`aria-activedescendant`), Enter chooses it, and the count of what was found is announced.
 *
 *  What was chosen runs once the dialog has CLOSED, not as it closes: until then the page is shut
 *  away behind it, and the inspector's heading or an editor's first box could not take the focus.
 *  Only the desk mounts this, so the phone registers no chord (ADR 0023: parity is by touch there).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";

import type { EntryStyle, UpColour } from "../prefs";
import { isPaletteChord, matching, onMac, words, type Findable, type PaletteAction } from "./commands";
import "./palette.css";

/** What the owner chose: a thing found, or an action. */
export type Chosen = { find: Findable } | { action: PaletteAction };

interface Option {
  key: string;
  label: string;
  detail: string;
  /** why it cannot run now */
  why: string | null;
  group: string;
  chosen: Chosen;
}

/** The chord as `aria-keyshortcuts` writes it, and as the button shows it. */
export function paletteShortcut(): { aria: string; shown: string } {
  return onMac() ? { aria: "Meta+K", shown: "⌘K" } : { aria: "Control+K", shown: "Ctrl K" };
}

export function Palette({ open, onOpenChange, found, actions, onChoose, up, entryStyle }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  found: Findable[];
  actions: PaletteAction[];
  /** runs once the palette has closed */
  onChoose: (chosen: Chosen) => void;
  up: UpColour;
  entryStyle: EntryStyle;
}) {
  // the chord, on the document so it works wherever the focus is — but not over another dialog,
  // which owns the keyboard while it is open
  const isOpen = useRef(open);
  isOpen.current = open;
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  useEffect(() => {
    const mac = onMac();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPaletteChord(e, mac)) return;
      if (!isOpen.current && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      change.current(!isOpen.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // where the focus was when it opened, read as it opens — before the box takes it — so that it can
  // go back there: Base UI's own return goes to a trigger, and the chord has none
  const wasOpen = useRef(false);
  const returnTo = useRef<Element | null>(null);
  if (open && !wasOpen.current) returnTo.current = document.activeElement;
  wasOpen.current = open;

  // what was chosen waits for the close to finish; whether the focus goes back depends on it
  const pending = useRef<Chosen | null>(null);
  const choose = (c: Chosen) => {
    pending.current = c;
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onOpenChange(false); }}
                 onOpenChangeComplete={(o) => {
                   if (o) return;
                   const c = pending.current;
                   pending.current = null;
                   const back = returnTo.current;
                   returnTo.current = null;
                   // back where it was on Escape, a click outside, or an action that leaves the
                   // focus alone; a jump or an opened form takes it itself
                   if ((c === null || !moves(c)) && back instanceof HTMLElement && back.isConnected) back.focus();
                   if (c) onChoose(c);
                 }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="nx-palette-scrim" />
        <Dialog.Popup className="nx-tokens nx-palette" aria-label="commands" data-up={up} data-entry={entryStyle}
                      finalFocus={false}>
          <Search found={found} actions={actions} onChoose={choose} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Whether running `c` puts the focus somewhere of its own. */
function moves(c: Chosen): boolean {
  if ("find" in c) return true;
  return c.action.key === "add" || c.action.key === "edit-monitor" || c.action.key === "close-holding";
}

/** The box and what it finds; mounted with the dialog, so it opens empty every time. */
function Search({ found, actions, onChoose }: {
  found: Findable[]; actions: PaletteAction[]; onChoose: (c: Chosen) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const typed = words(query).length > 0;

  const options = useMemo<Option[]>(() => {
    const finds: Option[] = matching(found, query).map((f) => ({
      key: `f:${f.ref}`, label: f.name, detail: f.detail, why: null, group: "go to", chosen: { find: f },
    }));
    const acts: Option[] = matching(actions, query).map((a) => ({
      key: `a:${a.key}`, label: a.label, detail: a.detail, why: a.why, group: "action", chosen: { action: a },
    }));
    // nothing typed: the actions lead, since the book is the table's to list; something typed:
    // what it found leads, since that is what was asked for
    return typed ? [...finds, ...acts] : [...acts, ...finds];
  }, [found, actions, query, typed]);

  const at = Math.min(active, Math.max(0, options.length - 1));
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const pick = (o: Option | undefined) => {
    // a closed action says why beside it, and choosing it changes nothing
    if (!o || o.why !== null) return;
    onChoose(o.chosen);
  };
  const optionId = (i: number) => `${id}-option-${i}`;

  return (
    <>
      <input className="nx-palette-box" role="combobox" aria-expanded="true" aria-controls={`${id}-list`}
             aria-autocomplete="list" aria-activedescendant={options.length ? optionId(at) : undefined}
             aria-label="find a spread, a Monitor or a holding, or an action" autoFocus autoComplete="off"
             spellCheck={false} placeholder="Find a spread, Monitor or holding — or add, edit, close, switch…"
             value={query}
             onChange={(e) => { setQuery(e.target.value); setActive(0); }}
             onKeyDown={(e) => {
               const last = options.length - 1;
               const next = e.key === "ArrowDown" ? Math.min(at + 1, last)
                 : e.key === "ArrowUp" ? Math.max(at - 1, 0)
                   : e.key === "Home" && e.ctrlKey ? 0 : e.key === "End" && e.ctrlKey ? last : null;
               if (next !== null) { e.preventDefault(); setActive(Math.max(0, next)); return; }
               if (e.key === "Enter") { e.preventDefault(); pick(options[at]); }
               // the box is the dialog's one control — the options are reached by the arrows — so
               // Tab has nowhere to go and the focus stays here
               if (e.key === "Tab") e.preventDefault();
             }} />
      <p className="nx-palette-count" role="status">
        {options.length === 0 ? "nothing matches" : `${options.length} result${options.length === 1 ? "" : "s"}`}
      </p>
      <ul ref={list} id={`${id}-list`} className="nx-palette-list" role="listbox" aria-label="results">
        {options.map((o, i) => (
          <li key={o.key} id={optionId(i)} role="option" data-index={i} aria-selected={i === at}
              aria-disabled={o.why !== null ? true : undefined}
              // the box keeps the focus: a press on an option must not take it
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => { if (i !== at) setActive(i); }}
              onClick={() => pick(o)}>
            <span className="nx-palette-label" data-label="">{o.label}</span>
            <span className="nx-palette-detail">{o.why ?? o.detail}</span>
            <span className="nx-palette-group">{o.group}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
