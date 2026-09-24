import { useCallback, useEffect, useMemo, useState } from "react";

import "./app.css";
import {
  createMonitor, deleteMonitor, fetchHealth, fetchMonitors, fetchQuotes,
  patchMonitor, patchPosition, setTotalEntry,
  type Entry, type Health, type Monitor,
} from "./api";
import { NativeSelect } from "@/components/ui/native-select";
import { Toaster, toast } from "@/components/ui/toast";
import { AddPanel } from "./AddPanel";
import { CONTRACT_VERSION } from "./contract";
import { COMBO_COLUMNS, SINGLE_COLUMNS, readHidden, writeHidden } from "./columns";
import { ColumnPickers } from "./ColumnPickers";
import { MutedTables } from "./MutedTables";
import { RowDetail, type DetailTarget } from "./RowDetail";
import { useTableFit } from "./useTableFit";
import { WatchlistTable, type RowHandlers } from "./WatchlistTable";

const REFRESH_PRESETS = [5, 10, 15, 30, 60, 120];

/** Is the user in the middle of something the poll would wipe?
 *
 *  A reload replaces every row, so it must not land while a threshold is half-typed or a
 *  picker is open under the pointer. This list HAS gone stale once already: it named
 *  "details" until phase 4 retired that element, at which point the column pickers stopped
 *  being protected and nothing said so. Hence a test.
 */
export function beingOperated(el: Element | null): boolean {
  // portalled dialogs cover the column pickers and the delete confirmation: focus moves
  // into them when they open, so their role is what marks them busy
  return Boolean(el?.closest("input, select, textarea, [role=dialog], [role=alertdialog]"));
}

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
  const [detail, setDetail] = useState<DetailTarget | null>(null);

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
      // the dashboard must still render when the service is unhappy. This banner means one
      // thing only — the poll is failing, so every figure below is stale — and it stays up
      // until a poll succeeds. Refusals of things you just did go to a toast instead.
      setError(e instanceof Error ? e.message : String(e));
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
      if (!beingOperated(document.activeElement)) void load();
    }, refresh * 1000);
    return () => clearInterval(id);
  }, [refresh, load]);

  // every mutation reloads rather than patching local state: these change what the alarm
  // engine does, and the server's account of that is the only one that counts
  const act = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
        await load();
      } catch (e: unknown) {
        // the service explains its refusals properly — a duplicate, a dead contract, an
        // unsplittable total — so its words go straight to the toast
        toast.add({ title: e instanceof Error ? e.message : String(e), type: "error" });
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
  // what the viewer ticked is now a wish; the width decides how much of it is granted
  const singleFit = useTableFit("single", singles, hiddenSingle);
  const comboFit = useTableFit("combo", combos, hiddenCombo);

  // the sheet holds a snapshot of the row it was opened with; the poll replaces every row
  // object, so re-read it from the live list or the figures behind the sheet freeze
  const detailEntry = useMemo(
    () => (detail ? (quotes.find((q) => q.id === detail.entry.id) ?? detail.entry) : null),
    [detail, quotes],
  );

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
        <NativeSelect
          size="sm"
          aria-label="refresh every"
          value={refresh}
          onChange={(e) => {
            const n = Number(e.target.value);
            setRefresh(n);
            document.cookie = `ui_refresh=${n};path=/;max-age=31536000;samesite=lax`;
          }}
        >
          {REFRESH_PRESETS.map((n) => <option key={n} value={n}>{n}s</option>)}
        </NativeSelect>{" "}
        (this browser only)
      </form>

      <ColumnPickers
        pickers={[
          // only columns that could actually appear at this width are offered, so ticking
          // one is never silently ignored
          { table: "single", label: "Single-leg", all: SINGLE_COLUMNS.filter((c) => singleFit.offered.has(c.key)), hidden: hiddenSingle, onToggle, onReset },
          { table: "combo", label: "Combos", all: COMBO_COLUMNS.filter((c) => comboFit.offered.has(c.key)), hidden: hiddenCombo, onToggle, onReset },
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

      <WatchlistTable title="Single-leg" entries={singles} columns={singleFit.columns} containerRef={singleFit.ref} isCombo={false}
                      onOpen={(entry, isCombo) => setDetail({ entry, isCombo })} />
      <WatchlistTable title="Combos" entries={combos} columns={comboFit.columns} containerRef={comboFit.ref} isCombo={true}
                      onOpen={(entry, isCombo) => setDetail({ entry, isCombo })} />

      <RowDetail
        entry={detailEntry}
        isCombo={detail?.isCombo ?? false}
        handlers={handlers}
        open={detail !== null}
        onOpenChange={(o) => { if (!o) setDetail(null); }}
      />
      {quotes.length === 0 && !error ? <p>Watchlist is empty.</p> : null}

      <MutedTables
        monitors={monitors}
        retentionDays={health?.settings.expired_retention_days ?? 7}
        onUnmute={(id) => void act(() => patchMonitor(id, { enabled: true }))}
        onDelete={(id) => void act(() => deleteMonitor(id))}
      />

      <AddPanel onCreate={(body) => void act(() => createMonitor(body))} />

      <Toaster />
    </main>
  );
}
