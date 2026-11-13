import { useEffect, useState } from "react";

import type { ArrangementChoice } from "../shared/prefs";

/** Two arrangements over one capability (ADR 0023): the terminal on the desk, cards on the phone.
 *
 *  The MEASURED width chooses, never the device's name or a user agent: an iPad in portrait is a
 *  phone-shaped screen and a narrow desk window is too, and both want the cards. Below this the
 *  cards, at or above it the terminal — "about 900 CSS pixels", which is where the terminal's
 *  holdings, watchlist and a beside-the-table inspector stop fitting side by side.
 */
export const DESK_FROM = 900;

export type Arrangement = "desk" | "phone";

export function arrangementFor(width: number, choice: ArrangementChoice): Arrangement {
  if (choice !== "auto") return choice;
  return width >= DESK_FROM ? "desk" : "phone";
}

/** The viewport's CSS width, re-read on every resize: a window dragged across the line swaps the
 *  arrangement there and then, as the columns of ADR 0008 are re-fitted. The layout viewport, not
 *  `innerWidth`, so a scrollbar is not counted as room. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => document.documentElement.clientWidth);
  useEffect(() => {
    const read = () => setWidth(document.documentElement.clientWidth);
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  return width;
}
