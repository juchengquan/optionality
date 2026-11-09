/** Every market-data vendor this build carries, and the one seam they are reached through.
 *
 *  ## Why this exists
 *
 *  There were three vendors and three shapes. moomoo was a factory returning a Provider; IBKR was
 *  a function returning `{ sources, close }`; Yahoo was a bare `Sources` with nothing to hang up.
 *  `main.ts` merged the three by hand — `{ sources: { ...ibkr.sources, ...yahooSource() }, close:
 *  ibkr.close }` — and `routes/references.ts` merged two of them again. Nothing was wrong with
 *  the service that produced; what was wrong is what it cost to change. A fourth vendor meant
 *  editing both merges, and a vendor that later grew a `close` would have been hung up in one
 *  place and leaked in the other, because the merge named `ibkr.close` specifically.
 *
 *  So a vendor is now a DESCRIPTOR, and adding one is a file beside its client plus a line in the
 *  list below. Nothing else in the service learns its name.
 *
 *  ## The two kinds, and why they are a union rather than a flag
 *
 *  A vendor that may be the Provider must answer `reachable` — `/health` asks it while nothing
 *  has been fetched yet. A Reference-only vendor must not have to: Yahoo has no gateway to probe,
 *  and a `reachable: () => true` written to satisfy an interface is a lie the dashboard would
 *  print. The discriminated union lets the compiler ask for the method exactly where it is
 *  meaningful, so neither vendor has to pretend.
 *
 *  Reference-only is a statement about PRICING, not about trust: Yahoo quotes index levels and no
 *  option, so nothing the engine evaluates could come from it. ADR 0019 allows it for a Reference
 *  precisely because a Reference alarms on nothing.
 *
 *  ## What is NOT here
 *
 *  Anything about the fields a vendor supplies. That depends on the account it speaks for rather
 *  than on its code, so it is observed and never declared — a silent figure is found by the sweep
 *  and quarantined (ADR 0015, #167).
 */
import type { Settings } from "../env.ts";
import { ibkrVendor } from "./ibkr/vendor.ts";
import { moomooVendor } from "./opend/vendor.ts";
import type { ProviderClient, VendorClient } from "../ports.ts";
import type { QuoteFetcher } from "../quotes.ts";
import type { Sources } from "../references.ts";
import { yahooVendor } from "./yahoo/vendor.ts";

interface Described {
  /** The vendor's own name. A Reference's `source` column holds this, `schemas/reference.ts`
   *  validates against it, and `/health` prints it for the Provider. */
  readonly name: string;
  /** The variable that turns this vendor on, where one is needed — quoted when the Provider is
   *  named and cannot be reached, so the log says what to set rather than that something is
   *  missing. Absent for a vendor that needs no configuration. */
  readonly configuredBy?: string;
}

/** A vendor that may be the one Provider: its client can also say whether its gateway is there. */
export interface ProviderVendor extends Described {
  readonly canBeProvider: true;
  /** The client, or null where this build cannot reach the vendor — a blank `IBKR_HOST`. Must
   *  open nothing: a client that connected when it was built could not be named in a test, and a
   *  dead port blocks indefinitely (`opend/client.ts`). */
  open(settings: Settings): ProviderClient | null;
}

/** A vendor that can only ever serve a Reference. Owes no `reachable`, because nothing asks. */
export interface ReferenceVendor extends Described {
  readonly canBeProvider: false;
  open(settings: Settings): VendorClient | null;
}

export type Vendor = ProviderVendor | ReferenceVendor;

/** Every vendor this build carries. Adding one is a line here and a file beside its client.
 *
 *  Held to `schemas/reference.ts`'s `SOURCES` by a test: a name a Reference may be created with
 *  and no vendor to serve it is a row that validates and then shows a dash for ever, and a vendor
 *  no Reference may name is unreachable from the API.
 */
export const VENDORS: readonly Vendor[] = [moomooVendor, ibkrVendor, yahooVendor];

/** The names `OPTIONALITY_PROVIDER` accepts, derived rather than listed twice.
 *
 *  This was its own array, which is the shape of the bug it cannot now have: a vendor added to
 *  the switch and not to the list was unannounceable, and the reverse was a name the error
 *  message offered and nothing could build.
 */
export const PROVIDERS: readonly string[] =
  VENDORS.filter((v) => v.canBeProvider).map((v) => v.name);

/** The Provider this deployment names, opened, or a fatal error.
 *
 *  Fatal on purpose, like every other mistyped setting (env.ts): a service that starts with no
 *  Provider has no market data, no alarms and a dashboard full of dashes, which is worse than one
 *  that does not start. launchd keeps trying and the log says what was wrong with the name.
 *
 *  Two different faults, and the message distinguishes them. A name nothing carries is a typo, so
 *  the known names are quoted. A name this build carries but cannot REACH is a missing setting,
 *  so the variable is quoted instead — "unknown provider 'ibkr'" would send the owner looking for
 *  a feature that is already here.
 */
export function makeProvider(settings: Settings, vendors = VENDORS): ProviderClient {
  const vendor = vendors.find((v) => v.name === settings.provider);
  // ONE guard, which the compiler also needs: without the narrowing, `vendor.open` may answer a
  // `VendorClient` and TS2741 says `reachable` is missing. Written twice at first — in the find
  // and here — and a mutation sweep showed removing either left every test passing, which is what
  // a redundant check looks like from the outside.
  if (!vendor || !vendor.canBeProvider) {
    throw new Error(
      `OPTIONALITY_PROVIDER: unknown provider '${settings.provider}' `
      + `(known: ${vendors.filter((v) => v.canBeProvider).map((v) => v.name).join(", ")})`,
    );
  }
  const client = vendor.open(settings);
  if (!client) {
    throw new Error(
      `OPTIONALITY_PROVIDER: ${vendor.name} is this deployment's Provider but nothing configures `
      + `it — set ${vendor.configuredBy ?? "its connection"}`,
    );
  }
  return client;
}

/** Everything this build can reach, opened once: the Provider, every source, one way out.
 *
 *  The Provider is opened as a vendor like any other and then named, so its Reference rows are
 *  served by the SAME client the alarms read from. That is the half of ADR 0019 that cannot be
 *  left to memory: IB Gateway allows one connection per client id and the second displaces the
 *  first in silence, so a second client for the same vendor would not fail — it would quietly
 *  break the first.
 */
export function openVendors(settings: Settings, vendors = VENDORS): {
  provider: ProviderClient;
  /** Every vendor that opened, by name — the Provider among them. */
  sources: Sources;
  /** Hang up everything that opened. One loop, so a vendor cannot be forgotten by growing a
   *  `close` after the fact. */
  close: () => void;
} {
  const opened: VendorClient[] = [];
  const sources: Record<string, QuoteFetcher> = {};

  /** Registered so the call keeps its receiver.
   *
   *  `sources[name] = client.fetchQuotes` is the obvious line and it is WRONG for any vendor
   *  whose client is a class: extracting a method unbinds `this`, so the first call failed with
   *  "Cannot read properties of undefined (reading 'close')" from inside `IbkrClient`. Every test
   *  passed — the fakes here are closures, and the one test that did call through a real client
   *  expected a rejection and got one, for the wrong reason. It was found by booting the process
   *  and reading an IBKR Reference row.
   *
   *  So the registry never holds a bare method. A vendor may hand back a class instance or an
   *  object literal and neither can get this wrong.
   */
  const register = (client: VendorClient) => {
    opened.push(client);
    sources[client.name] = (codes) => client.fetchQuotes(codes);
  };

  const provider = makeProvider(settings, vendors);
  register(provider);

  for (const vendor of vendors) {
    // the Provider is already open, and opening it twice is the thing this function exists to
    // prevent rather than something to tidy afterwards
    if (vendor.name === provider.name) continue;
    const client = vendor.open(settings);
    if (!client) continue;   // not configured: a Reference naming it gets a dash saying so
    register(client);
  }

  return {
    provider,
    sources,
    close: () => {
      for (const client of opened) {
        // one vendor's refusal must not strand the rest: this is on every way out of the process
        // (main.ts), and the database is closed after it
        try {
          client.close();
        } catch (err) {
          console.error(`hanging up ${client.name} failed:`, err);
        }
      }
    },
  };
}
