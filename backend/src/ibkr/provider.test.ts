import { describe, expect, it } from "vitest";

import { ibkrSource } from "./provider.ts";
import { settingsFor } from "../env.ts";

/** Whether the source exists at all, which is a question about configuration rather than about
 *  IB Gateway: a Reference naming `ibkr` with no host set gets a dash saying so, and the service
 *  never opens a connection nobody asked for. */

describe("the source", () => {
  it("is absent unless a host is configured", () => {
    // the default. A Reference naming ibkr then reads "no ibkr client in this build", which is
    // the honest answer rather than a blank
    expect(ibkrSource(settingsFor({})).sources).toEqual({});
  });

  it("appears under its vendor name once one is", () => {
    const { sources } = ibkrSource(settingsFor({ ibkrHost: "127.0.0.1" }));
    expect(Object.keys(sources)).toEqual(["ibkr"]);
    expect(typeof sources.ibkr).toBe("function");
  });

  it("opens nothing on construction", () => {
    // the same rule the moomoo provider follows: a client that connected when it was built could
    // not be named in a test at all, and a dead port blocks indefinitely
    const made = ibkrSource(settingsFor({ ibkrHost: "127.0.0.1", ibkrPort: 1 }));
    expect(Object.keys(made.sources)).toEqual(["ibkr"]);
    made.close();
  });

  it("is closable whether or not anything was opened", () => {
    expect(() => ibkrSource(settingsFor({})).close()).not.toThrow();
  });
});
