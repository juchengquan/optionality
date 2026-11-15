/** A rule's direction as two buttons, ≥ and ≤ (#405): the add form's spread lines, its one contract
 *  and the Monitor editor all choose it this way, so the three read alike. The add form's `nx-seg`
 *  pair, as "I hold it / Watch it" is, rather than a dropdown: two choices, both always in view.
 *
 *  Each button's name starts with the sign it shows, so a voice user says what they see. */
import "./add.css";

export type Direction = "above" | "below";

const WORDS: Record<Direction, [string, string]> = {
  above: ["≥", "≥ at or above"],
  below: ["≤", "≤ at or below"],
};

export function DirectionPair({ value, onChange, disabled, ...group }: {
  value: string;
  onChange: (d: Direction) => void;
  disabled?: boolean;
  /** the group's name, and whatever ties it to a refusal said about it */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <div className="nx-seg nx-dir" role="group" {...group}>
      {(["above", "below"] as const).map((d) => (
        <button key={d} type="button" aria-pressed={value === d} aria-label={WORDS[d][1]} title={WORDS[d][1]}
                disabled={disabled} onClick={() => onChange(d)}>{WORDS[d][0]}</button>
      ))}
    </div>
  );
}
