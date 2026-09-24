import { useCallback, useEffect, useMemo, useState } from "react";

import "./app.css";
import {
  createMonitor, deleteMonitor, fetchHealth, fetchMonitors, fetchQuotes,
  patchMonitor, patchPosition, setTotalEntry,
  type Entry, type Health, type Monitor,
} from "./api";
import { AddCombo, AddMonitor } from "./AddForms";
import { CONTRACT_VERSION } from "./contract";
import { COMBO_COLUMNS, SINGLE_COLUMNS, readHidden, visible, writeHidden } from "./columns";
import { ColumnPickers } from "./ColumnPickers";
import { MutedTables } from "./MutedTables";
import { WatchlistTable, type RowHandlers } from "./WatchlistTable";

const REFRESH_PRESETS = [5, 10, 15, 30, 60, 120];

function readRefresh(fallback: number): number {
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith("ui_refresh="))
    ?.split("=")[1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(5, Math.min(3600, n)) : fallback;
}

export function App() {
  const [quotes, setQuotes] = useState<Entry[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(15);
  const [hiddenSingle, setHiddenSingle] = useState(() => readHidden("single"));
  const [hiddenCombo, setHiddenCombo] = useState(() => readHidden("combo"));

  const load = useCallback(async () => {
    try {
      const [q, m, h] = await Promise.all([
        fetchQuotes(),
        fetchMonitors(),
        fetchHealth(),
      ]);
      setQuotes(q);
      setMonitors(m);
      setHealth(h);
      setError(null);
    } catch (e: unknown) {
      // the dashboard must still render when the service is unhappy, as /ui does
      setError(String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // the poll interval follows the same cookie /ui's selector writes, so switching between
  // the two dashboards does not silently change how often either updates
  useEffect(() => {
    if (health) setRefresh(readRefresh(health.settings.sweep_seconds));
  }, [health]);

  useEffect(() => {
    const id = setInterval(() => {
      // skip a beat while focus is inside the page's controls, so a poll never wipes
      // something being typed — the same guard /ui applies to its live region
      if (!document.activeElement?.closest("input, select, details")) void load();
    }, refresh * 1000);
    return () => clearInterval(id);
  }, [refresh, load]);

  // every mutation reloads rather than patching local state: these change what the alarm
  // engine does, and the server's account of that is the only one that counts
  const act = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
        setError(null);
        await load();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  const handlers: RowHandlers = useMemo(
    () => ({
      onPatch: (id, body) => void act(() => patchMonitor(id, body)),
      onDelete: (id) => void act(() => deleteMonitor(id)),
      onRename: (id, name) => void act(() => patchMonitor(id, { name })),
      onEntry: (positionId, value) => void act(() => patchPosition(positionId, { entry: value })),
      onTotal: (monitorId, value) => void act(() => setTotalEntry(monitorId, value)),
    }),
    [act],
  );

  const onToggle = useCallback((table: "single" | "combo", key: string, shown: boolean) => {
    const setter = table === "single" ? setHiddenSingle : setHiddenCombo;
    setter((prev) => {
      const next = new Set(prev);
      if (shown) next.delete(key); else next.add(key);
      writeHidden(table, next);
      return next;
    });
  }, []);

  const onReset = useCallback((table: "single" | "combo") => {
    const setter = table === "single" ? setHiddenSingle : setHiddenCombo;
    setter(() => { writeHidden(table, new Set()); return new Set(); });
  }, []);

  const singles = useMemo(() => quotes.filter((q) => !q.legs), [quotes]);
  const combos = useMemo(() => quotes.filter((q) => q.legs), [quotes]);
  const singleCols = useMemo(() => visible(SINGLE_COLUMNS, hiddenSingle), [hiddenSingle]);
  const comboCols = useMemo(() => visible(COMBO_COLUMNS, hiddenCombo), [hiddenCombo]);

  const fetchedAt = health?.monitor.fetched_at;

  // The dashboard and the API deploy separately now (ADR 0006), so this bundle can be older
  // than the service it is talking to. Say so rather than let it surface as a blank column.
  const skewed = health !== null && health.contract_version !== CONTRACT_VERSION;

  return (
    <main>
      <h2>optionality watchlist</h2>
      {error ? <div className="banner">{error}</div> : null}
      {skewed ? (
        <div className="banner">
          This dashboard is out of date — it was built for API v{CONTRACT_VERSION}, the service
          is running v{health.contract_version}. The figures below may be wrong. Run{" "}
          <code>make deploy</code>, then reload.
        </div>
      ) : null}

      <form className="health" onSubmit={(e) => e.preventDefault()}>
        refresh every{" "}
        <select
          value={refresh}
          onChange={(e) => {
            const n = Number(e.target.value);
            setRefresh(n);
            document.cookie = `ui_refresh=${n};path=/;max-age=31536000;samesite=lax`;
          }}
        >
          {REFRESH_PRESETS.map((n) => <option key={n} value={n}>{n}s</option>)}
        </select>{" "}
        (this browser only)
      </form>

      <ColumnPickers
        pickers={[
          { table: "single", label: "Single-leg", all: SINGLE_COLUMNS, hidden: hiddenSingle, onToggle, onReset },
          { table: "combo", label: "Combos", all: COMBO_COLUMNS, hidden: hiddenCombo, onToggle, onReset },
        ]}
      />

      <p className="meta">
        {fetchedAt ? `fetched at ${fetchedAt}` : "waiting for first sweep"}
        {health ? ` · sweep every ${health.settings.sweep_seconds}s` : ""}
      </p>

      {health ? (
        <div className="health">
          OpenD: <span className={health.opend ? undefined : "bad"}>{health.opend ? "up" : "DOWN"}</span>
          {" · alarms: "}
          <span className={health.monitor.alarms.bad ? "bad" : undefined}>{health.monitor.alarms.label}</span>
          {` · queue: ${health.queue_depth}`}
        </div>
      ) : null}

      <WatchlistTable title="Single-leg" entries={singles} columns={singleCols} isCombo={false} handlers={handlers} />
      <WatchlistTable title="Combos" entries={combos} columns={comboCols} isCombo={true} handlers={handlers} />
      {quotes.length === 0 && !error ? <p>Watchlist is empty.</p> : null}

      <MutedTables
        monitors={monitors}
        retentionDays={health?.settings.expired_retention_days ?? 7}
        onUnmute={(id) => void act(() => patchMonitor(id, { enabled: true }))}
        onDelete={(id) => void act(() => deleteMonitor(id))}
      />

      <AddMonitor onCreate={(body) => void act(() => createMonitor(body))} />
      <AddCombo onCreate={(body) => void act(() => createMonitor(body))} />
    </main>
  );
}
