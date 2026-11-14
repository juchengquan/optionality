/** Editing a Monitor in place from the desk's inspector (#292), in a real layout engine, against a
 *  service that writes (`testing/editBook.ts`): every field sent, the sentence coming back as the
 *  service's with its new distance, a refusal said VISIBLY beside the field it is about, and mute,
 *  unmute and delete — delete asking first. The phone is `NextEdit.iphone.test.tsx`; the behaviour
 *  in detail is the jsdom suite's (`__tests__/NextMonitorEdit.test.tsx`).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { serveEditing } from "../testing/editBook";
import { settle } from "./nextBook";

/* The page's clock, on a day before every expiry in the owner's book but the expired rule's: a rule
   past its expiry offers no unmute (#292), so a suite on the real clock would change its answers
   when December came. Only Date is faked; the page's timers run. */
beforeEach(() => { vi.setSystemTime(new Date("2026-11-10T15:00:00Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const DELTA = "261218 7150P delta";

async function openDesk(refuse?: Parameters<typeof serveEditing>[0]) {
  await page.viewport(1440, 900);
  const writes = serveEditing(refuse);
  render(<Next />);
  await settle();
  return writes;
}

const inspector = () => screen.getByRole("complementary", { name: /^inspector/ });

/** The delta rule under the 12-18 put spread, opened in the inspector. */
async function inspectDelta() {
  await userEvent.click(screen.getByRole("button", { name: "261218 7150P" }));
  return inspector();
}

/** Whether `el` is on the screen and on top: nothing drawn over its middle. */
function visible(el: HTMLElement): boolean {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const on = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0
    && r.right <= document.documentElement.clientWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  return on && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
}

describe("editing a Monitor from the inspector", () => {
  it("saves a new threshold, and the sentence comes back with the service's distance", async () => {
    const writes = await openDesk();
    const panel = await inspectDelta();
    expect(within(panel).getByText(/^\|delta\| ≥ 0\.2 — now -0\.170, 0\.030 away$/)).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: `edit ${DELTA}` }));
    const form = within(panel).getByRole("form", { name: `editing ${DELTA}` });
    await userEvent.fill(within(form).getByLabelText("threshold"), "0.3");
    // the draft follows the typing; the distance is still the saved rule's until the service says
    // drawn short (#388), and said in words
    expect(within(form).getByTestId("draft").querySelector(".nx-rule-short")!.textContent).toBe("|Δ| ≥ 0.3");
    expect(within(form).getByTestId("draft").querySelector(".sr-only")!.textContent).toBe("|delta| ≥ 0.3");
    expect(within(form).getByTestId("served").querySelector(".nx-rule-short")!.textContent).toMatch(/↑0\.030$/);
    expect(within(form).getByTestId("served").querySelector(".sr-only")!.textContent).toMatch(/0\.030 away$/);
    await userEvent.click(within(form).getByRole("button", { name: "save" }));

    await waitFor(() => expect(within(inspector()).queryByRole("form")).toBeNull());
    expect(writes).toEqual([{ what: `PATCH /monitors/w-dec18-delta`, body: { threshold: 0.3 } }]);
    // the service's figure, from the reload: 0.3 − |−0.17|
    expect(within(inspector()).getByText(/^\|delta\| ≥ 0\.3 — now -0\.170, 0\.130 away$/)).toBeTruthy();
    expect([...inspector().querySelectorAll(".nx-rule-short")].map((el) => el.textContent))
      .toContain("|Δ| ≥ 0.30   \u22120.170  ↑0.130");
  });

  it("sends every field it can change, as the route takes them", async () => {
    const writes = await openDesk();
    const panel = await inspectDelta();
    await userEvent.click(within(panel).getByRole("button", { name: `edit ${DELTA}` }));
    const form = within(panel).getByRole("form", { name: `editing ${DELTA}` });
    await userEvent.selectOptions(within(form).getByLabelText("what it watches"), "option_vega");
    await userEvent.selectOptions(within(form).getByLabelText("direction"), "below");
    await userEvent.selectOptions(within(form).getByLabelText("compare"), "signed");
    await userEvent.fill(within(form).getByLabelText("threshold"), "-0.5");
    expect(within(form).getByTestId("draft").querySelector(".sr-only")!.textContent).toBe("vega ≤ -0.5");
    expect(within(form).getByTestId("draft").querySelector(".nx-rule-short")!.textContent).toBe("ν ≤ -0.5");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toEqual({ field: "option_vega", direction: "below", compare: "signed", threshold: -0.5 });
  });

  it("says a signed threshold of 0 beside the threshold, on screen and on top", async () => {
    const refusal = "signed threshold cannot be 0; use e.g. ±0.01";
    const writes = await openDesk((_, body) => body.threshold === 0 ? refusal : null);
    const panel = await inspectDelta();
    await userEvent.click(within(panel).getByRole("button", { name: `edit ${DELTA}` }));
    const form = within(panel).getByRole("form", { name: `editing ${DELTA}` });
    await userEvent.selectOptions(within(form).getByLabelText("compare"), "signed");
    await userEvent.fill(within(form).getByLabelText("threshold"), "0");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));

    const alert = await within(form).findByRole("alert");
    expect(writes).toHaveLength(1);
    expect(alert.textContent).toBe(refusal);
    expect(visible(alert)).toBe(true);
    // beside the box it is about: straight under it, in its column
    const box = within(form).getByLabelText("threshold").getBoundingClientRect();
    const said = alert.getBoundingClientRect();
    expect(said.top).toBeGreaterThanOrEqual(box.bottom - 0.5);
    expect(said.top - box.bottom).toBeLessThan(16);
    expect(Math.abs(said.left - box.left)).toBeLessThan(2);
  });
});

describe("mute, unmute and delete from the desk", () => {
  it("mutes a rule from the inspector, and unmutes it from the muted list", async () => {
    const writes = await openDesk();
    const panel = await inspectDelta();
    await userEvent.click(within(panel).getByRole("button", { name: `mute ${DELTA}` }));
    await waitFor(() => expect(writes).toHaveLength(1));
    // the inspector went with the row; the focus is somewhere a keyboard can go on from, not the body
    await waitFor(() => expect(document.activeElement?.matches("h2, h3, h4, summary")).toBe(true));
    // muted, it leaves the table, and the inspector with it; it is in the muted list instead
    const muted = await screen.findByText(/^Muted and expired · /);
    await userEvent.click(muted);
    const list = muted.closest("details")!;
    await userEvent.click(within(list).getByRole("button", { name: `unmute ${DELTA}` }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map((w) => [w.what, w.body])).toEqual([
      ["PATCH /monitors/w-dec18-delta", { enabled: false }],
      ["PATCH /monitors/w-dec18-delta", { enabled: true }],
    ]);
  });

  it("asks before deleting, and deletes on the answer", async () => {
    const writes = await openDesk();
    const panel = await inspectDelta();
    await userEvent.click(within(panel).getByRole("button", { name: `delete ${DELTA}` }));
    const ask = within(panel).getByRole("group", { name: `delete ${DELTA}?` });
    expect(visible(ask)).toBe(true);
    expect(writes).toEqual([]);
    await userEvent.click(within(ask).getByRole("button", { name: "delete it" }));
    await waitFor(() => expect(writes).toEqual([{ what: "DELETE /monitors/w-dec18-delta", body: null }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "261218 7150P" })).toBeNull());
  });

  it("switches a quarantined rule back on only after saying why it was switched off", async () => {
    const writes = await openDesk();
    await userEvent.click(screen.getByRole("button", { name: "261211 8000C" }));
    const panel = inspector();
    await userEvent.click(within(panel).getByRole("button", { name: "switch 261211 8000C delta back on" }));
    const ask = within(panel).getByRole("group", { name: "switch 261211 8000C delta back on?" });
    expect(ask.textContent).toMatch(/the provider does not know its contract US\.SPXW261211C8300000/);
    expect(writes).toEqual([]);
    await userEvent.click(within(ask).getByRole("button", { name: "switch it on" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/q-unknown", body: { enabled: true } }]));
  });

  it("says when an expired rule is deleted, from the retention the service serves", async () => {
    await openDesk();
    await userEvent.click(await screen.findByText(/^Muted and expired · /));
    expect(screen.getByText("expired 2026-11-06 — the service deletes it on 2026-11-12")).toBeTruthy();
  });
});
