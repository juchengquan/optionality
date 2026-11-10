/** PROTOTYPE — throwaway. The contract every variant implements. */
import type { Book, Prefs } from "./data";

export type Mode = "live" | "review";

export interface VariantProps {
  book: Book;
  /** LIVE: the session (detect and act). REVIEW: after the close (understand). Both show every fault. */
  mode: Mode;
  setMode: (m: Mode) => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
}
