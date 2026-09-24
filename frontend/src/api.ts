/** Shapes the service actually returns. Phase 0 made every figure here reachable. */

export interface PositionRef {
  id: string;
  name: string;
}

export interface Snapshot {
  name?: string;
  mid_price?: number | null;
  bid_price?: number | null;
  ask_price?: number | null;
  option_delta?: number | null;
  option_gamma?: number | null;
  option_theta?: number | null;
  option_vega?: number | null;
  option_implied_volatility?: number | null;
  update_time?: string | null;
  fetched_at?: string | null;
}

export interface Leg {
  sign: number;
  option_type: "CALL" | "PUT";
  strike: number;
}

/** One rule, with everything needed to draw its row — no arithmetic left for the client. */
export interface Entry {
  id: string;
  code: string;
  field: string;
  threshold: number;
  direction: "above" | "below";
  compare: "abs" | "signed";
  triggered: boolean;
  strike_date: string;
  dte: number;
  fill: number | null;
  scope: string | null;
  positions: PositionRef[];
  cost_to_close: number | null;
  entry: number | null;
  pnl: number | null;
  snapshot: Snapshot | null;
  legs?: Leg[];
  combo_value?: number | null;
  combo_greeks?: Record<string, number | null>;
  error?: string;
}

export interface Monitor {
  id: string;
  code: string;
  field: string;
  threshold: number;
  strike_date: string;
  enabled: boolean;
  disabled_reason: string | null;
  scope: string | null;
  positions: PositionRef[];
}

export interface Health {
  db: boolean;
  opend: boolean;
  queue_depth: number;
  monitor: {
    last_sweep_at: string | null;
    alarms: { label: string; bad: boolean };
    fetched_at: string | null;
  };
  settings: { sweep_seconds: number; expired_retention_days: number };
  /** what the API believes the contract is; the bundle carries its own to compare */
  contract_version: number;
}

/** Where the API lives, relative to wherever this bundle was deployed.
 *
 * The page cannot work its own prefix out at runtime: `tailscale serve` strips it before
 * proxying, so the app only ever sees the stripped spelling. BASE_URL is baked at build
 * time from UI_BASE (see the Makefile) and locates both the assets and the API, so the two
 * cannot end up pointing at different deployments. ADR 0006 has the reasoning.
 */
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const fetchQuotes = () => getJSON<Entry[]>("/quotes");
export const fetchMonitors = () => getJSON<Monitor[]>("/monitors");
export const fetchHealth = () => getJSON<Health>("/health");

async function send(path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    // the service explains itself properly — a duplicate, a dead contract, an unsplittable
    // total — so surface its words rather than a status code
    const detail = await res.json().catch(() => null);
    throw new Error(typeof detail?.detail === "string" ? detail.detail : `${path} → ${res.status}`);
  }
}

export const patchMonitor = (id: string, body: Record<string, unknown>) =>
  send(`/monitors/${id}`, "PATCH", body);

export const deleteMonitor = (id: string) => send(`/monitors/${id}`, "DELETE");

export const patchPosition = (id: string, body: Record<string, unknown>) =>
  send(`/positions/${id}`, "PATCH", body);

/** Record a credit taken in across everything a rule spans; the server derives the one wing
 *  that has no rule of its own, so the per-wing credits stay the single source of truth. */
export const setTotalEntry = (monitorId: string, entry: number) =>
  send(`/monitors/${monitorId}/total-entry`, "POST", { entry });

export const createMonitor = (body: Record<string, unknown>) =>
  send("/monitors", "POST", body);
