/** Choosing the Provider, which happens once, before boot (ADR 0015).
 *
 *  What is tested here is that it IS a switch — every Provider in the list can be built, and
 *  building one costs no connection — and that an unknown name stops the service rather than
 *  starting it with no market data, the same rule every other mistyped setting follows (env.ts).
 */
import { describe, expect, it, vi } from "vitest";

import { settingsFor } from "./env.ts";
import { PROVIDERS, makeProvider } from "./provider.ts";

describe("choosing a Provider", () => {
  it("builds moomoo without reaching for a socket", () => {
    // constructing must be inert: the npm client is imported lazily and login is deferred, which
    // is what lets a test name a Provider at all (opend/client.ts)
    const provider = makeProvider(settingsFor({ provider: "moomoo", moomooWsKey: "k" }));
    expect(provider.name).toBe("moomoo");
    expect(typeof provider.fetchQuotes).toBe("function");
  });

  it("builds ibkr without reaching for the gateway", () => {
    // constructing must be inert for the same reason moomoo's is: this is a test suite, and a
    // Provider that opened a connection on construction could not be named in one at all
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* its own test */ });
    try {
      const provider = makeProvider(settingsFor({ provider: "ibkr" }));
      expect(provider.name).toBe("ibkr");
      expect(typeof provider.fetchQuotes).toBe("function");
    } finally {
      warn.mockRestore();
    }
  });

  it("says ibkr is experimental on the way up", () => {
    // #170 ships a client that has never met a gateway: every field id and endpoint comes from
    // the reference and is proved against a stub. The boot log is where the owner would find that
    // out; a comment in the source is not.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* quiet */ });
    try {
      makeProvider(settingsFor({ provider: "ibkr" }));
      expect(warn.mock.calls.flat().join(" ")).toMatch(/EXPERIMENTAL/);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a name it does not know, naming the ones it does", () => {
    // fatal on purpose, as a mistyped MONITOR_INTERVAL_SECONDS is: a service that starts with no
    // Provider has no market data, no alarms, and a dashboard full of dashes
    expect(() => makeProvider(settingsFor({ provider: "ibkr-maybe" })))
      .toThrow(/unknown provider 'ibkr-maybe'.*moomoo/);
  });

  it("refuses a name set to nothing rather than falling back", () => {
    expect(() => makeProvider(settingsFor({ provider: "" }))).toThrow(/unknown provider/);
  });

  it("names every Provider it can build", () => {
    // the list /health's name comes from and the error message quotes; a Provider added to the
    // switch and not to the list would be unannounceable
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* quiet */ });
    try {
      for (const name of PROVIDERS) {
        expect(makeProvider(settingsFor({ provider: name, moomooWsKey: "k" })).name).toBe(name);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
