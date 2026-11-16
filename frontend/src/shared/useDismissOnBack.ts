import { useEffect, useRef } from "react";

/** Makes the phone's back button close a panel instead of leaving the dashboard.
 *
 *  This is NOT a router. It pushes one history entry when a panel opens and consumes it
 *  when the panel closes; no address changes meaning, nothing becomes shareable, and
 *  ADR 0006's baked base path is untouched.
 *
 *  The part that bites: if the panel closes any other way — Escape, the close button,
 *  tapping outside — the entry is still on the stack, and the next press of back does
 *  nothing at all while appearing to be ignored. So closing has to consume it too, and
 *  the flag below is what stops that consumption from looping.
 *
 *  Panels STACK (#408): "Record as held" opens the Add sheet over the phone's detail sheet. Every
 *  open panel listens for the same popstate, so with one hook per panel and nothing shared, one
 *  Back closed both — and the entry a panel gave up by closing was taken by the other as a Back.
 *  So the entries are kept in one list, in the order they were pushed, as the history holds them:
 *  a popstate is first the answer to a panel's own closing (the newest such, consumed and nothing
 *  more), and otherwise a Back, which closes the newest panel only.
 *
 *  A panel can also GO while open — the phone's detail sheet, when the phone turns into the desk —
 *  and give its entry up as it goes (`giveBackOnUnmount`). Only the newest entry can be taken off
 *  the history, so one with others above it — "Record as held"'s Add, opened over the detail — is
 *  kept in the list as an orphan and taken back once the entries above it have gone. A back() made
 *  there and then took the Add sheet's entry from under it instead: the next popstate closed Add,
 *  the sheet the switch was keeping, and the detail's entry was left on the stack.
 */
interface Pushed {
  /** closed by Escape, a button or a tap outside: its history.back() is on its way */
  closing: boolean;
  /** its panel has gone while it was open: nothing is closed by it, and its entry is taken back as
   *  soon as it is the newest (`settle`) */
  orphan?: boolean;
  close: () => void;
}

/** Every panel holding a history entry, oldest first. */
const pushed: Pushed[] = [];

function onPop() {
  // the answer to a panel's own closing: it gave its entry up, and nothing else is closed
  for (let i = pushed.length - 1; i >= 0; i -= 1) {
    if (pushed[i]!.closing) { pushed.splice(i, 1); settle(); return; }
  }
  // a Back: the newest panel closes, and only it
  pushed.pop()?.close();
  settle();
}

/** An orphan's entry, taken back once it is the newest: nothing above it is left to pop instead. */
function settle() {
  const top = pushed[pushed.length - 1];
  if (top?.orphan && !top.closing) {
    top.closing = true;
    window.history.back();
  }
}

let listening = false;

export function useDismissOnBack(open: boolean, close: () => void, { giveBackOnUnmount = false } = {}) {
  const mine = useRef<Pushed | null>(null);
  const giveBack = useRef(giveBackOnUnmount);
  giveBack.current = giveBackOnUnmount;
  /** every entry this panel pushed that is still listed, closing ones too */
  const listed = useRef<Pushed[]>([]);
  const closeNow = useRef(close);
  closeNow.current = close;

  useEffect(() => {
    if (!listening) {
      window.addEventListener("popstate", onPop);
      listening = true;
    }
    // unmounted, its entries stay in the history, as they always did, but it is no longer a panel
    // a Back could close, nor one whose closing is still to be answered: left in the list, the next
    // Back would close nothing that is drawn
    // ...unless it gives its entry back as it goes (`giveBackOnUnmount`), open: the newest is taken
    // back now, as it always was, if the page is still on a panel's entry; one with entries above
    // it is left as an orphan, taken back once they have gone (`settle`)
    return () => {
      const open = giveBack.current ? mine.current : null;
      const newest = open !== null && pushed[pushed.length - 1] === open;
      for (const entry of listed.current) {
        if (entry === open && !newest) { entry.orphan = true; continue; }
        const at = pushed.indexOf(entry);
        if (at >= 0) pushed.splice(at, 1);
      }
      listed.current = [];
      mine.current = null;
      if (newest && window.history.state?.panel) window.history.back();
      // an orphan left newest by a panel that went without giving its entry back (the page itself
      // going) is no longer anything a Back could reach: forgotten, as that panel's own entry is
      while (pushed[pushed.length - 1]?.orphan && !pushed[pushed.length - 1]!.closing) pushed.pop();
    };
  }, []);

  useEffect(() => {
    if (open && mine.current === null) {
      window.history.pushState({ panel: true }, "");
      const entry: Pushed = { closing: false, close: () => { mine.current = null; closeNow.current(); } };
      mine.current = entry;
      pushed.push(entry);
      listed.current = [...listed.current.filter((e) => pushed.includes(e)), entry];
      return;
    }
    if (!open && mine.current !== null) {
      // closed by Escape, the button, or a tap outside — take our entry back off the stack, or
      // the next press of back silently does nothing
      mine.current.closing = true;
      mine.current = null;
      window.history.back();
    }
  }, [open]);
}
