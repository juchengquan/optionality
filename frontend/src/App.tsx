import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";

import "./app.css";
import {
  createWatch, deleteMonitor, fetchHealth, fetchMonitors, fetchQuotes, recordHolding,
  patchMonitor, patchPosition, setTotalEntry,
  type Entry, type Health, type Monitor,
} from "./api";
import { Button } from "@/components/ui/button";
import { Toaster, toast } from "@/components/ui/toast";
import { AddPanel, AddTrigger, type Adding } from "./AddPanel";
import {
  COMBO_COLUMNS, SINGLE_COLUMNS, readBand, readGrouping, readHidden, readSignal, writeBand,
  writeGrouping, writeHidden, writeSignal,
} from "./columns";
import { ColumnPicker } from "./ColumnPickers";
import { MutedTables } from "./MutedTables";
import { Holdings } from "./Holdings";
import { RowDetail, type DetailTarget } from "./RowDetail";
import { TopLine } from "./TopLine";
import { Settings } from "./Settings";
import { useTableFit } from "./useTableFit";
import { WatchlistTable, type RowHandlers } from "./WatchlistTable";


/** Is something on screen that a reload would genuinely disturb?
 *
 *  A reload replaces every row, so there has to be a way to hold it off. This decided that by
 *  looking at what had FOCUS — any input, select, textarea or dialog — and focus is not editing.
 *
 *  2026-10-20, measured in a real browser: opening the Service panel moves focus onto its first
 *  control (`flag on`), and opening a row's detail sheet moves it onto the threshold box. So the
 *  page stopped polling for as long as either was open, with nothing being edited. The Service
 *  panel is the only place the cadence can be set, which is how "I chose 30 seconds and nothing
 *  ever refreshed" happened; and the manual button is behind the sheet and aria-hidden, so there
 *  was no way out from the keyboard or the mouse. It also defeated the detail sheet, which
 *  re-reads its row from the live list precisely so its figures stay live.
 *
 *  The protection it bought was illusory anyway. `Wipe.test.tsx` lands a reload on a half-typed
 *  threshold, with the service answering a different number, and the typed text survives: these
 *  boxes hold their own state and the components stay mounted across a poll. React was already
 *  doing what the guard claimed to be doing.
 *
 *  What a reload DOES disturb is a surface built from the data: the column picker, whose list of
 *  offered columns comes from the measured fit, and the delete confirmation, which is anchored in
 *  a row. Those two say so with `data-poll="hold"` rather than being guessed at from a role — and
 *  anything else that needs it can say so in one attribute.
 */
export function beingOperated(el: Element | null): boolean {
  return Boolean(el?.closest('[data-poll="hold"]'));
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
  // the same rows, for handlers that must not be rebuilt on every poll
  const rules = useRef<Monitor[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(15);
  const [reading, setReading] = useState(() => readSignal());
  const [grouping, setGrouping] = useState(() => readGrouping());
  const [band, setBand] = useState(() => readBand());
  const [hiddenSingle, setHiddenSingle] = useState(() => readHidden("single"));
  const [hiddenCombo, setHiddenCombo] = useState(() => readHidden("combo"));
  const [refreshing, setRefreshing] = useState(false);
  // when THIS screen last fetched, which is not when the service last did. Set only on a fetch
  // that succeeded, so it is never a claim about figures that did not arrive.
  const [polledAt, setPolledAt] = useState<string | null>(null);
  // bumped by a manual refresh, which restarts the poll interval below. `/quotes` is a LIVE
  // call, so a click one second before a tick would otherwise cost two full-watchlist
  // snapshots a second apart — the button has to displace the next poll, not add to it.
  const [pollFrom, setPollFrom] = useState(0);
  // the add sheet's subject lives here, not in AddPanel: the two triggers moved out to their
  // tables and cannot share a piece of state neither of them can see
  const [adding, setAdding] = useState<Adding>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      rules.current = m;
      setHealth(h);
      setPolledAt(new Date().toLocaleTimeString());
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
  }, [refresh, load, pollFrom]);

  /** Fetch now. Not a repaint — the figures come from `/quotes`, which asks OpenD — so it
   *  refuses to overlap itself and it resets the clock rather than queueing behind it. The
   *  poll's beingOperated guard is deliberately NOT applied: that exists to stop an automatic
   *  poll replacing rows under someone's hands, and a click is not something done to you. */
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
      setPollFrom((n) => n + 1);
    }
  }, [load]);

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
      // the rule is resolved HERE, from the /monitors state App already holds: a watchlist row
      // carries no option_type or strike, so a lone contract's holding cannot be derived from
      // the row alone, and no row component should have to hold both lists to find out.
      // Through a ref, so the handlers stay stable across polls — `act` reloads for us.
      onHolding: (row, values) => void act(
        () => recordHolding(row, rules.current.find((m) => m.id === row.id), values),
      ),
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

  return (
    <main>
      {/* the add triggers share the heading's line rather than taking a row of their own:
          everything above the tables was reduced to one line and this keeps it that way */}
      {/* the page's name and the two things you can do to the page itself. What you can CREATE
          moved to the tables that will hold it; these two are about the screen, not the data. */}
      <div className="page-head">
        <h2>optionality watchlist</h2>
        <Button variant="ghost" size="sm" aria-label="settings" onClick={() => setSettingsOpen(true)}>
          <Settings2 />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="refresh now"
          disabled={refreshing}
          onClick={() => void refreshNow()}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </div>
      {error ? <div className="banner">{error}</div> : null}

      {/* Freshness, and nothing else. The interval that used to sit in this sentence is a
          preference set once and moved into the settings sheet; what is left is the one thing
          worth reading every time you look at the screen. The two cadences stay worded
          distinctly: the SERVICE decides how fresh the figures are, the screen only decides how
          soon a new one reaches it. */}
      <p className="meta">
        {fetchedAt ? `fetched at ${fetchedAt}` : "waiting for first sweep"}
        {/* The service's figure says how fresh the FIGURES are; this one says only how recently
            they reached this screen. Both, because they answer different questions and the page
            had only the first: with the market shut no figure moves, so pressing refresh changed
            nothing visible and the button looked broken. */}
        {polledAt ? ` · screen updated ${polledAt}` : ""}
        {health ? ` · service sweeps every ${health.settings.sweep_seconds}s` : ""}
      </p>

      {/* What needs you, and nothing when nothing does — the strip this replaced said the same
          thing about faults and said it separately. It APPEARS rather than reports: a line that is
          almost always the same becomes furniture, and the old strip's own comment is the reason
          a fault must be on the page and not a click away. Its silence is not a verdict; the
          Service panel is where the complete picture lives. */}
      <TopLine quotes={quotes} health={health} />

      <WatchlistTable title="Single-leg" entries={singles} columns={singleFit.columns} containerRef={singleFit.ref} isCombo={false}
                      reading={reading} band={band} horizon={health?.settings.manage_by_dte ?? 21}
                      grouping={grouping}
                      onOpen={(entry, isCombo) => setDetail({ entry, isCombo })}
                      add={<AddTrigger which="monitor" onOpen={() => setAdding("monitor")} />}
                      picker={<ColumnPicker table="single" label="Single-leg"
                        all={SINGLE_COLUMNS.filter((c) => singleFit.offered.has(c.key))}
                        hidden={hiddenSingle} onToggle={onToggle} onReset={onReset} />} />
      <WatchlistTable title="Combos" entries={combos} columns={comboFit.columns} containerRef={comboFit.ref} isCombo={true}
                      reading={reading} band={band} horizon={health?.settings.manage_by_dte ?? 21}
                      grouping={grouping}
                      onOpen={(entry, isCombo) => setDetail({ entry, isCombo })}
                      add={<AddTrigger which="combo" onOpen={() => setAdding("combo")} />}
                      picker={<ColumnPicker table="combo" label="Combos"
                        all={COMBO_COLUMNS.filter((c) => comboFit.offered.has(c.key))}
                        hidden={hiddenCombo} onToggle={onToggle} onReset={onReset} />} />

      <AddPanel which={adding} onClose={() => setAdding(null)}
                onCreate={(body) => void act(() => createWatch(body))} />
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        quotes={quotes}
        health={health}
        reading={reading}
        band={band}
        onReading={(s) => { setReading(s); writeSignal(s); }}
        onBand={(n) => { setBand(n); writeBand(n); }}
        grouping={grouping}
        onGrouping={(g) => { setGrouping(g); writeGrouping(g); }}
        refresh={refresh}
        sweepSeconds={health?.settings.sweep_seconds}
        onRefresh={(n) => {
          setRefresh(n);
          document.cookie = `ui_refresh=${n};path=/;max-age=31536000;samesite=lax`;
        }}
      />

      <RowDetail
        entry={detailEntry}
        isCombo={detail?.isCombo ?? false}
        handlers={handlers}
        open={detail !== null}
        onOpenChange={(o) => { if (!o) setDetail(null); }}
      />
      {quotes.length === 0 && !error ? <p>Watchlist is empty.</p> : null}

      <Holdings reloadKey={pollFrom} act={act} />

      <MutedTables
        monitors={monitors}
        retentionDays={health?.settings.expired_retention_days ?? 7}
        onUnmute={(id) => void act(() => patchMonitor(id, { enabled: true }))}
        onDelete={(id) => void act(() => deleteMonitor(id))}
      />


      <Toaster />
    </main>
  );
}
