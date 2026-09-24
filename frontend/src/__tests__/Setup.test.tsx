import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "@base-ui/react/select";
import { describe, expect, it } from "vitest";

/** A smoke test for the toolchain phases 2-4 are built on: user-event driving a Base UI
 *  popup, with the result rendered through a portal outside the tree Testing Library
 *  rendered. If this breaks, every later phase's tests break with it and the cause will not
 *  be obvious from their failures.
 *
 *  Phase 0 planned a setup file stubbing ResizeObserver, matchMedia and friends, on the
 *  grounds that jsdom lacks them. jsdom does lack them — but Base UI 1.8.0 guards their
 *  absence itself, verified by running this and the phase 2 components with the stubs
 *  removed. The stubs were dropped rather than shipped dead. If a later phase does crash
 *  inside a positioning engine, that is what this note is for. */
describe("the test environment", () => {
  it("can open a Base UI popup", async () => {
    render(
      <Select.Root>
        <Select.Trigger>
          <Select.Value>pick</Select.Value>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner>
            <Select.Popup>
              <Select.Item value="abs">abs</Select.Item>
              <Select.Item value="signed">signed</Select.Item>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>,
    );

    await userEvent.click(screen.getByText("pick"));

    // the options live in a portal, outside the rendered tree — screen still finds them
    await waitFor(() => expect(screen.getByText("signed")).toBeTruthy());
  });
});
