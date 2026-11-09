/** The vendor registry: which market-data vendors this build carries, and how one is reached.
 *
 *  What is tested here is the SEAM rather than any vendor. Three of them existed before this file
 *  and each was wired its own way — a Provider factory, a `{ sources, close }` pair, a bare
 *  `Sources` with nothing to hang up — and `main.ts` hand-merged the three shapes while
 *  `routes/references.ts` merged two of them again. A fourth vendor meant touching both, and a
 *  vendor that later grew a `close` would have been hung up in one place and leaked in the other.
 *
 *  So the rules below are about the registry keeping its own promises: every vendor opens at most
 *  once, a vendor this build cannot reach opens nothing, the Provider is the SAME client when it
 *  also serves a Reference, and closing closes all of them.
 */
import { describe, expect, it, vi } from "vitest";

import { settingsFor } from "../env.ts";
import { PROVIDERS, VENDORS, makeProvider, openVendors } from "./index.ts";

/** Keeps `opend/client.ts`'s lazy import from logging while a Provider is merely constructed. */
function quietly<T>(fn: () => T): T {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* quiet */ });
  try {
    return fn();
  } finally {
    warn.mockRestore();
  }
}

describe("the registry", () => {
  it("names every vendor once", () => {
    const names = VENDORS.map((v) => v.name);
    expect(names).toEqual([...new Set(names)]);
    expect(names).toContain("moomoo");
    expect(names).toContain("ibkr");
    expect(names).toContain("yahoo");
  });

  it("agrees with the source names the API accepts", async () => {
    // `schemas/reference.ts` lists the vendors a Reference may NAME, and this lists the ones a
    // build can reach. A name in one and not the other is a Reference that validates and can
    // never be served, or a vendor nothing may ask for.
    const { SOURCES } = await import("../schemas/reference.ts");
    expect([...SOURCES].sort()).toEqual(VENDORS.map((v) => v.name).sort());
  });

  it("derives the Provider names from the vendors that can be one", () => {
    // the list the error message quotes and /health's name comes from, not a second list that can
    // disagree with the descriptors
    expect([...PROVIDERS]).toEqual(VENDORS.filter((v) => v.canBeProvider).map((v) => v.name));
  });

  it("says yahoo is not a candidate, because a Reference-only vendor cannot carry the alarms", () => {
    // It prices no option, so nothing the engine evaluates could be read from it. ADR 0019 allows
    // it for a Reference precisely because nothing alarms on one.
    expect(VENDORS.find((v) => v.name === "yahoo")?.canBeProvider).toBe(false);
    expect(PROVIDERS).not.toContain("yahoo");
  });
});

describe("choosing the Provider", () => {
  it("builds moomoo without reaching for a socket", () => {
    // constructing must be inert: the npm client is imported lazily and login is deferred, which
    // is what lets a test name a Provider at all (opend/client.ts)
    const provider = quietly(() =>
      makeProvider(settingsFor({ provider: "moomoo", moomooWsKey: "k" })));
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

  it("refuses a vendor that exists but may not be the Provider", () => {
    // yahoo is in VENDORS and reachable as a Reference source; naming it here must fail with the
    // same fatal error rather than booting an engine that cannot price an option
    expect(() => makeProvider(settingsFor({ provider: "yahoo" })))
      .toThrow(/unknown provider 'yahoo'/);
  });

  it("refuses a candidate this build cannot reach", () => {
    // `IBKR_HOST` unset. The vendor can be a Provider and this deployment has not configured it,
    // which is a different fault from an unknown name and must still stop the service: the
    // alternative is an engine whose every fetch throws.
    expect(() => makeProvider(settingsFor({ provider: "ibkr", ibkrHost: "" })))
      .toThrow(/IBKR_HOST/);
  });

  it("names every Provider it can build", () => {
    const configured = { moomooWsKey: "k", ibkrHost: "127.0.0.1" };
    for (const name of PROVIDERS) {
      expect(quietly(() => makeProvider(settingsFor({ provider: name, ...configured }))).name)
        .toBe(name);
    }
  });
});

describe("opening what this build carries", () => {
  it("opens the Provider and every configured source, and nothing else", () => {
    const open = quietly(() => openVendors(settingsFor({ provider: "moomoo", moomooWsKey: "k" })));
    // yahoo needs no configuration, so it is always there; ibkr has no host in these settings
    expect(Object.keys(open.sources).sort()).toEqual(["moomoo", "yahoo"]);
    expect(open.provider.name).toBe("moomoo");
    open.close();
  });

  it("adds a candidate vendor as a Reference source once it is configured", () => {
    // ADR 0019: IB Gateway is reached as a Reference source whether or not it is the Provider,
    // because a Reference alarms on nothing
    const open = quietly(() => openVendors(settingsFor({ ibkrHost: "127.0.0.1" })));
    expect(Object.keys(open.sources).sort()).toEqual(["ibkr", "moomoo", "yahoo"]);
    open.close();
  });

  it("opens no connection while opening a vendor", async () => {
    // A client that connected when it was built could not be named in a test at all, and a dead
    // port blocks indefinitely — which is why `open` must only construct. Proven against a port
    // nothing listens on: this must return rather than hang, and hanging up must not throw.
    const open = openVendors(settingsFor({ ibkrHost: "127.0.0.1", ibkrPort: 1 }));
    expect(Object.keys(open.sources)).toContain("ibkr");
    expect(() => open.close()).not.toThrow();
    // The MESSAGE, not merely a rejection. `rejects.toThrow()` with no matcher is what let the
    // unbound-method bug through: the call failed with a TypeError from inside the client and
    // this read as the dead port being reported. A fetch that fails must fail for its own reason.
    await expect(open.sources.ibkr!(["SPX"])).rejects.toThrow(/could not reach IB Gateway/);
  });

  it("calls a real vendor's client with its receiver intact", async () => {
    // The bug this is for: `sources[name] = client.fetchQuotes` unbinds `this`, so a vendor whose
    // client is a CLASS — IbkrClient is — threw "Cannot read properties of undefined" on its
    // first call. Found by booting the process, not by this suite, because every fake vendor in
    // this file is a closure and cannot reproduce it. So this one is a class on purpose.
    class Counting {
      readonly name = "classy";
      private asked = 0;
      async fetchQuotes(codes: string[]) {
        // reading `this` is the whole point: an unbound call cannot get here
        this.asked += codes.length;
        return { records: [{ code: String(this.asked) }], unknown: [] };
      }
      async reachable() { return true; }
      close() { /* nothing */ }
    }
    const vendor = {
      name: "classy", canBeProvider: true as const, open: () => new Counting(),
    };
    const open = openVendors(settingsFor({ provider: "classy" }), [vendor]);
    expect((await open.sources.classy!(["a", "b"])).records[0]!.code).toBe("2");
    // and the SAME instance answers both doors, which is what "one client either way" means
    expect((await open.provider.fetchQuotes(["c"])).records[0]!.code).toBe("3");
  });

  it("serves the Provider's own Reference rows from the SAME client", async () => {
    // Two connections to one gateway for the same data, each with its own client id and
    // handshake, is the trap ADR 0019 closed before it existed — and IB Gateway allows one
    // connection per client id, so the second would displace the first in silence.
    //
    // Asserted by asking BOTH doors and watching one client count the calls. This compared the
    // two function references instead, which stopped being the right question once the registry
    // had to wrap them to keep `this` — and a reference comparison would have been satisfied by
    // two wrappers around two different clients anyway.
    const asked: string[][] = [];
    const vendor = {
      name: "one",
      canBeProvider: true as const,
      open: () => ({
        name: "one",
        fetchQuotes: (codes: string[]) => {
          asked.push(codes);
          return Promise.resolve({ records: [], unknown: [] });
        },
        reachable: () => Promise.resolve(true),
        close: () => { /* nothing */ },
      }),
    };
    const open = openVendors(settingsFor({ provider: "one" }), [vendor]);
    await open.sources.one!(["from the strip"]);
    await open.provider.fetchQuotes(["from the sweep"]);
    expect(asked).toEqual([["from the strip"], ["from the sweep"]]);
  });

  it("opens a vendor once even when it is both the Provider and a Reference source", () => {
    const opened: string[] = [];
    const vendor = {
      name: "counted",
      canBeProvider: true as const,
      open: () => {
        opened.push("counted");
        return {
          name: "counted",
          fetchQuotes: () => Promise.resolve({ records: [], unknown: [] }),
          reachable: () => Promise.resolve(true),
          close: () => { /* nothing */ },
        };
      },
    };
    const open = openVendors(settingsFor({ provider: "counted" }), [vendor]);
    expect(opened).toEqual(["counted"]);
    // and it is registered as a source rather than skipped along with the second open
    expect(Object.keys(open.sources)).toEqual(["counted"]);
  });

  it("hangs up everything it opened", () => {
    const closed: string[] = [];
    const made = (name: string) => ({
      name,
      canBeProvider: true as const,
      open: () => ({
        name,
        fetchQuotes: () => Promise.resolve({ records: [], unknown: [] }),
        reachable: () => Promise.resolve(true),
        close: () => closed.push(name),
      }),
    });
    const open = openVendors(settingsFor({ provider: "one" }), [made("one"), made("two")]);
    open.close();
    expect(closed.sort()).toEqual(["one", "two"]);
  });

  it("closes the rest even when one vendor throws on the way out", () => {
    // every way out of the process goes through this (main.ts), and a vendor that throws while
    // hanging up must not leave the database open behind it
    const closed: string[] = [];
    const made = (name: string, bad = false) => ({
      name,
      canBeProvider: true as const,
      open: () => ({
        name,
        fetchQuotes: () => Promise.resolve({ records: [], unknown: [] }),
        reachable: () => Promise.resolve(true),
        close: () => {
          if (bad) throw new Error(`${name} refused to close`);
          closed.push(name);
        },
      }),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => { /* quiet */ });
    try {
      const open = openVendors(
        settingsFor({ provider: "first" }),
        [made("first", true), made("second")],
      );
      expect(() => open.close()).not.toThrow();
      expect(closed).toEqual(["second"]);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
