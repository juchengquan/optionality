import type { Entry } from "../../api";
import { isEntrySignal } from "../needs";

/** The state a rule is in, as one of the attention family's chips — or none while it is calm.
 *  The desk's reading (Book.tsx), so a fired entry, a ringing risk rule and a fault look the same
 *  in both arrangements. */
export function ruleState(e: Entry): "fault" | "entry" | "alarm" | null {
  if (e.error) return "fault";
  if (!e.triggered) return null;
  return isEntrySignal(e) ? "entry" : "alarm";
}
