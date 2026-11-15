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
 */
interface Pushed {
  /** closed by Escape, a button or a tap outside: its history.back() is on its way */
  closing: boolean;
  close: () => void;
}

/** Every panel holding a history entry, oldest first. */
const pushed: Pushed[] = [];

function onPop() {
  // the answer to a panel's own closing: it gave its entry up, and nothing else is closed
  for (let i = pushed.length - 1; i >= 0; i -= 1) {
    if (pushed[i]!.closing) { pushed.splice(i, 1); return; }
  }
  // a Back: the newest panel closes, and only it
  pushed.pop()?.close();
}

let listening = false;

export function useDismissOnBack(open: boolean, close: () => void) {
  const mine = useRef<Pushed | null>(null);
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
    return () => {
      for (const entry of listed.current) {
        const at = pushed.indexOf(entry);
        if (at >= 0) pushed.splice(at, 1);
      }
      listed.current = [];
      mine.current = null;
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
