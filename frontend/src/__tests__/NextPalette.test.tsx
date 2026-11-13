/** The desk's ⌘K palette (#299) on the whole page, against a service that answers every route
 *  (`testing/holdingService.ts`): a proper dialog — focus held inside it, Escape giving the focus
 *  back, arrows and Enter choosing, its result count said — that finds a spread, a Monitor or a
 *  holding and lands on it, and runs the page's actions. The phone registers none of it.
 *
 *  Every action reached with real keystrokes in a real browser is `__browser__/NextPalette.test.tsx`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { holdingService } from "../testing/holdingService";

const COOKIES = ["ui_arrangement", "ui_privacy", "ui_cols_combo", "ui_pricemap"];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const n of COOKIES) document.cookie = `${n}=;path=/;max-age=0`;
});

/** Noon in New York, in the session: the page opens in LIVE. */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");

async function open(arrangement: "desk" | "phone" = "desk", privacy = false) {
  vi.useFakeTimers({ toFake: ["Date"], now: IN_SESSION });
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  if (privacy) document.cookie = "ui_privacy=on;path=/";
  const service = holdingService();
  vi.stubGlobal("fetch", service.fetch);
  const user = userEvent.setup();
  const view = render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
  return { user, service, view };
}

/** Off a Mac (jsdom's platform is empty), the chord is Ctrl+K. */
const chord = (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Control>}k{/Control}");

const palette = () => screen.getByRole("dialog", { name: "commands" });
const box = () => within(palette()).getByRole("combobox");
const options = () => within(palette()).getAllByRole("option");
const optionNames = () => options().map((o) => o.querySelector("[data-label]")!.textContent);
const row = (id: string) => document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;
const inspector = () => screen.queryByRole("complementary", { name: /^inspector:/ });

/** Types `q` and chooses the first option it leaves, by the keyboard. */
async function run(user: ReturnType<typeof userEvent.setup>, q: string) {
  await chord(user);
  await user.type(box(), q);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull());
}

describe("opening and closing it", () => {
  it("opens on Ctrl+K off a Mac, as a dialog whose combobox has the focus", async () => {
    const { user } = await open();
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
    await chord(user);
    expect(document.activeElement).toBe(box());
    expect(box().getAttribute("aria-expanded")).toBe("true");
    const list = within(palette()).getByRole("listbox");
    expect(box().getAttribute("aria-controls")).toBe(list.id);
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
  });

  it("opens on ⌘K on a Mac, and Ctrl+K there is left to the text field", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { user } = await open();
    const ctrl = fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(ctrl).toBe(true);
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(palette()).toBeTruthy();
  });

  it("takes its chord from the browser, which would otherwise act on it too", async () => {
    await open();
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(false);
    expect(palette()).toBeTruthy();
  });

  it("takes no chord but its own: a plain k, and Ctrl+Shift+K, are not swallowed", async () => {
    await open();
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "l", ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
  });

  it("opens from its button in the header too, and says its chord", async () => {
    const { user } = await open();
    const button = screen.getByRole("button", { name: /^find and act/ });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+K");
    await user.click(button);
    expect(palette()).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("closes on Escape and gives the focus back where it was", async () => {
    const { user } = await open();
    const name = within(row("w-dec31")).getByRole("button", { name: "1231_C7600" });
    name.focus();
    await chord(user);
    await user.type(box(), "7150");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(name));
    // Escape was the palette's: no inspector was opened or closed by it
    expect(inspector()).toBeNull();
  });

  it("holds the focus inside while it is open", async () => {
    const { user } = await open();
    await chord(user);
    await user.tab();
    expect(palette().contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(palette().contains(document.activeElement)).toBe(true);
  });

  it("starts empty every time it opens", async () => {
    const { user } = await open();
    await chord(user);
    await user.type(box(), "7150");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull());
    await chord(user);
    expect((box() as HTMLInputElement).value).toBe("");
  });
});

describe("finding by text", () => {
  it("narrows as it is typed, and says how many it found", async () => {
    const { user } = await open();
    await chord(user);
    const status = within(palette()).getByRole("status");
    expect(status.textContent).toMatch(/^\d+ results$/);
    await user.type(box(), "7150");
    expect(optionNames()).toEqual(["1218_P7150", "261218 7150P"]);
    expect(status.textContent).toBe("2 results");
    await user.type(box(), " delta");
    expect(status.textContent).toBe("1 result");
    await user.type(box(), "zzz");
    expect(status.textContent).toBe("nothing matches");
    expect(within(palette()).queryAllByRole("option")).toEqual([]);
  });

  it("moves through what it found with the arrows, and Enter jumps to it", async () => {
    const { user } = await open();
    await chord(user);
    await user.type(box(), "7150");
    await user.keyboard("{ArrowDown}");
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    // it stops at the ends rather than wrapping past them
    await user.keyboard("{ArrowDown}");
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull());
    // selected in the table, and opened in the inspector, which has the focus
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 261218 7150P"));
    expect(row("w-dec18-delta").hasAttribute("data-selected")).toBe(true);
    await waitFor(() => expect(inspector()!.contains(document.activeElement)).toBe(true));
  });

  it("lands on a holding, on a rule under a holding, and on a quarantined rule", async () => {
    const { user } = await open();
    await run(user, "1231_IC holding");
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1231_IC"));
    await run(user, "7300 Monitor");
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300"));
    expect(row("r-calls").hasAttribute("data-selected")).toBe(true);
    await run(user, "8300");
    await waitFor(() => expect(row("q-unknown").hasAttribute("data-selected")).toBe(true));
  });

  it("lands on the row already open, the focus going back into its inspector", async () => {
    const { user } = await open();
    await run(user, "1231_C7600");
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1231_C7600"));
    within(row("w-dec04")).getByRole("button", { name: "1204_P6900" }).focus();
    await run(user, "1231_C7600");
    await waitFor(() => expect(inspector()!.contains(document.activeElement)).toBe(true));
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1231_C7600");
  });

  it("lands on a muted rule where it is listed: the folded list opened and the rule focused", async () => {
    const { user } = await open();
    const folded = document.querySelector<HTMLDetailsElement>("details.nxd-muted")!;
    expect(folded.open).toBe(false);
    await run(user, "muted");
    await waitFor(() => expect(folded.open).toBe(true));
    const listed = folded.querySelector<HTMLElement>('li[data-ref="m-muted"]')!;
    await waitFor(() => expect(document.activeElement).toBe(listed));
  });

  it("shows no money and no count of contracts under privacy", async () => {
    const { user } = await open("desk", true);
    await chord(user);
    const said = palette().textContent!;
    expect(said).toMatch(/1231_IC/);
    expect(said).not.toMatch(/\$/);
    expect(said).not.toMatch(/×/);
  });
});

describe("its actions", () => {
  it("adds a spread: the add panel opens with the focus in it", async () => {
    const { user } = await open();
    await run(user, "add a spread");
    const panel = await screen.findByRole("region", { name: "add a spread or contract" });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  });

  it("edits the selected Monitor: its editor opens in the inspector", async () => {
    const { user } = await open();
    await run(user, "7150 delta");
    await run(user, "edit the selected");
    const form = await screen.findByRole("form", { name: "editing 261218 7150P delta" });
    expect(inspector()!.contains(form)).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText("threshold")));
  });

  it("closes the selected holding: its close form opens in the inspector", async () => {
    const { user } = await open();
    await run(user, "1218_C7300 holding");
    await run(user, "close the selected");
    const form = await screen.findByRole("form", { name: "close 1218_C7300" });
    expect(inspector()!.contains(form)).toBe(true);
    await waitFor(() => expect(form.contains(document.activeElement)).toBe(true));
  });

  it("explains the two that need a selection, and runs neither without one", async () => {
    const { user } = await open();
    await chord(user);
    await user.type(box(), "selected");
    const [edit, close] = options();
    expect(edit!.getAttribute("aria-disabled")).toBe("true");
    expect(edit!.textContent).toMatch(/nothing is selected/);
    expect(close!.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Enter}");
    // still open, and nothing opened behind it
    expect(palette()).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("explains closing when the selection is a Monitor, not a holding", async () => {
    const { user } = await open();
    await run(user, "1218_P7150");
    await chord(user);
    await user.type(box(), "close the selected");
    expect(options()[0]!.textContent).toMatch(/a Monitor is selected, not a holding/);
    expect(options()[0]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("switches the mode, and back", async () => {
    const { user } = await open();
    const page = document.querySelector<HTMLElement>(".nx")!;
    expect(page.dataset.mode).toBe("live");
    await run(user, "switch to review");
    await waitFor(() => expect(page.dataset.mode).toBe("review"));
    await run(user, "switch to live");
    await waitFor(() => expect(page.dataset.mode).toBe("live"));
  });

  it("forces the arrangement through the page's own setting", async () => {
    const { user } = await open();
    await run(user, "arrangement: by the screen");
    // jsdom has no width, so by the screen's width this is the phone
    await waitFor(() => expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("phone"));
    expect(document.cookie).toMatch(/ui_arrangement=auto/);
  });
});

describe("the phone gets nothing new", () => {
  it("registers no chord: no palette opens, and the keystroke is left to the browser", async () => {
    await open("phone");
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "k", metaKey: true })).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /^find and act/ })).toBeNull();
  });

  it("registers no j, k or Enter: nothing is selected or opened", async () => {
    await open("phone");
    for (const key of ["j", "j", "k", "Enter"]) {
      expect(fireEvent.keyDown(document.body, { key })).toBe(true);
    }
    expect(document.querySelector("[data-cursor], [data-selected]")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("drops the chord the moment the desk becomes the phone", async () => {
    const { user } = await open();
    await run(user, "arrangement: phone");
    await waitFor(() => expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("phone"));
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
  });
});

describe("nothing outlives the page", () => {
  it("leaves no listener behind once unmounted", async () => {
    const { view } = await open();
    view.unmount();
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "j" })).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("after review (#329)", () => {
  it("lets a composing input method keep Enter and the arrows", async () => {
    const { user } = await open();
    await chord(user);
    await user.type(box(), "7150");
    fireEvent.keyDown(box(), { key: "ArrowDown", keyCode: 229 });
    fireEvent.keyDown(box(), { key: "ArrowDown", isComposing: true });
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(palette()).toBeTruthy();
    expect(inspector()).toBeNull();
  });

  it("names the active option by what it is, so a new top result is a new one", async () => {
    const { user } = await open();
    await chord(user);
    await user.type(box(), "7150");
    const first = box().getAttribute("aria-activedescendant");
    expect(document.getElementById(first!)!.textContent).toMatch(/1218_P7150/);
    await user.type(box(), " delta");
    const now = box().getAttribute("aria-activedescendant");
    expect(now).not.toBe(first);
    expect(document.getElementById(now!)!.textContent).toMatch(/261218 7150P/);
  });

  it("says out loud why a closed action did nothing", async () => {
    const { user } = await open();
    await chord(user);
    await user.type(box(), "close the selected");
    const said = within(palette()).getByTestId("refusal");
    expect(said.getAttribute("aria-live")).toBe("assertive");
    expect(said.textContent).toBe("");
    await user.keyboard("{Enter}");
    expect(said.textContent).toBe("Close the selected holding: nothing is selected");
    // typing again clears it
    await user.type(box(), "x");
    expect(said.textContent).toBe("");
  });

  it("puts the focus in an editor that is already open rather than leave it on the page", async () => {
    const { user } = await open();
    await run(user, "7150 delta");
    await run(user, "edit the selected");
    const form = await screen.findByRole("form", { name: "editing 261218 7150P delta" });
    (document.activeElement as HTMLElement).blur();
    await run(user, "edit the selected");
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText("threshold")));
    expect(screen.getByRole("form", { name: "editing 261218 7150P delta" })).toBe(form);
  });

  it("puts the focus in a close form that is already open", async () => {
    const { user } = await open();
    await run(user, "1218_C7300 holding");
    await run(user, "close the selected");
    const form = await screen.findByRole("form", { name: "close 1218_C7300" });
    (document.activeElement as HTMLElement).blur();
    await run(user, "close the selected");
    await waitFor(() => expect(document.activeElement).toBe(form.querySelector("input")));
  });

  it("will not carry a draft off: finds, and the phone, wait until the open form is done", async () => {
    const { user } = await open();
    await run(user, "1218_C7300 holding");
    await run(user, "close the selected");
    const form = await screen.findByRole("form", { name: "close 1218_C7300" });
    await chord(user);
    await user.type(box(), "7150");
    for (const o of options().filter((x) => x.textContent!.includes("go to"))) {
      expect(o.getAttribute("aria-disabled")).toBe("true");
      expect(o.textContent).toMatch(/finish or cancel the open form first/);
    }
    await user.keyboard("{Enter}");
    expect(palette()).toBeTruthy();
    expect(within(palette()).getByTestId("refusal").textContent)
      .toBe("1218_P7150: finish or cancel the open form first");
    await user.clear(box());
    await user.type(box(), "arrangement: phone");
    expect(options()[0]!.getAttribute("aria-disabled")).toBe("true");
    // a mode switch keeps the form, so it is offered, and the form is still there after it
    await user.clear(box());
    await user.type(box(), "switch to review");
    expect(options()[0]!.getAttribute("aria-disabled")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector(".nx")!.getAttribute("data-mode")).toBe("review"));
    expect(screen.getByRole("form", { name: "close 1218_C7300" })).toBe(form);
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
  });

  it("will not open another form over the one being typed into", async () => {
    const { user } = await open();
    await run(user, "1218_C7300 holding");
    await user.click(within(inspector()!).getByRole("button", { name: "Edit" }));
    await chord(user);
    await user.type(box(), "close the selected");
    expect(options()[0]!.textContent).toMatch(/finish or cancel the open form first/);
  });

  it("takes Ctrl+K over another dialog from the browser, and opens nothing over it", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    expect(fireEvent.keyDown(document.activeElement ?? document.body, { key: "k", ctrlKey: true })).toBe(false);
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
  });

  it("forgets the desk's selection on the phone, and says how to come back", async () => {
    const { user } = await open();
    await run(user, "1231_IC holding");
    await waitFor(() => expect(inspector()).not.toBeNull());
    await run(user, "arrangement: phone");
    await screen.findByText(/Settings switches it back/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.selectOptions(await screen.findByLabelText("arrangement"), "desk");
    await waitFor(() => expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("desk"));
    // back on the desk: nothing selected, no inspector reopened on the old row
    await waitFor(() => expect(document.querySelector(".nxd")).not.toBeNull());
    expect(inspector()).toBeNull();
    expect(document.querySelector("[data-cursor], [data-selected]")).toBeNull();
  });
});

