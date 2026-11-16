/** Browser test support: what the two Greek-label suites share (D of the owner's standard, 2026-11-16): a book with every
 *  greek served, and the reader that finds a Greek letter set in capitals. */
import type { Entry, Holding } from "../shared/api";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "./ownerBook";

/** A LOWER-case Greek letter, which capitals would turn into another-looking one: ν to "Ν" (an N),
 *  γ to "Γ", θ to "Θ", σ to "Σ". The upper-case ones (Δ Γ Θ) do not change, so are no evidence. */
const LOWER_GREEK = /[α-ω]/;

/** Every element the page draws whose OWN text holds a lower-case Greek letter and whose computed
 *  style sets it in capitals — what the eye reads, measured, not what the source says. */
export function greekInCapitals(root: ParentNode = document): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("");
    if (!LOWER_GREEK.test(own)) continue;
    const t = getComputedStyle(el).textTransform;
    if (t === "uppercase" || t === "capitalize") out.push(`${el.tagName.toLowerCase()}.${el.className}: "${own}" (${t})`);
  }
  return out;
}

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const HELD: Holding[] = HOLDINGS.map((h) => ({
  ...h, greeks: { option_delta: -0.0204, option_gamma: -0.00004, option_theta: -0.11, option_vega: -0.79 },
}));
const BOOK: Entry[] = QUOTES.map((q) => q.id === "w-lone" ? {
  ...q, quote: { name: "SPXW 261231 8000.00C", option_delta: 0.04, option_gamma: 0.0002, option_theta: -1.35,
    option_vega: 3.38, option_implied_volatility: 27.17, bid_price: 0.45, ask_price: 0.55, mid_price: 0.5 },
} as Entry : q);

/** The book, every read answered and every write refused. */
export function serveGreeks(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "").replace(/\?.*$/, "");
    const read = payoffAnswer(path) ?? samplesAnswer(path) ?? volAnswer(path);
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const body = path === "/quotes" ? BOOK : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? HELD : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}
