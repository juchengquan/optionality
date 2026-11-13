/** Correcting a held leg's quantity, keeping the holding and its samples (#359).
 *
 *  A holding's legs are never edited: a different structure is a different holding. A quantity
 *  typed wrong is the one exception, because the only other remedy is DELETE, and DELETE takes the
 *  daily samples with it — the one thing in the database that cannot be re-entered. So `PATCH
 *  /positions/{id}` takes `legs` that name the SAME contracts on the same sides, in any order, and
 *  differ from what is stored in nothing but `qty`; anything else is refused as it always was.
 *
 *  What follows a correction, in the one transaction the route opens:
 *
 *  - the legs are written in the order they were recorded, each quantity stored as #351 stores it,
 *    and `qty_corrected_at` stamps when;
 *  - every rule that valued EXACTLY the structure it links to, under the quantities as they were,
 *    takes the corrected quantities with it: the holding's own value rule, and a rule spanning
 *    two holdings in the wing that was corrected. That rule now watches a different figure, so it
 *    is a new rule, unrung, as an edit that changes what a rule watches is (#292, `editedMonitor`).
 *    Its name and its code are KEPT, though a derived name spells the old quantities: the code is
 *    the rule's identity and the holding's name is the trade's, and neither is what was mistyped;
 *  - every rule linked to the holding is given the scope its contracts now have against the
 *    holdings it links to (`positionsHolding`, which compares quantities since #358). A rule that
 *    watched other quantities is not re-quantified — it never valued the holding's structure — but
 *    may now be all of it, or no longer. No link is added or taken away: a correction changes no
 *    contract, so nothing is held or let go.
 *
 *  The samples are KEPT AS THEY ARE. Each one's IV, vega and delta are one contract's readings and
 *  stay true; its Cost to close was summed under the old quantities, and no sample stores a leg's
 *  price, so nothing can re-sum it. `qty_corrected_at` is what says which samples those are.
 */
import type { DatabaseSync } from "node:sqlite";

import { monitorContracts, monitorLegCodes } from "optionality/domain/monitor";
import { type Leg, positionLegCodes, positionsHolding } from "optionality/domain/position";
import {
  findPosition, monitorsWatching, positionsForMonitor, updateMonitorFields, updatePositionFields,
} from "./db/queries/index.ts";
import type { MonitorRow, PositionRow } from "./db/rows.ts";
import { toSqlDatetime } from "./db/time.ts";
import { toSqliteJson } from "./db/values.ts";
import { toMonitor, toPosition } from "./hydrate.ts";
import { storedQty } from "./schemas/position.ts";

/** A leg as the request gives it. */
export interface GivenLeg {
  side: "short" | "long";
  option_type: "CALL" | "PUT";
  strike: number;
  qty?: number;
}

/** The holding's legs with the quantities given, or why the legs given are not a correction. */
export type Corrected = { fault: string } | { legs: Leg[]; changed: boolean };

const TAIL = ": only a leg's quantity can be corrected — a different structure is a different holding";

/** The stored legs, in their own order, with each one's quantity as `given` says — matched by
 *  contract, so the order they are given in does not matter. Refused, with the first thing wrong,
 *  where `given` is not the same contracts on the same sides. `changed` is whether any quantity
 *  differs, so a request that says what is stored writes nothing and stamps nothing. */
export function correctedLegs(name: string, stored: readonly Leg[], given: readonly GivenLeg[]): Corrected {
  const legWords = (n: number) => `${n} leg${n === 1 ? "" : "s"}`;
  if (given.length !== stored.length) {
    return { fault: `'${name}' has ${legWords(stored.length)}, not ${given.length}${TAIL}` };
  }
  const qty = new Map<number, number>();
  for (const g of given) {
    const at = stored.findIndex((l) => l.option_type === g.option_type && l.strike === g.strike);
    const contract = `${g.option_type} ${g.strike}`;
    if (at === -1) return { fault: `'${name}' has no ${contract} leg${TAIL}` };
    if (qty.has(at)) return { fault: `'${name}' is given ${contract} twice${TAIL}` };
    const side = stored[at]!.side;
    if (side !== g.side) return { fault: `'${name}' is ${side} ${contract}, not ${g.side}${TAIL}` };
    qty.set(at, g.qty ?? 1);
  }
  const legs = stored.map((l, i) => ({
    side: l.side, option_type: l.option_type, strike: l.strike, ...storedQty(qty.get(i)),
  }));
  return { legs, changed: legs.some((l, i) => (l.qty ?? 1) !== (stored[i]!.qty ?? 1)) };
}

/** What a correction did to the rules: those whose legs took the new quantities (each a new rule,
 *  unrung), and those whose scope moved, with the scope each now has. The route answers with both,
 *  so the page says what happened rather than what usually would. */
export interface Followed {
  followed: { id: string; code: string }[];
  rescoped: { id: string; code: string; scope: "all" | "leg" | null }[];
}

/** Write a correction and what follows it (see the module's comment). The caller holds the
 *  transaction, and has already checked the holding is open and the legs are a correction. */
export function correctQuantities(db: DatabaseSync, row: PositionRow, legs: Leg[], at: Date): Followed {
  const done: Followed = { followed: [], rescoped: [] };
  const before = toPosition(row);
  updatePositionFields(db, row.id, {
    legs: toSqliteJson(legs.map((l) => ({
      side: l.side, option_type: l.option_type, strike: l.strike, ...storedQty(l.qty),
    }))),
    qty_corrected_at: toSqlDatetime(at),
  });
  const after = toPosition(findPosition(db, row.id)!);
  // contract -> its corrected quantity, for every contract this holding holds
  const corrected = new Map(positionLegCodes(after).map((code, i) => [code, after.legs[i]!.qty ?? 1]));

  for (const watcher of monitorsWatching(db, row.id)) {
    let monitor;
    try {
      monitor = toMonitor(watcher);
    } catch {
      // a rule that cannot be read is the sweep's to quarantine; a correction does not touch it
      continue;
    }
    const linked = positionsForMonitor(db, watcher.id).map(toPosition);
    const linkedBefore = linked.map((p) => (p.id === row.id ? before : p));
    const changes: Partial<MonitorRow> = {};

    let watching = monitor;
    if (positionsHolding(linkedBefore, monitorContracts(monitor)).scope === "all" && monitor.legs?.length) {
      const codes = monitorLegCodes(monitor);
      // one leg per contract of this holding, as #351 records a quantity; a rule from before it that
      // names a contract twice has no one leg to carry the quantity, and keeps its legs
      const once = [...corrected.keys()].every((code) => codes.filter((c) => c === code).length === 1);
      if (once) {
        const followed = monitor.legs.map((l, i) => ({
          sign: l.sign, option_type: l.option_type, strike: l.strike,
          ...storedQty(corrected.get(codes[i]!) ?? l.qty),
        }));
        const text = toSqliteJson(followed);
        if (text !== watcher.legs) {
          // what it watches changed, so it is a new rule: unrung (#292)
          Object.assign(changes, { legs: text, triggered: 0, last_alarm_at: null });
          watching = toMonitor({ ...watcher, legs: text });
          done.followed.push({ id: watcher.id, code: watcher.code });
        }
      }
    }
    const scope = positionsHolding(linked, monitorContracts(watching)).scope;
    if (scope !== watcher.scope) {
      changes.scope = scope;
      done.rescoped.push({ id: watcher.id, code: watcher.code, scope });
    }
    if (Object.keys(changes).length > 0) updateMonitorFields(db, watcher.id, changes);
  }
  return done;
}

/** Whether a sample was summed under quantities since corrected: observed before the correction,
 *  or at an instant never recorded (every such row predates migration 0009, and so any correction).
 *  Both stamps are `toSqlDatetime`'s fixed-width UTC text, so they compare as text. */
export function beforeCorrection(observedAt: string | null, correctedAt: string | null): boolean {
  if (correctedAt === null) return false;
  return observedAt === null || observedAt < correctedAt;
}
