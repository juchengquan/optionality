/** The owner's book served by a service that WRITES (#292): `PATCH /monitors/{id}` and
 *  `DELETE /monitors/{id}` change what the next `GET` says, as the real routes do, so a browser
 *  suite can watch a saved change come back as the service's own sentence.
 *
 *  Every route the page calls is answered on purpose. A write is answered explicitly — the row, a
 *  204, or a refusal in the service's words — never by a generic empty list or 404 that would hide a
 *  call gone wrong; a route not named here is a 404 that says which call it was.
 */
import type { Entry, Monitor } from "../api";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer } from "./ownerBook";

/** Five days kept, not the default seven, so a page that hard-coded the default would say the
 *  wrong day for an expired rule. */
export const EDIT_HEALTH = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 5, manage_by_dte: 21 },
};

export interface Write { what: string; body: unknown }

/** How far a rule's figure is from its threshold, as the domain's `thresholdDistance` measures it:
 *  positive while it has not breached. Worked here because this IS the service, for the test. */
function distance(e: Entry): number | null {
  if (e.watched === null) return null;
  const v = e.compare === "abs" ? Math.abs(e.watched) : e.watched;
  const d = e.direction === "below" ? v - e.threshold : e.threshold - v;
  return Math.round(d * 1e9) / 1e9;
}

/** @param refuse the service's refusal for a patch, in its words, or null to take it */
export function serveEditing(refuse: (id: string, body: Record<string, unknown>) => string | null = () => null): Write[] {
  const writes: Write[] = [];
  let quotes: Entry[] = structuredClone(QUOTES);
  let monitors: Monitor[] = structuredClone(MONITORS).map((m) => {
    // `/monitors` says what `/quotes` says about a rule that is on: ownerBook's rows of it carry
    // defaults, and a rule muted here is drawn from this row, so it must name its own contract
    const q = QUOTES.find((r) => r.id === m.id);
    if (!q) return m;
    const leg = /([CP])(\d+)000$/.exec(q.code);
    return {
      ...m, field: q.field, threshold: q.threshold, direction: q.direction, compare: q.compare,
      option_type: q.option_type, legs: q.legs ?? null,
      strike: leg ? Number(leg[2]) : 0,
    };
  });
  /** rules muted here, kept so unmuting puts their row of `/quotes` back */
  const parked = new Map<string, Entry>();
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const read = payoffAnswer(path) ?? samplesAnswer(path);
    if (read) return reply(200, read);
    const id = /^\/monitors\/([^/]+)$/.exec(path)?.[1];

    if (method === "PATCH" && id) {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      writes.push({ what: `PATCH ${path}`, body });
      const m = monitors.find((r) => r.id === id);
      if (!m) return reply(404, { detail: "monitor not found" });
      const why = refuse(id, body);
      if (why) return reply(422, { detail: why });
      const { enabled, ...fields } = body;
      Object.assign(m, fields);
      if (enabled !== undefined) {
        m.enabled = enabled as boolean;
        m.disabled_reason = enabled ? null : "manual";
        if (!enabled) {
          const q = quotes.find((r) => r.id === id);
          if (q) parked.set(id, q);
          quotes = quotes.filter((r) => r.id !== id);
        } else if (parked.has(id)) {
          quotes.push(parked.get(id)!);
          parked.delete(id);
        }
      }
      const q = quotes.find((r) => r.id === id);
      if (q) {
        Object.assign(q, fields);
        q.distance = distance(q);
        q.triggered = q.distance !== null && q.distance <= 0;
      }
      return reply(200, m);
    }
    if (method === "DELETE" && id) {
      writes.push({ what: `DELETE ${path}`, body: null });
      if (!monitors.some((r) => r.id === id)) return reply(404, { detail: "monitor not found" });
      monitors = monitors.filter((r) => r.id !== id);
      quotes = quotes.filter((r) => r.id !== id);
      return reply(204, null);
    }
    if (method === "GET") {
      if (path === "/quotes") return reply(200, quotes);
      if (path === "/monitors") return reply(200, monitors);
      if (path === "/health") return reply(200, EDIT_HEALTH);
      if (path === "/positions/values") return reply(200, HOLDINGS);
      if (path === "/references") return reply(200, []);
    }
    return reply(404, { detail: `${method} ${path} is not served here` });
  }) as unknown as typeof fetch;
  return writes;
}
