import { describe, expect, it } from "vitest";
import { DISABLED_REASONS } from "backend/schemas";

import { GROUPS } from "../shared/groups";

/** The page groups a disabled rule BY its `disabled_reason`, and a reason with no group renders in
 *  NO group: the row vanishes from the page while sitting disabled in the database — a rule that
 *  cannot fire and is nowhere to be seen. That is what #167's new reason would have done, so the
 *  list the service writes from is published as `DISABLED_REASONS` and this holds the page to it.
 *
 *  Imported into the TEST and not into the page: the list is a runtime value, and importing it
 *  from the bundle would pull zod and the domain into the dashboard for four strings. Moved here
 *  from `Muted.test.tsx` (#337), which rendered the old page and went with it in #301. */
describe("the groups a disabled rule is shown under", () => {
  it("has a group for every reason the service disables a rule for", () => {
    const grouped = new Set(GROUPS.map(([reason]) => reason));
    for (const reason of DISABLED_REASONS) {
      expect(grouped.has(reason), `no group for '${reason}'`).toBe(true);
    }
  });

  it("keeps the two Quarantines above the rule you muted yourself", () => {
    const order = GROUPS.map(([reason]) => reason);
    expect(order.indexOf("unknown-contract")).toBeLessThan(order.indexOf("manual"));
    expect(order.indexOf("no-figure")).toBeLessThan(order.indexOf("manual"));
  });
});
