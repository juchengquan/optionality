/** What a HELD save does to the rules already there, said before it is made (#322, #408): the watch
 *  rules it REPLACES — deleted, and made again as the holding's own — and the ones it TAKES OVER,
 *  which the service links to the new holding as they are (`add.ts`'s `takesOver`): a watched
 *  spread's Θ, a long leg's Δ, a watched spread holding the contract. The spread form and the
 *  one-contract form say it alike, and the toast reads both back after the save. */
import type { Monitor } from "./shared/api";
import { ruleWords } from "./add";

export function TakeOver({ held, replacing, taking }: {
  held: boolean;
  /** in words */
  replacing: string[];
  /** null where the holdings are not read, so what is taken over cannot be said yet */
  taking: Monitor[] | null;
}) {
  if (!held) return null;
  return (
    <>
      {replacing.length > 0
        ? <p className="nx-meta nx-add-replaces">{`Replaces the watch rules: ${replacing.join(", ")}`}</p>
        : null}
      {taking === null ? (
        <p className="nx-meta nx-add-takes">
          The holdings are not read yet, so which other rules this holding takes over is the service&apos;s to say once it is saved.
        </p>
      ) : taking.length > 0 ? (
        <p className="nx-meta nx-add-takes">
          {`Also links to this holding: ${taking.map(ruleWords).join(", ")} — kept as they are; edit or delete them after.`}
        </p>
      ) : null}
    </>
  );
}
