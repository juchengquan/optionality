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
}

async function getJSON<T>(rootPath: string, path: string): Promise<T> {
  const res = await fetch(`${rootPath}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const fetchQuotes = (root: string) => getJSON<Entry[]>(root, "/quotes");
export const fetchMonitors = (root: string) => getJSON<Monitor[]>(root, "/monitors");
export const fetchHealth = (root: string) => getJSON<Health>(root, "/health");
