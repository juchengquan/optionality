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
    held: false,
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
  schedule: null, captured: 0.6,
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

/** Every write is refused, as the service refuses one it will not take: a layout suite never
 *  changes the book, and a refusal is how a toast gets onto the page to be measured. */
export function serveBook(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({
        ok: false, status: 409, json: () => Promise.resolve({ detail: "refused by the test service" }),
      });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? quotes : path === "/monitors" ? monitors
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
