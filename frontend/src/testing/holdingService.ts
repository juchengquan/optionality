/** A small service for the suites that change a holding from `/opt/next` (#294): the owner-shaped
 *  book (`ownerBook.ts`) behind every route the page calls, which REMEMBERS what it was sent — an
 *  edit, a close, a correction or a delete changes what the next read answers, as the real one does.
 *
 *  What a close does to the Monitors is the SERVICE's decision (ADR 0022), so here it is the test's:
 *  `handTo` names, per rule, the open holding it is handed to; every other rule linked to the closed
 *  holding is switched off as `holding-closed`. The page is held to saying what this answers, never
 *  to working it out.
 *
 *  Any route it does not serve is a 404 in the error shape, never an empty list a page could draw.
 */
import type { Entry, Holding, Monitor, Samples } from "../api";
import { HOLDINGS, MONITORS, QUOTES, payoffAnswer, samplesAnswer, volAnswer } from "./ownerBook";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-12 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-12 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

export interface Sent { method: string; path: string; body: unknown }

export interface HoldingService {
  sent: Sent[];
  /** the writes alone */
  writes: () => Sent[];
  /** each holding as stored now, held or closed */
  stored: Map<string, Holding>;
  /** answer this write with a refusal instead: `METHOD path` -> status and detail */
  refuse: Map<string, { status: number; detail: string }>;
  /** keep serving a closed or deleted holding from `/positions/values`, as a poll asked before the
   *  write and landing after it would */
  stale: { values: boolean };
  fetch: typeof fetch;
}

export function holdingService(over: {
  holdings?: Holding[]; monitors?: Monitor[]; quotes?: Entry[];
  /** monitor id -> the holding a close hands it to */
  handTo?: Record<string, { id: string; name: string }>;
  /** holding id -> its samples, over `ownerBook`'s; either is served only to the day the holding
   *  is closed on NOW, as `listPositionSamples` hides the days after a backdated close (ADR 0022) */
  samples?: Record<string, Samples>;
} = {}): HoldingService {
  const stored = new Map((over.holdings ?? HOLDINGS).map((h) => [h.id, { ...h }]));
  const first = new Map(stored);
  const monitors = new Map((over.monitors ?? linkedMonitors()).map((m) => [m.id, { ...m }]));
  const quotes = over.quotes ?? QUOTES;
  const sent: Sent[] = [];
  const refuse = new Map<string, { status: number; detail: string }>();
  const stale = { values: false };

  // a COPY, as a wire gives: the page must never hold the very objects a later write changes
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(structuredClone(body)) });
  // `GET /positions`' row (`PositionOut`): what is stored and nothing a valuation adds — no contract
  // size, no Cost to close — named field by field, so a page cannot lean on a figure it is not sent
  const out = (h: Holding) => ({
    id: h.id, name: h.name, strategy: h.strategy, strike_date: h.strike_date, contracts: h.contracts,
    entry: h.entry, legs: h.legs, created_at: h.created_at, opened_at: h.opened_at, closed_on: h.closed_on,
    exit: h.exit,
    realized_points: h.closed_on === null || h.entry === null || h.exit === null
      ? null : (h.entry - h.exit) * h.contracts,
  });

  const samplesOf = (path: string): Samples | null => {
    const m = /^\/positions\/([^/]+)\/samples$/.exec(path);
    const id = m ? decodeURIComponent(m[1]!) : null;
    const all = id === null ? null : over.samples?.[id] ?? samplesAnswer(path);
    const closedOn = id === null ? null : stored.get(id)?.closed_on ?? null;
    if (!all) return null;
    return closedOn === null ? all : { ...all, samples: all.samples.filter((d) => d.observed_on <= closedOn) };
  };

  const impl = (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, path, body });
    const refused = refuse.get(`${method} ${path}`);
    if (refused) return reply(refused.status, { detail: refused.detail });

    if (method === "GET") {
      if (path === "/health") return reply(200, health);
      if (path === "/quotes") return reply(200, quotes.filter((q) => monitors.get(q.id)?.enabled ?? true));
      if (path === "/monitors") return reply(200, [...monitors.values()]);
      if (path === "/references") return reply(200, []);
      if (path === "/positions/values") {
        const open = stale.values ? [...first.values()] : [...stored.values()].filter((h) => h.closed_on === null);
        return reply(200, open);
      }
      if (path === "/positions") return reply(200, [...stored.values()].map(out));
      const payoff = payoffAnswer(path);
      if (payoff) return reply(200, payoff);
      const samples = samplesOf(path);
      if (samples) return reply(200, samples);
      const vol = volAnswer(path);
      if (vol) return reply(200, vol);
    }
    if (method === "POST" && path === "/positions/payoff") return reply(200, payoffAnswer(path));

    const one = /^\/positions\/([^/]+)(\/close)?$/.exec(path);
    const h = one ? stored.get(decodeURIComponent(one[1]!)) : undefined;
    if (one && !h) return reply(404, { detail: "position not found" });
    if (h && method === "PATCH" && !one![2]) {
      const given = body as Partial<Holding>;
      if (h.closed_on === null && ("exit" in given || "closed_on" in given)) {
        return reply(422, { detail: `position '${h.name}' is not closed: close it first` });
      }
      Object.assign(h, given);
      return reply(200, out(h));
    }
    if (h && method === "POST" && one![2]) {
      if (h.closed_on !== null) return reply(409, { detail: `position '${h.name}' is already closed` });
      const given = body as { exit?: number | null; closed_on?: string };
      h.closed_on = given.closed_on ?? "2026-11-12";
      h.exit = given.exit ?? null;
      const off: { id: string; code: string }[] = [];
      for (const m of monitors.values()) {
        if (!m.positions.some((p) => p.id === h.id)) continue;
        const to = over.handTo?.[m.id];
        m.positions = to ? [to] : [];
        if (!to && m.enabled) {
          m.enabled = false;
          m.disabled_reason = "holding-closed";
          off.push({ id: m.id, code: m.code });
        }
      }
      return reply(200, { ...out(h), disabled_monitors: off });
    }
    if (h && method === "DELETE") {
      stored.delete(h.id);
      for (const m of monitors.values()) m.positions = m.positions.filter((p) => p.id !== h.id);
      return Promise.resolve({ ok: true, status: 204, json: () => Promise.reject(new Error("no body")) });
    }
    return reply(404, { detail: `${method} ${path} is not served here` });
  };

  return {
    sent, stored, refuse, stale,
    writes: () => sent.filter((s) => s.method !== "GET" && s.path !== "/positions/payoff"),
    fetch: impl as unknown as typeof fetch,
  };
}

/** `ownerBook`'s rules, each linked to the holding its quote names, as `/monitors` serves them. */
function linkedMonitors(): Monitor[] {
  return MONITORS.map((m) => {
    const q = QUOTES.find((e) => e.id === m.id);
    return q && q.positions.length > 0 ? { ...m, positions: q.positions } : m;
  });
}
