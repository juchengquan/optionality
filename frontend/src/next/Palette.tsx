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
import { isPaletteChord, matching, onMac, tokens, type Findable, type PaletteAction } from "./commands";
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

export function Palette({ open, onOpenChange, found, findWhy, actions, onChoose, up, entryStyle }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  found: Findable[];
  /** why nothing found can be landed on now — a form open on the desk — or null when it can */
  findWhy: string | null;
  actions: PaletteAction[];
  /** runs once the palette has closed */
  onChoose: (chosen: Chosen) => void;
  up: UpColour;
  entryStyle: EntryStyle;
}) {
  // the chord, on the document so it works wherever the focus is. Over another dialog, which owns
  // the keyboard while it is open, it opens nothing — but it is still taken from the browser, whose
  // Ctrl+K would otherwise jump to its address bar from inside Settings
  const isOpen = useRef(open);
  isOpen.current = open;
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  useEffect(() => {
    const mac = onMac();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPaletteChord(e, mac)) return;
      e.preventDefault();
      if (!isOpen.current && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
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

  // what was chosen waits for the close to finish
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
                   // back where it was, always: a jump or an opened form then takes it on itself,
                   // and an action that moves nothing leaves it where the owner left it
                   if (back instanceof HTMLElement && back.isConnected) back.focus();
                   if (c) onChoose(c);
                 }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="nx-palette-scrim" />
        <Dialog.Popup className="nx-tokens nx-palette" aria-label="commands" data-up={up} data-entry={entryStyle}
                      finalFocus={false}>
          <Search found={found} findWhy={findWhy} actions={actions} onChoose={choose} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The box and what it finds; mounted with the dialog, so it opens empty every time. */
function Search({ found, findWhy, actions, onChoose }: {
  found: Findable[]; findWhy: string | null; actions: PaletteAction[]; onChoose: (c: Chosen) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // a closed option chosen says why, out loud: beside it is only where an eye would look
  const [refused, setRefused] = useState("");
  const id = useId();
  const typed = tokens(query).length > 0;

  const options = useMemo<Option[]>(() => {
    const finds: Option[] = matching(found, query).map((f) => ({
      key: `f:${f.ref}`, label: f.name, detail: f.detail, why: findWhy, group: "go to", chosen: { find: f },
    }));
    const acts: Option[] = matching(actions, query).map((a) => ({
      key: `a:${a.key}`, label: a.label, detail: a.detail, why: a.why, group: "action", chosen: { action: a },
    }));
    // nothing typed: the actions lead, since the book is the table's to list; something typed:
    // what it found leads, since that is what was asked for
    return typed ? [...finds, ...acts] : [...acts, ...finds];
  }, [found, findWhy, actions, query, typed]);

  const at = Math.min(active, Math.max(0, options.length - 1));
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const pick = (o: Option | undefined) => {
    if (!o) return;
    // a closed option says why beside it, and choosing it changes nothing but saying so
    if (o.why !== null) { setRefused(`${o.label}: ${o.why}`); return; }
    onChoose(o.chosen);
  };
  // named by WHAT it is, not where it sits: when the top result changes, the active option's id
  // changes with it, and a screen reader says the new one
  const optionId = (o: Option) => `${id}-${o.key.replace(/[^\w-]/g, "_")}`;

  return (
    <>
      <input className="nx-palette-box" role="combobox" aria-expanded="true" aria-controls={`${id}-list`}
             aria-autocomplete="list" aria-activedescendant={options[at] ? optionId(options[at]) : undefined}
             aria-label="find a spread, a Monitor or a holding, or an action" autoFocus autoComplete="off"
             spellCheck={false} placeholder="Find a spread, Monitor or holding — or add, edit, close, switch…"
             value={query}
             onChange={(e) => { setQuery(e.target.value); setActive(0); setRefused(""); }}
             onKeyDown={(e) => {
               // an input method composing a word owns Enter and the arrows until it is done
               if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
      <p className="sr-only" data-testid="refusal" aria-live="assertive">{refused}</p>
      <ul ref={list} id={`${id}-list`} className="nx-palette-list" role="listbox" aria-label="results">
        {options.map((o, i) => (
          <li key={o.key} id={optionId(o)} role="option" data-index={i} aria-selected={i === at}
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
