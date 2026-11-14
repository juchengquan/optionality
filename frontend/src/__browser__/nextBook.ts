/** One book for the redesigned page's layout suites, shaped like the owner's: spreads on three
 *  expiries with a short leg's delta rule under one of them, a holding with a risk rule, a rule
 *  that fired, and one the service quarantined — so the needs-you line has something to say. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

function spread(id: string, date: string, short: number, long: number, over: object = {}) {
  return {
    id, code: `${date.slice(5, 7)}${date.slice(8)}_${short}P`, strike_date: date, option_type: "CMB",
    field: "mid_price", threshold: 6.01, direction: "above", compare: "abs", triggered: false,
    quote: null,
    legs: [{ sign: -1, option_type: "PUT", strike: short }, { sign: 1, option_type: "PUT", strike: long }],
    combo_value: 2.35, combo_greeks: {}, dte: 38, scope: null, positions: [], cost_to_close: null,
    entry: null, pnl: null, fill: 39, schedule: null, watched: 2.35, distance: 3.66, in_combos: [],
    held: false, spx: null, spx_reason: null,
    ...over,
  };
}

const quotes = [
  spread("w1", "2026-12-04", 6900, 6850),
  spread("w2", "2026-12-18", 7150, 7100, { triggered: true, watched: 6.2, distance: -0.19 }),
  spread("w3", "2026-12-31", 7000, 6950),
  {
    ...spread("w4", "2026-12-18", 7150, 7100), code: "US.SPXW261218P7150000", option_type: "PUT",
    field: "option_delta", threshold: 0.2, legs: undefined, combo_value: undefined,
    quote: { name: "SPXW 261218 7150.00P", option_delta: -0.1684 }, watched: -0.1684,
    distance: 0.0316, in_combos: ["w2"],
  },
  {
    ...spread("r1", "2026-12-31", 7000, 6950), code: "1231_7000P", field: "option_delta",
    threshold: 0.3, positions: [{ id: "p1", name: "1231_7000P" }], scope: "all", held: true,
    watched: 0.22, distance: 0.08,
  },
];

const monitors = [{
  id: "q1", code: "US.SPXW261211C8300000", strike_date: "2026-12-11", option_type: "CALL",
  strike: 8300, field: "option_delta", threshold: 0.1, direction: "above", compare: "abs",
  legs: null, enabled: false, scope: null, positions: [], disabled_reason: "unknown-contract",
  triggered: false, last_value: null, last_checked_at: null, created_at: null,
}];

const holdings = [{
  id: "p1", name: "1231_7000P", strategy: null, strike_date: "2026-12-31", contracts: 1, entry: 3,
  legs: [{ side: "short", option_type: "PUT", strike: 7000 }, { side: "long", option_type: "PUT", strike: 6950 }],
  created_at: null, opened_at: "2026-11-03", closed_on: null, exit: null, realized_points: null,
  cost_to_close: 1.2, pnl: 180, contract_size: 100, greeks: {}, fetched_at: "x", dte: 51,
  schedule: null, captured: 0.6, spx: null, spx_reason: null,
}];

const references = [
  { id: "r", code: "US..SPX", label: "S&P 500", source: "moomoo", figure: 7612.25, change: 0.0042,
    field: "mid_price", name: "S&P 500", error: null, last_known: false },
];

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    colorScheme: (scheme: "light" | "dark") => Promise<void>;
  }
}

/** Spreads on later expiries, so the page is longer than a phone's screen; the last one has fired,
 *  so its banner leads to a row that starts out of view. */
export function longBook(n: number): object[] {
  const rows = Array.from({ length: n }, (_, i) =>
    spread(`f${i}`, `2027-0${1 + (i % 6)}-${String(10 + (i % 18))}`, 6000 + i * 10, 5950 + i * 10));
  rows.push(spread("late", "2027-09-17", 5800, 5750, { triggered: true, watched: 6.2, distance: -0.19 }));
  return rows;
}

/** A put spread's payoff at expiry, as `/positions/{id}/payoff` answers (#291). Written out here
 *  rather than taken from `testing/ownerBook.ts`, which this module may not import: it is not a
 *  test file itself (`make check-test-support`). */
const payoff = {
  at_strikes: [{ spx: 6950, pnl: -47 }, { spx: 7000, pnl: 3 }],
  slope_below: 0, slope_above: 0, breakevens: [6997], max_profit: 3, max_loss: -47,
};

/** A holding's daily samples, as `/positions/{id}/samples` answers (#295): a few days of p1's put
 *  spread, one of them filled that evening rather than at the close, against its plan. Written out
 *  here for the reason the payoff above is. */
const samples = {
  levels: { dte_at_open: 58, target: 1.5, stop: 6, target_dte: 15, manage_by_dte: 21 },
  plan: Array.from({ length: 59 }, (_, i) => ({ dte: 58 - i, on_pace: 3 * Math.sqrt((58 - i) / 58) })),
  samples: [
    ["2026-11-03", 58, 2.9, "after-close"], ["2026-11-04", 57, 2.7, "close"],
    ["2026-11-05", 56, 2.4, "close"], ["2026-11-06", 55, 2.2, "close"],
  ].map(([on, dte, cost, timing]) => ({
    observed_on: on, observed_at: "2026-11-07 05:00:00+08:00", timing, dte, cost_to_close: cost,
    on_pace: 3 * Math.sqrt(Number(dte) / 58), legs_iv: { "US.SPXW261231P7000000": 18.5,
      "US.SPXW261231P6950000": 19.25 }, legs_vega: null, legs_delta: null, spx: null,
    before_correction: false,
  })),
  // as the service answers since #359: none of these days was summed before a correction. Missing,
  // the burndown read `undefined` as a correction and threw — unseen while this suite ran in
  // session, where the history is drawn only when opened by hand
  qty_corrected_at: null,
};

/** Every write is refused, as the service refuses one it will not take: a layout suite never
 *  changes the book, and a refusal is how a toast gets onto the page to be measured. */
export function serveBook(extra: object[] = []): void {
  const book = [...quotes, ...extra];
  window.fetch = ((url: string, init?: RequestInit) => {
    // the payoff (#291) is a read, its POST included: any one will do for a layout
    if (/\/payoff$/.test(String(url))) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payoff) });
    }
    // and so are a holding's samples (#295): an empty list in their place would break the page
    if (/\/samples$/.test(String(url))) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(samples) });
    }
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({
        ok: false, status: 409, json: () => Promise.resolve({ detail: "refused by the test service" }),
      });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? book : path === "/monitors" ? monitors
      : path === "/health" ? health : path === "/references" ? references
        : path === "/positions/values" ? holdings : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

export const settle = () => new Promise((r) => setTimeout(r, 250));

/** Anything that pushes the page sideways: a phone page that scrolls horizontally is broken. */
export function overflowsSideways(): boolean {
  const root = document.documentElement;
  return root.scrollWidth > root.clientWidth;
}

/** A colour token as the page resolved it, followed through any `var()` it names. */
export function token(el: Element, name: string): string {
  let value = getComputedStyle(el).getPropertyValue(name).trim();
  for (let i = 0; i < 4; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) break;
    value = getComputedStyle(el).getPropertyValue(ref[1]!).trim();
  }
  return value;
}

/** OKLCH as written in next.css, as OKLab: lightness and the two opponent axes. */
export function oklab(value: string): { L: number; a: number; b: number } {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: "${value}"`);
  const [L, C, h] = [Number(m[1]), Number(m[2]), Number(m[3]) * Math.PI / 180];
  return { L, a: C * Math.cos(h), b: C * Math.sin(h) };
}

/** WCAG relative luminance of an oklch() colour, through OKLab and linear sRGB. */
export function luminance(value: string): number {
  const { L, a, b } = oklab(value);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const R = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const G = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const B = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrast(x: string, y: string): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A draft's payoff at expiry, worked out here as the service would (`payoffAtExpiry`) — enough
 *  of it for a curve that turns over when a leg's side does. */
export function draftPayoff(body: {
  legs: { side: string; option_type: string; strike: number; qty?: number }[]; entry: number; contracts?: number;
}): object {
  const n = body.contracts ?? 1;
  const pnl = (s: number) => n * body.legs.reduce((sum, l) => {
    const worth = (l.option_type === "CALL" ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s)) * (l.qty ?? 1);
    return sum + (l.side === "long" ? worth : -worth);
  }, body.entry);
  const ks = [...new Set(body.legs.map((l) => l.strike))].sort((a, b) => a - b);
  const at = ks.map((k) => ({ spx: k, pnl: pnl(k) }));
  const below = pnl(ks[0]!) - pnl(ks[0]! - 1);
  const above = pnl(ks.at(-1)! + 1) - pnl(ks.at(-1)!);
  const pnls = at.map((a) => a.pnl);
  return {
    at_strikes: at, slope_below: below, slope_above: above, breakevens: [],
    max_profit: above > 0 || below < 0 ? null : Math.max(...pnls),
    max_loss: above < 0 || below > 0 ? null : Math.min(...pnls),
  };
}

/** The page's every route, for the add form's suites (#293): the book empty, the draft payoff
 *  worked out, and `POST /spreads` answered as `spreads` says — every body it was sent is kept.
 *  Any route not named is a 404 in the error shape, never an empty list a page could crash on. */
export function serveAdding(spreads: { status: number; body: object }): unknown[] {
  const sent: unknown[] = [];
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as never : null;
    if (method === "POST" && path === "/positions/payoff") return reply(200, draftPayoff(body!));
    if (method === "POST" && path === "/spreads") { sent.push(body); return reply(spreads.status, spreads.body); }
    if (method === "GET") {
      if (path === "/health") return reply(200, health);
      if (["/quotes", "/monitors", "/positions/values", "/references"].includes(path)) return reply(200, []);
    }
    return reply(404, { detail: `${method} ${path} is not served here` });
  }) as unknown as typeof fetch;
  return sent;
}

/** The page's every route, for the one-contract suites (#331): the book empty until a holding is
 *  recorded, the draft payoff worked out, and `POST /spreads` answered as `spreads` says (what was
 *  made, by default). A held spread posted is then served by `/positions/values`, valued, so a suite
 *  can see it reach the book — built from what was POSTED, which is enough to draw it; what the
 *  route itself does with the body is the door scenarios'. Every write is kept, as `METHOD path`
 *  and its body. Any route not named is a 404 in the error shape. */
export function serveContract(spreads?: { status: number; body: object }): { what: string; body: unknown }[] {
  const writes: { what: string; body: unknown }[] = [];
  const held: object[] = [];
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as never : null;
    if (method === "POST" && path === "/positions/payoff") return reply(200, draftPayoff(body!));
    if (method !== "GET") writes.push({ what: `${method} ${path}`, body });
    if (method === "POST" && path === "/spreads") {
      const sent = body as unknown as {
        strike_date: string;
        spreads: { name: string; held: boolean; legs: object[]; entry?: number | null; contracts?: number;
          opened_at?: string | null; monitors: { field?: string }[] }[];
      };
      const s = sent.spreads[0]!;
      const answer = spreads ?? {
        status: 201,
        body: {
          positions: s.held ? [{ id: "p9", name: s.name }] : [],
          monitors: s.monitors.map((m, i) => ({ id: `m${writes.length}-${i}`, code: s.name, field: m.field ?? "option_delta" })),
          replaced: [],
        },
      };
      if (answer.status < 400 && s.held) {
        held.push({
          id: "p9", name: s.name, strategy: null, strike_date: sent.strike_date, contracts: s.contracts ?? 1,
          entry: s.entry ?? null, legs: s.legs, created_at: null, opened_at: s.opened_at ?? null, closed_on: null,
          exit: null, realized_points: null, cost_to_close: 2.1, pnl: 30, contract_size: 100, greeks: {},
          fetched_at: "x", dte: 36, schedule: null, captured: 0.125,
        });
      }
      return reply(answer.status, answer.body);
    }
    if (method === "GET") {
      if (path === "/health") return reply(200, health);
      if (path === "/positions/values") return reply(200, held);
      // `/positions` is the closed trades (#296), which the page reads when their fold is opened (#373)
      if (["/quotes", "/monitors", "/references", "/positions"].includes(path)) return reply(200, []);
    }
    return reply(404, { detail: `${method} ${path} is not served here` });
  }) as unknown as typeof fetch;
  return writes;
}
