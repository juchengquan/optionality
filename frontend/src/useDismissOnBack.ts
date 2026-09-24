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
 */
export function useDismissOnBack(open: boolean, close: () => void) {
  const pushed = useRef(false);
  const closing = useRef(false);

  useEffect(() => {
    if (open && !pushed.current) {
      window.history.pushState({ panel: true }, "");
      pushed.current = true;
      return;
    }
    if (!open && pushed.current && !closing.current) {
      // closed by Escape, the button, or a tap outside — take our entry back off the
      // stack, or the next press of back silently does nothing
      closing.current = true;
      window.history.back();
    }
  }, [open]);

  useEffect(() => {
    const onPop = () => {
      if (!pushed.current) return;
      pushed.current = false;
      if (closing.current) {
        // this popstate is the one we asked for above; the panel is already shut
        closing.current = false;
        return;
      }
      close();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [close]);
}
