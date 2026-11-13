/** The owner's book with the three writes #336 adds to a rule's editor answered as the service
 *  answers them: a combo renamed (`PATCH /monitors/{id}` with a name), a total entry split across
 *  the holdings a rule covers (`POST /monitors/{id}/total-entry`), and a watched contract recorded
 *  as held (`POST /spreads`, one leg, which replaces the watch rule on it).
 *
 *  The book is `ownerBook`'s plus ONE rule, `CONDOR`: a combo over the condor held as two spreads on
 *  12-18, linked to both — and `r-calls` linked to the call spread alone, as `/quotes` already says,
 *  so the call spread has a rule of its own and the put spread does not. That is the shape
 *  `applyTotalEntry` splits: the one holding with no rule of its own takes the rest.
 *
 *  Every route the page calls is answered on purpose, and a route not named is a 404 that says
 *  which call it was. Each write changes what the next read says, as the real routes do.
 */
import type { Entry, Holding, Monitor } from "../api";
import { EDIT_HEALTH } from "./editBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "./ownerBook";

/** A condor's value rule over both of the 12-18 spreads held. */
export const CONDOR: Entry = {
  ...QUOTES.find((q) => q.id === "r-calls")!,
  id: "r-condor", code: "1218_IC", threshold: 8, watched: 6.4, distance: 1.6, triggered: false, fill: 80,
  legs: [
    { sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7350 },
    { sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 },
  ],
  positions: [{ id: "h-calls", name: "1218_C7300" }, { id: "h-puts", name: "1218_P6400" }],
  combo_value: 6.4,
} as Entry;

/** `/monitors` saying what `/quotes` says about every rule that is on — its figure, its legs, its
 *  links — which `ownerBook`'s rows, carrying defaults, do not. */
function monitorsOf(quotes: Entry[]): Monitor[] {
  const on = quotes.map((q) => {
    const leg = /([CP])(\d+)000$/.exec(q.code);
    return {
      ...MONITORS.find((m) => m.id === q.id) ?? MONITORS[0]!,
      id: q.id, code: q.code, strike_date: q.strike_date, field: q.field, threshold: q.threshold,
      direction: q.direction, compare: q.compare, option_type: q.option_type, legs: q.legs ?? null,
      strike: leg ? Number(leg[2]) : 0, scope: q.scope, positions: q.positions, enabled: true,
      disabled_reason: null,
    } as Monitor;
  });
  return [...on, ...MONITORS.filter((m) => !m.enabled)];
}

/** The book the split is worked against, as plain data. */
export function splitBook(): { quotes: Entry[]; monitors: Monitor[]; holdings: Holding[] } {
  const quotes = [...structuredClone(QUOTES), structuredClone(CONDOR)];
  return { quotes, monitors: monitorsOf(quotes), holdings: structuredClone(HOLDINGS) };
}

export interface Write { what: string; body: unknown }

export interface Refusals {
  /** the service's refusal for a PATCH, as [status, words], or null to take it */
  patch?: (id: string, body: Record<string, unknown>) => [number, string] | null;
  totalEntry?: (id: string, body: { entry: number }) => [number, string] | null;
  spreads?: (body: unknown) => [number, string] | null;
}

export function serveRuleEdits(refuse: Refusals = {}): Write[] {
  const writes: Write[] = [];
  const book = splitBook();
  let { quotes, monitors } = book;
  const holdings = book.holdings;
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  const refused = (r: [number, string] | null | undefined) => (r ? reply(r[0], { detail: r[1] }) : null);

  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    // reads, whatever their method: `POST /positions/payoff` writes nothing (#291)
    const read = payoffAnswer(path) ?? samplesAnswer(path) ?? volAnswer(path);
    if (read) return reply(200, read);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (method !== "GET") writes.push({ what: `${method} ${path}`, body });

    const id = /^\/monitors\/([^/]+)$/.exec(path)?.[1];
    if (method === "PATCH" && id) {
      const m = monitors.find((r) => r.id === id);
      if (!m) return reply(404, { detail: "monitor not found" });
      const no = refused(refuse.patch?.(id, body!));
      if (no) return no;
      const { name, ...fields } = body!;
      if (name !== undefined) {
        if (m.legs === null) {
          const why = "only combo monitors can be renamed; a single-leg code is derived from its contract";
          return reply(422, { detail: why });
        }
        if (name !== m.code && monitors.some((r) => r.id !== id && r.code === name && r.field === m.field)) {
          return reply(409, { detail: `monitor for (${String(name)}, ${m.field}) already exists` });
        }
      }
      const change = name === undefined ? fields : { ...fields, code: name };
      Object.assign(m, change);
      const q = quotes.find((r) => r.id === id);
      if (q) Object.assign(q, change);
      return reply(200, m);
    }

    const total = /^\/monitors\/([^/]+)\/total-entry$/.exec(path)?.[1];
    if (method === "POST" && total) {
      const m = monitors.find((r) => r.id === total);
      if (!m) return reply(404, { detail: "monitor not found" });
      const no = refused(refuse.totalEntry?.(total, body as { entry: number }));
      if (no) return no;
      // `applyTotalEntry`: the one holding no rule watches alone takes the total less the others
      const solely = new Set(monitors.filter((r) => r.scope === "all" && r.positions.length === 1)
        .map((r) => r.positions[0]!.id));
      const targets = m.positions.filter((p) => !solely.has(p.id));
      if (targets.length !== 1) return reply(422, { detail: "cannot split a total here" });
      const rest = m.positions.filter((p) => p.id !== targets[0]!.id)
        .reduce((s, p) => s + (holdings.find((h) => h.id === p.id)!.entry ?? 0), 0);
      holdings.find((h) => h.id === targets[0]!.id)!.entry = Number(((body!.entry as number) - rest).toFixed(4));
      return reply(200, { ok: true });
    }

    if (method === "POST" && path === "/spreads") {
      const no = refused(refuse.spreads?.(body));
      if (no) return no;
      const sent = body as unknown as {
        strike_date: string;
        spreads: { name: string; legs: { side: string; option_type: string; strike: number }[];
          entry: number | null; contracts: number; opened_at: string | null;
          monitors: { option_type: string; strike: number; field: string; threshold: number;
            direction: string; compare: string }[] }[];
      };
      const s = sent.spreads[0]!;
      const leg = s.legs[0]!;
      const code = `US.SPXW${sent.strike_date.slice(2).replaceAll("-", "")}${leg.option_type[0]}${leg.strike}000`;
      // the watch rule on that (contract, field), owned by no holding, is replaced (#322)
      const replaced = monitors.filter((m) =>
        s.monitors.some((n) => m.code === code && m.field === n.field) && m.positions.length === 0);
      const gone = new Set(replaced.map((m) => m.id));
      const was = quotes.find((q) => gone.has(q.id));
      monitors = monitors.filter((m) => !gone.has(m.id));
      quotes = quotes.filter((q) => !gone.has(q.id));
      const holding = {
        ...HOLDINGS[0]!, id: "h-new", name: s.name, strike_date: sent.strike_date, contracts: s.contracts,
        entry: s.entry, opened_at: s.opened_at, legs: s.legs, short_strikes: [], legs_delta: null,
      } as Holding;
      holdings.push(holding);
      const made = s.monitors.map((n, i) => ({ id: `m-new-${i}`, code, field: n.field }));
      for (const [i, n] of s.monitors.entries()) {
        const linked = [{ id: holding.id, name: holding.name }];
        const row = { ...(was ?? quotes[0]!), id: `m-new-${i}`, code, field: n.field, threshold: n.threshold,
          direction: n.direction, compare: n.compare, held: true, scope: "all", positions: linked } as Entry;
        quotes.push(row);
        monitors = [...monitors, ...monitorsOf([row])];
      }
      return reply(201, {
        positions: [{ id: holding.id, name: holding.name }], monitors: made,
        replaced: replaced.map((m) => ({ id: m.id, code: m.code, field: m.field })),
      });
    }

    if (method === "GET") {
      if (path === "/quotes") return reply(200, quotes);
      if (path === "/monitors") return reply(200, monitors);
      if (path === "/health") return reply(200, EDIT_HEALTH);
      if (path === "/positions/values") return reply(200, holdings);
      if (path === "/references") return reply(200, []);
      // REVIEW's closed trades (#296): none here
      if (path === "/positions") return reply(200, []);
    }
    return reply(404, { detail: `${method} ${path} is not served here` });
  }) as unknown as typeof fetch;
  return writes;
}
