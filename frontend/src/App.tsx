import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageDown, RefreshCw, Settings2 } from "lucide-react";
import { toBlob } from "html-to-image";

import "./app.css";
import {
  createWatch, deleteMonitor, fetchHealth, fetchHoldings, fetchMonitors, fetchQuotes,
  recordHolding, patchMonitor, patchPosition, setTotalEntry,
  type Entry, type Health, type Holding, type Monitor,
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
import { clockTime } from "./format";
import { Freshness } from "./Freshness";
import { SnapshotView } from "./SnapshotView";
import { deliver, snapshotName } from "./snapshot";
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
  // the off-screen tree, mounted only while a picture is being taken
  const [shooting, setShooting] = useState(false);
  const shotRef = useRef<HTMLDivElement>(null);

  // Owned here, not in the panel: the image needs them whether or not that panel is open, and two
  // copies of the same rows is how the picture and the page come to disagree. Still fetched on
  // DEMAND — by opening the panel, by the refresh button, or by the camera — because every call
  // reaches the Provider and nothing here belongs on the poll (ADR 0010).
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);

  const loadHoldings = useCallback(async () => {
    try {
      setHoldings(await fetchHoldings());
      setHoldingsError(null);
    } catch (e: unknown) {
      // The rows are deliberately NOT cleared here. Both places that draw them print the error
      // INSTEAD of the figures, so a cost to close nobody can vouch for is already unreachable —
      // and a sweep proved it: clearing them as well changed nothing any test could see, in the
      // panel or in the picture, because the error branch comes first in both. The guard that
      // does the work is that precedence, and it is tested on both sides.
      setHoldingsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
      setPolledAt(clockTime(new Date()));
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

  /** Save the page as a PNG, for pasting into a chat.
   *
   *  The picture is NOT this screen rasterized. `useTableFit` drops columns against the viewport
   *  (ADR 0008), so a capture of the live page carries whatever subset your width allows — on a
   *  phone, a fraction of the figures. SnapshotView renders again at a fixed width with every
   *  ticked column, and that off-screen tree is what gets painted.
   *
   *  Holdings are fetched HERE, by the press. They used to be a clone of the live panel's node,
   *  which meant the picture carried them only while that panel happened to be open: the same
   *  button produced two different images depending on a disclosure triangle, and the one you get
   *  without touching anything was the one missing the money. They are rendered from the same
   *  readout the panel uses now (Holdings.HoldingReadout), so the two still cannot disagree.
   *
   *  The press therefore costs one bounded `/positions/values` call, which is the reason it was
   *  not done this way at first. It buys more than the open-panel case: the figures in the picture
   *  are then as old as its freshness line says, where a panel opened ten minutes ago was not.
   */
  const saveImage = useCallback(async () => {
    setShooting(true);
    try {
      // before the frames, so the stage is laid out WITH them: this is the one figure in the
      // picture that is not already on screen, and awaiting it here is what lets the rest of the
      // image be a single consistent instant
      await loadHoldings();
      // two frames: mounted is not laid out, and an unlaid-out tree paints as nothing
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      // the INNER node, not the stage. html-to-image copies the captured node's own computed
      // style into the SVG it paints, so capturing the stage carried `position: fixed` and
      // `left: -10000px` with it and the content landed outside the frame — a blank PNG of
      // exactly the right size, which is the one failure shape that looks like success.
      const stage = shotRef.current?.querySelector<HTMLElement>(".snapshot");
      if (!stage) return;
      const blob = await toBlob(stage, { pixelRatio: 2 });
      if (!blob) throw new Error("the image came back empty");
      const how = await deliver(blob, snapshotName());
      if (how === "downloaded") toast.add({ title: "saved as an image", type: "success" });
    } catch (e: unknown) {
      // never silence: a press that produces neither a picture nor a word is indistinguishable
      // from a broken button
      toast.add({ title: e instanceof Error ? e.message : String(e), type: "error" });
    } finally {
      setShooting(false);
    }
  }, [loadHoldings]);

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
        <Button variant="ghost" size="sm" aria-label="save as image"
                disabled={shooting} onClick={() => void saveImage()}>
          <ImageDown className={shooting ? "animate-pulse" : undefined} />
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
          worth reading every time you look at the screen. Shared with the picture (Freshness),
          so an image cannot tell a different story about its own freshness than the page. */}
      <Freshness fetchedAt={fetchedAt ?? null} polledAt={polledAt}
                 sweepSeconds={health?.settings.sweep_seconds ?? null} />

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

      <Holdings reloadKey={pollFrom} rows={holdings} error={holdingsError}
                load={loadHoldings} act={act} />

      <MutedTables
        monitors={monitors}
        retentionDays={health?.settings.expired_retention_days ?? 7}
        onUnmute={(id) => void act(() => patchMonitor(id, { enabled: true }))}
        onDelete={(id) => void act(() => deleteMonitor(id))}
      />


      {/* Off screen, not hidden: `display: none` has no layout, so there is nothing to paint.
          aria-hidden because it is a duplicate of the page for a camera, not a second copy for
          anyone reading it. */}
      {shooting ? (
        <div ref={shotRef} className="snapshot-stage" aria-hidden="true">
          <SnapshotView
            singles={singles} combos={combos} health={health}
            fetchedAt={fetchedAt ?? null} polledAt={polledAt} grouping={grouping}
            reading={reading} band={band}
            hiddenSingle={hiddenSingle} hiddenCombo={hiddenCombo}
            holdings={holdings} holdingsError={holdingsError}
          />
        </div>
      ) : null}
      <Toaster />
    </main>
  );
}
