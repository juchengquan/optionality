/** "I hold it" or "Watch it" (#293, #331), each saying on itself what choosing it does (#408): the
 *  owner asked whether the two could be one choice, and they cannot — they differ in what the rules
 *  mean (a stop and risk, against entry signals), in what saving does (holding a spread replaces a
 *  watch rule on it) and in where the result lives. Said on the buttons, both always in view, so the
 *  difference is read before choosing rather than learnt after saving.
 *
 *  Each button's NAME stays its two or three words: the consequence is its description, so a voice
 *  user says what is printed largest, and a screen reader hears the rest after it. The spread form
 *  and the one-contract form draw the same pair. */
import { useId } from "react";

import "./add.css";

export const HOLD_MEANS = "records a holding; its rules become a stop and risk";
export const WATCH_MEANS = "rules only, as entry signals";

export function HoldOrWatch({ held, onHeld }: { held: boolean; onHeld: (held: boolean) => void }) {
  const id = useId();
  const choices = [
    { value: true, words: "I hold it", means: HOLD_MEANS },
    { value: false, words: "Watch it", means: WATCH_MEANS },
  ];
  return (
    <div className="nx-seg nx-add-as" role="group" aria-label="add as">
      {choices.map((c) => (
        <button key={c.words} type="button" aria-pressed={held === c.value} aria-label={c.words}
                aria-describedby={`${id}-${c.value}`} onClick={() => onHeld(c.value)}>
          <span className="nx-add-as-words">{c.words}</span>
          <small id={`${id}-${c.value}`}>{c.means}</small>
        </button>
      ))}
    </div>
  );
}
