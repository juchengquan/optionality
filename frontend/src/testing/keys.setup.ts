/** A test that draws two children with one key FAILS (#368).
 *
 *  React does not throw on a duplicate key: it logs "Encountered two children with the same key"
 *  and draws on, and the list may then show a row twice or drop one. In this suite that was a line
 *  in the log of a passing test — the fake `/monitors` of `testing/ruleEdits.ts` served the three
 *  rules that are off two and three times over, and every test passed.
 *
 *  `console.error` is wrapped ONCE, here, rather than spied on per test: a test's own
 *  `vi.spyOn(console, "error")` sits on top of this wrapper and `vi.restoreAllMocks()` puts it
 *  back, where a spy installed in `beforeEach` would be removed by the first test that restores
 *  mocks. The warning is still printed, and the test that drew it fails in `afterEach` — not by a
 *  throw inside `console.error`, which React calls from inside its reconciler and would report as
 *  a render error from wherever it was caught.
 *
 *  Used by BOTH suites, jsdom's and the browser's: they render the same page from different books,
 *  so either can be the one whose fake serves an id twice. */
import { afterEach } from "vitest";

const SAME_KEY = "Encountered two children with the same key";
const seen: string[] = [];
const original = console.error.bind(console);

console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes(SAME_KEY)) {
    seen.push(`\`${String(args[1])}\``);
  }
  original(...args);
};

afterEach(() => {
  if (seen.length === 0) return;
  const said = [...new Set(seen)];
  seen.length = 0;
  throw new Error(`React drew two children with the same key: ${said.join(", ")}`);
});
