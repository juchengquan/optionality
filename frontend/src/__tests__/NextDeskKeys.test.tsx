/** j and k on the desk (#299): they move the selection through the table's rows in the order the
 *  table draws them, Enter opens the inspector on it and Escape closes it. None of them acts while
 *  the focus is somewhere a key is typed, or while a dialog or a form is open. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import type { HoldingWrites } from "../next/HoldingActions";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

const writes: HoldingWrites = { edited: () => {}, closed: () => {}, deleted: () => {} };

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    mode: "live", session: over.mode !== "review", privacy: false, entryStyle: "opportunity", writes, ...over,
  };
}

afterEach(() => {
  cleanup();
  document.cookie = "ui_pricemap=;path=/;max-age=0";
});

const row = (id: string) => document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;
const order = () => [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].map((r) => r.dataset.ref!);
const cursor = () => document.querySelector<HTMLElement>(".nxd-row[data-cursor]")?.dataset.ref ?? null;
const inspector = () => screen.queryByRole("complementary", { name: /^inspector:/ });
const press = (key: string, at: Element = document.activeElement ?? document.body, over: object = {}) =>
  fireEvent.keyDown(at, { key, ...over });

describe("moving the selection", () => {
  it("walks every row in the order drawn — across brackets and expiry groups — and stops at the ends", () => {
    render(<DeskBook {...props()} />);
    const seen: string[] = [];
    for (let i = 0; i < order().length + 2; i++) {
      press("j");
      seen.push(cursor()!);
    }
    expect(seen).toEqual([...order(), order().at(-1)!, order().at(-1)!]);
    const back: string[] = [];
    for (let i = 0; i < order().length + 1; i++) {
      press("k");
      back.push(cursor()!);
    }
    expect(back).toEqual([...order().slice(0, -1).reverse(), order()[0]!, order()[0]!]);
  });

  it("starts from the top on j and from the bottom on k", () => {
    const { unmount } = render(<DeskBook {...props()} />);
    press("j");
    expect(cursor()).toBe("h-calls");
    unmount();
    render(<DeskBook {...props()} />);
    press("k");
    expect(cursor()).toBe("q-unknown");
  });

  it("moves the focus to the row it lands on, without opening the inspector", () => {
    render(<DeskBook {...props()} />);
    press("j");
    press("j");
    expect(cursor()).toBe("r-calls");
    expect(inspector()).toBeNull();
    expect(row("r-calls").hasAttribute("data-selected")).toBe(false);
    expect(document.activeElement).toBe(row("r-calls").querySelector(".nxd-name"));
  });

  it("takes the inspector along when it is open", () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(within(row("h-puts")).getByRole("button", { name: "1218_P6400" }));
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1218_P6400");
    // the focus is in the inspector, on its heading: j still moves the table
    press("j");
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1231_IC");
    expect(row("h-ic").hasAttribute("data-selected")).toBe(true);
    press("k");
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1218_P6400");
    // and the focus stays in the inspector, where its reader is, rather than going to the row
    expect(inspector()!.contains(document.activeElement)).toBe(true);
  });
});

describe("Enter and Escape", () => {
  it("Enter opens the inspector on the selected row, and Escape closes it and keeps the place", async () => {
    const user = userEvent.setup();
    render(<DeskBook {...props()} />);
    await user.keyboard("jjj");
    expect(cursor()).toBe("h-puts");
    await user.keyboard("{Enter}");
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1218_P6400");
    expect(inspector()!.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(inspector()).toBeNull();
    expect(cursor()).toBe("h-puts");
    expect(document.activeElement).toBe(row("h-puts").querySelector(".nxd-name"));
    await user.keyboard("j");
    expect(cursor()).toBe("h-ic");
  });

  it("Enter opens it with the focus nowhere in particular too", () => {
    render(<DeskBook {...props()} />);
    press("j");
    (document.activeElement as HTMLElement).blur();
    press("Enter", document.body);
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
  });

  it("leaves Enter on another control to that control", () => {
    render(<DeskBook {...props()} />);
    press("j");
    const toggle = screen.getByRole("button", { name: "price map" });
    toggle.focus();
    press("Enter", toggle);
    expect(inspector()).toBeNull();
  });
});

describe("when they do nothing", () => {
  it("does nothing inside an input, a textarea, a select or an editable region", () => {
    render(
      <>
        <DeskBook {...props()} />
        <input aria-label="a box" />
        <textarea aria-label="a text" />
        <select aria-label="a choice"><option>x</option></select>
        <div aria-label="editable" contentEditable suppressContentEditableWarning><span>words</span></div>
      </>,
    );
    for (const name of ["a box", "a text", "a choice"]) {
      const el = screen.getByLabelText(name);
      el.focus();
      for (const key of ["j", "k", "Enter"]) expect(press(key, el)).toBe(true);
    }
    const inside = screen.getByLabelText("editable").querySelector("span")!;
    expect(press("j", inside)).toBe(true);
    expect(cursor()).toBeNull();
    expect(inspector()).toBeNull();
  });

  it("does nothing with a modifier held, which makes it another chord", () => {
    render(<DeskBook {...props()} />);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(press("j", document.body, mod)).toBe(true);
    }
    expect(cursor()).toBeNull();
  });

  it("does nothing while an input method is composing a word", () => {
    render(<DeskBook {...props()} />);
    expect(press("j", document.body, { isComposing: true })).toBe(true);
    expect(press("j", document.body, { keyCode: 229 })).toBe(true);
    expect(cursor()).toBeNull();
  });

  it("does nothing with a key something earlier already handled", () => {
    render(<><DeskBook {...props()} /><div tabIndex={-1} aria-label="handler" onKeyDown={(e) => e.preventDefault()} /></>);
    press("j", screen.getByLabelText("handler"));
    expect(cursor()).toBeNull();
  });

  it("does nothing while a dialog is open", () => {
    render(<><DeskBook {...props()} /><div role="dialog" aria-label="Settings">settings</div></>);
    expect(press("j", document.body)).toBe(true);
    expect(cursor()).toBeNull();
  });

  it("does nothing while a form is open in the inspector, so a draft is never carried off", async () => {
    const user = userEvent.setup();
    render(<DeskBook {...props()} />);
    fireEvent.click(within(row("h-ic")).getByRole("button", { name: "1231_IC" }));
    await user.click(within(inspector()!).getByRole("button", { name: "Close…" }));
    screen.getByRole("form", { name: "close 1231_IC" });
    // the focus leaves the form's boxes, and still j does not move the inspector from under it
    (document.activeElement as HTMLElement).blur();
    expect(press("j", document.body)).toBe(true);
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1231_IC");
    // Escape inside the form is the form's: it closes the form and leaves the inspector open
    await user.click(within(inspector()!).getByRole("button", { name: "Close…" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("form", { name: "close 1231_IC" })).toBeNull();
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1231_IC");
    // and with the form gone, j moves again
    press("j", document.body);
    expect(inspector()!.getAttribute("aria-label")).toBe("inspector: 1231_IC");
    expect(cursor()).toBe("r-ic");
  });

  it("does nothing while the add panel is open", () => {
    render(<><DeskBook {...props()} /><section className="nx-add-panel" aria-label="add a spread or contract" /></>);
    expect(press("j", document.body)).toBe(true);
    expect(cursor()).toBeNull();
  });

  it("leaves no listener behind once unmounted", () => {
    const { unmount } = render(<DeskBook {...props()} />);
    unmount();
    expect(press("j", document.body)).toBe(true);
  });
});
