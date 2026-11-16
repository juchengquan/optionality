/** `main.tsx`'s own tree: the page drawn inside `PageBoundary`, so a render error nothing nearer
 *  caught says so and offers a reload, where it left a blank page. Loaded as the browser loads it —
 *  the module itself, rendering into `#root` — so taking the boundary out of `main.tsx` fails here. */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../Next", () => ({
  Next: () => { throw new Error("a book that cannot be drawn"); },
}));

const reload = vi.fn();
const location = window.location;

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: location });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("says the page hit an error, and reloads it on Reload", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(window, "location", { configurable: true, value: { ...location, reload } });
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => { await import("../main"); });
  const alert = await waitFor(() => screen.getByRole("alert"));
  expect(alert.querySelector("p")!.textContent).toBe(
    "The page hit an error — reload to continue. The service and its alarms are not affected.");
  // the raw text is detail, folded under the plain words
  expect(alert.querySelector("details code")!.textContent).toBe("a book that cannot be drawn");
  await act(async () => { screen.getByRole("button", { name: "Reload" }).click(); });
  expect(reload).toHaveBeenCalledOnce();
});
