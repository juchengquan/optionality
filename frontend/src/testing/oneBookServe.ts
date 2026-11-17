/** The owner-shaped book of the one-book layout suites (2026-11-17), served to the page, with a
 *  second rule under a held spread and a watched contract on a held leg so every part of an expiry
 *  is drawn: held spreads (their own rule on their row), a rule under one, watched spreads, the
 *  "contracts" label and a lone contract. Test support: the two `__browser__/NextOneBook` files import it. */
import { entry, HOLDINGS, monitor, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "./ownerBook";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
};

const SECOND = entry("r-calls-short", {
  code: "US.SPXW261218C7300000", strike_date: "2026-12-18", option_type: "CALL", field: "option_delta",
  threshold: 0.3, watched: 0.33, distance: -0.03, held: true, scope: "leg",
  positions: [{ id: "h-calls", name: "1218_C7300" }], quote: { name: "SPXW 261218 7300.00C", option_delta: 0.33 },
});
const ON_LEG = entry("w-p6400", {
  code: "US.SPXW261218P6400000", strike_date: "2026-12-18", option_type: "PUT", field: "option_delta",
  threshold: 0.3, watched: -0.21, distance: 0.09, quote: { name: "SPXW 261218 6400.00P", option_delta: -0.21 },
});
/** Each holding with a Level reached, so the widest chips are drawn beside "held". */
const levelled = HOLDINGS.map((h) => ({
  ...h, schedule: { dte_at_open: 45, on_pace: 1.23, pace_gap: 0.47, target: 1, stop: 4, target_dte: 11,
    manage_by_dte: 21, reached: h.id === "h-puts" ? "target" : "stop", manage_by_due: false },
}));

export function serveOneBook(): void {
  const quotes = [...QUOTES, SECOND, ON_LEG];
  const monitors = [...MONITORS, monitor(SECOND.id, { code: SECOND.code }), monitor(ON_LEG.id, { code: ON_LEG.code })];
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const read = payoffAnswer(path) ?? samplesAnswer(path) ?? volAnswer(path);
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const body = path === "/quotes" ? quotes : path === "/monitors" ? monitors
      : path === "/health" ? health : path === "/positions/values" ? levelled : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** Whether `el` is drawn, inside `box` side to side, and on top at its middle. */
export function placed(el: Element, box: Element): string | null {
  const a = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (a.width === 0 || a.height === 0) return "not drawn";
  if (a.left < b.left - 0.5 || a.right > b.right + 0.5) return `outside: ${a.left}–${a.right} not in ${b.left}–${b.right}`;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return top && (el === top || el.contains(top)) ? null : `covered by ${top?.className ?? "nothing"}`;
}
