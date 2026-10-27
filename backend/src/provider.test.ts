/** Choosing the Provider, which happens once, before boot (ADR 0015).
 *
 *  The switch has one position today. What is tested here is that it IS a switch, and that an
 *  unknown name stops the service rather than starting it with no market data — the same rule
 *  every other mistyped setting follows (env.ts).
 */
import { describe, expect, it } from "vitest";

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
    for (const name of PROVIDERS) {
      expect(makeProvider(settingsFor({ provider: name, moomooWsKey: "k" })).name).toBe(name);
    }
  });
});
