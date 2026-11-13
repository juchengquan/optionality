/** Editing a Monitor in place (#292): every field — what it watches, its direction, its compare and
 *  its threshold, and a combo's name (#336) — and mute, unmute and delete, from the desk's inspector
 *  and the phone's sheet alike, so either can do what the other can (ADR 0023's parity).
 *
 *  And two writes that are not the rule's own but start from it (#336), each through the route
 *  today's page uses for it or the one #340 settled on:
 *  - a rule over several holdings takes a TOTAL entry, split by `POST /monitors/{id}/total-entry`,
 *    what each holding gets shown before it is saved (`edit.ts`'s `splitPreview`);
 *  - a watched single contract can be recorded as HELD, through `POST /spreads` as a spread of one
 *    leg carrying this rule, which replaces the watch rule with the holding's own in one request.
 *
 *  - The draft is said in words as it is typed; the figure and its distance beside it stay the
 *    SERVED row's, said as "as saved", because only the service measures a distance (ADR 0005).
 *    Saved, the page reloads and the sentence beside the rule is the service's new one.
 *  - A refusal is said beside the field it is about, inside the form — so inside any sheet the form
 *    is in. The old dashboard's toast was drawn underneath its form, and a refused change looked
 *    like nothing had happened (ADR 0023).
 *  - Deleting asks first; switching a quarantined rule back on says its whole reason first; an
 *    expired one says the day the service will delete it, from the retention `/health` serves.
 *
 *  The actions come from the page (`MonitorActionsContext`), so a book drawn without them — a test,
 *  or a page that cannot write — draws no controls rather than controls that do nothing.
 */
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { Added, Entry, Holding, Monitor } from "../shared/api";
import { Button } from "@/components/ui/button";
import { DASH, marketDay } from "../shared/format";
import { ruleWords as replacedWords, type SpreadsBody } from "./add";
import { refusalSpot, type ContractSpot } from "./contract";
import {
  deletesOn, draftOf, draftWords, fieldsFor, holdBody, holdDraft, holdLinks, holdOffered, patchOf,
  QUARANTINE_WHY, renameNote, ruleLabel, ruleOfMonitor, splitCounts, splitOffered, splitPreview, spotOf, stateOf,
  totalOf, uniqueName,
  type Draft, type HoldDraft, type PatchBody, type Rule, type Spot,
} from "./edit";
import { fieldWords, sentence } from "./needs";
import "./monitor-edit.css";

export interface MonitorActions {
  /** a change, then the page as the service now tells it; throws the service's refusal */
  patch: (id: string, body: PatchBody) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** a total entry split across a rule's holdings (#336); throws the service's refusal */
  totalEntry?: (id: string, entry: number) => Promise<void>;
  /** a holding recorded through `POST /spreads` (#336): what was made; throws the refusal */
  hold?: (body: SpreadsBody) => Promise<Added>;
  /** every holding's name on record, closed ones too (`GET /positions`, no market data): a new
   *  holding's name must be none of them */
  holdingNames?: () => Promise<string[]>;
  /** what those two read: every rule as `/monitors` gave them, the valued holdings (null where the
   *  page has none), and whether the owner's privacy is on */
  book?: { monitors: Monitor[]; holdings: Holding[] | null; privacy: boolean };
  /** `/health`'s `expired_retention_days`, or null until it has answered */
  retentionDays: number | null;
  /** the clock, injected by tests; the page's is the real one */
  now?: () => Date;
}

export const MonitorActionsContext = createContext<MonitorActions | null>(null);

/** @param served the rule's row of `/quotes`, for a rule that is on: its sentence is the service's */
export function MonitorControls({ rule, served }: { rule: Rule; served: Entry | null }) {
  const actions = useContext(MonitorActionsContext);
  return actions ? <Controls actions={actions} rule={rule} served={served} /> : null;
}

type Mode = "idle" | "editing" | "deleting" | "enabling" | "splitting" | "holding";

function Controls({ actions, rule, served }: { actions: MonitorActions; rule: Rule; served: Entry | null }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule));
  // the rule as it was when the editor opened: the draft is a change to THAT, so a poll serving a
  // rename made elsewhere meanwhile is not sent back as the old name (#336)
  const [opened, setOpened] = useState<Rule>(rule);
  const [error, setError] = useState<{ text: string; at: Spot } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saidSplit, setSaidSplit] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const splitButton = useRef<HTMLButtonElement>(null);
  const holdButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const label = ruleLabel(rule);
  const now = actions.now?.() ?? new Date();
  const state = stateOf(rule, now.toISOString().slice(0, 10));
  const book = actions.book;
  const splits = Boolean(actions.totalEntry && book) && splitOffered(rule);
  const holds = Boolean(actions.hold && book) && holdOffered(rule);

  const to = (next: Mode) => { setError(null); setSaidSplit(false); setMode(next); };
  const close = () => { to("idle"); editButton.current?.focus(); };
  /** back to the button that opened the form */
  const back = (button: React.RefObject<HTMLButtonElement | null>) => { to("idle"); button.current?.focus(); };

  /** One write, its refusal said where `at` says, or beside the buttons. While it is on its way
   *  every control that writes is disabled — a "keep it" pressed during a delete closed the
   *  question while the delete went through. */
  const run = async (
    write: () => Promise<void>, after: () => void, refocus = false,
    spot: (text: string) => Spot = (text) => (mode === "editing" ? spotOf(text) : "form"),
  ) => {
    setBusy(true);
    setError(null);
    // where the focus goes if this rule leaves: the surface it was drawn in, found BEFORE the page
    // reloads and takes the rule — and with it the focused button — somewhere else or nowhere
    const home = refocus ? homeOf(root.current) : null;
    try {
      await write();
      after();
      if (refocus) setTimeout(() => settleFocus(root.current, editButton.current, home), 0);
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : String(e);
      setError({ text, at: spot(text) });
    } finally {
      setBusy(false);
    }
  };

  /** A holding recorded: the rule is replaced by the holding's own, so it leaves this place, and the
   *  focus goes where `settleFocus` sends it. A refusal is thrown back to the form, which files it. */
  const holdIt = async (body: SpreadsBody) => {
    setBusy(true);
    const home = homeOf(root.current);
    try {
      await actions.hold!(body);
    } catch (e) {
      setBusy(false);
      throw e;
    }
    // committed NOW, not batched: the focus below goes to the edit button, which is disabled until
    // `busy` is drawn false, and a batch landing after the timer left the focus on the body
    flushSync(() => { setBusy(false); to("idle"); });
    setTimeout(() => settleFocus(root.current, editButton.current, home), 0);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const out = patchOf(opened, draft);
    if ("error" in out) { setError({ text: out.error, at: out.at }); return; }
    if (out.body === null) { close(); return; }
    const body = out.body;
    void run(() => actions.patch(rule.id, body), close, false, (text) => spotOf(text, body, opened));
  };

  // the whole reason, while the rule is still quarantined: a write lands and the page reloads before
  // this form's own state moves on, so the row can be back on while the question is still asked
  const why = state === "quarantined" ? QUARANTINE_WHY[rule.disabled_reason!]!(rule) : null;
  // unmuting a rule switched off with its holding watches contracts nobody holds: the button says so
  const toggle = state === "on" ? { words: "mute", label: `mute ${label}`, body: { enabled: false } }
    : state === "muted" ? (rule.disabled_reason === "holding-closed"
      ? { words: "unmute (no longer held)", label: `unmute ${label}, no longer held`, body: { enabled: true } }
      : { words: "unmute", label: `unmute ${label}`, body: { enabled: true } }) : null;

  return (
    <div className="nx-mon" ref={root}>
      {state === "expired" ? (
        <p className="nx-meta nx-mon-note">
          {`expired ${rule.strike_date} — the service deletes it ${actions.retentionDays === null
            ? "after its retention window" : `on ${deletesOn(rule.strike_date, actions.retentionDays)}`}`}
        </p>
      ) : null}
      {why !== null && mode !== "enabling" ? <p className="nx-mon-note">{`Switched off by the service: ${why}.`}</p> : null}

      <div className="nx-mon-actions">
        <button ref={editButton} type="button" className="nx-mon-button" aria-label={`edit ${label}`}
                disabled={busy} aria-expanded={mode === "editing"}
                onClick={() => { if (mode === "editing") { close(); return; } setOpened(rule); setDraft(draftOf(rule)); to("editing"); }}>
          edit
        </button>
        {toggle ? (
          <button type="button" className="nx-mon-button" aria-label={toggle.label} disabled={busy}
                  onClick={() => void run(() => actions.patch(rule.id, toggle.body), () => to("idle"), true)}>
            {toggle.words}
          </button>
        ) : null}
        {splits ? (
          <button ref={splitButton} type="button" className="nx-mon-button"
                  aria-label={`split a total entry across ${label}`} disabled={busy}
                  aria-expanded={mode === "splitting"}
                  onClick={() => (mode === "splitting" ? back(splitButton) : to("splitting"))}>
            split entry
          </button>
        ) : null}
        {holds ? (
          <button ref={holdButton} type="button" className="nx-mon-button" aria-label={`I hold ${label}`}
                  disabled={busy} aria-expanded={mode === "holding"}
                  onClick={() => (mode === "holding" ? back(holdButton) : to("holding"))}>
            I hold this
          </button>
        ) : null}
        {state === "quarantined" ? (
          <button type="button" className="nx-mon-button" aria-label={`switch ${label} back on`}
                  disabled={busy} aria-expanded={mode === "enabling"} onClick={() => to("enabling")}>
            switch back on
          </button>
        ) : null}
        <button type="button" className="nx-mon-button" data-destructive="" aria-label={`delete ${label}`}
                disabled={busy} aria-expanded={mode === "deleting"} onClick={() => to("deleting")}>
          delete
        </button>
      </div>
      {error && !["editing", "splitting", "holding"].includes(mode) ? <Refusal text={error.text} /> : null}
      {/* mounted empty and filled, so a screen reader announces it; only where a split is offered */}
      {splits ? <p className="nx-meta" role="status">{saidSplit ? "total entry saved" : ""}</p> : null}

      {mode === "deleting" ? (
        <Ask label={`delete ${label}?`} yes="delete it" no="keep it" busy={busy} destructive
             onYes={() => void run(() => actions.remove(rule.id), () => to("idle"), true)} onNo={close}>
          Delete this Monitor for good? The service forgets it; a holding it watched is kept.
        </Ask>
      ) : null}
      {mode === "enabling" && why !== null ? (
        <Ask label={`switch ${label} back on?`} yes="switch it on" no="keep it off" busy={busy}
             onYes={() => void run(() => actions.patch(rule.id, { enabled: true }), () => to("idle"), true)}
             onNo={close}>
          {`Switched off by the service: ${why}. Switch it back on once that is fixed: the next sweep `
            + "checks it again, and switches it off again if nothing has changed."}
        </Ask>
      ) : null}
      {mode === "editing" ? (
        <EditForm rule={rule} served={served} label={label} draft={draft} busy={busy} error={error}
                  onDraft={(d) => { setDraft(d); setError(null); }} onSave={save} onCancel={close} />
      ) : null}
      {mode === "splitting" && book && actions.totalEntry ? (
        <SplitForm rule={rule} label={label} book={book} busy={busy} error={error}
                   onError={(text) => setError(text === null ? null : { text, at: "threshold" })}
                   onCancel={() => back(splitButton)}
                   onSave={(entry) => run(() => actions.totalEntry!(rule.id, entry),
                     () => { back(splitButton); setSaidSplit(true); }, false, () => "threshold")} />
      ) : null}
      {mode === "holding" && book && actions.hold ? (
        <HoldForm rule={rule} label={label} book={book} today={marketDay(now)} busy={busy}
                  holdingNames={actions.holdingNames}
                  onCancel={() => back(holdButton)}
                  onSave={holdIt} />
      ) : null}
    </div>
  );
}

/** The surface a rule's controls are drawn in: the phone's sheet, the desk's inspector, a section. */
function homeOf(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>('[role="dialog"], aside, details, section') ?? null;
}

/** Where the focus goes after a write that may have moved the rule: its own edit button while it is
 *  still drawn here; else the heading of the surface it was in (or a folded list's summary); else
 *  the page's first heading. Never left on the body, where the next Tab starts from the top. */
function settleFocus(root: HTMLElement | null, edit: HTMLElement | null, home: HTMLElement | null) {
  if (root?.isConnected && edit) { edit.focus(); return; }
  const place = home?.isConnected ? home : document.querySelector<HTMLElement>(".nx-main");
  const target = place instanceof HTMLDetailsElement ? place.querySelector<HTMLElement>("summary")
    : place?.querySelector<HTMLElement>("h2, h3, h4") ?? null;
  if (!target) return;
  if (!target.matches("summary") && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

function Refusal({ text, id }: { text: string; id?: string }) {
  return <p id={id} className="nx-mon-error" role="alert">{text}</p>;
}

/** A question asked in place, its safe answer focused so an Enter pressed by habit keeps things as
 *  they are. In place rather than a dialog: inside the phone's sheet a second dialog would stack. */
function Ask({ label, yes, no, busy, destructive, onYes, onNo, children }: {
  label: string; yes: string; no: string; busy: boolean; destructive?: boolean;
  onYes: () => void; onNo: () => void; children: React.ReactNode;
}) {
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => { safe.current?.focus(); }, []);
  return (
    <div className="nx-mon-ask" role="group" aria-label={label} data-poll="hold"
         onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onNo(); } }}>
      <p>{children}</p>
      <div className="nx-mon-actions">
        <Button type="button" size="sm" variant={destructive ? "destructive" : "default"} disabled={busy}
                onClick={onYes}>{yes}</Button>
        <Button ref={safe} type="button" size="sm" variant="ghost" disabled={busy} onClick={onNo}>{no}</Button>
      </div>
    </div>
  );
}

function EditForm({ rule, served, label, draft, busy, error, onDraft, onSave, onCancel }: {
  rule: Rule; served: Entry | null; label: string; draft: Draft; busy: boolean;
  error: { text: string; at: Spot } | null;
  onDraft: (d: Draft) => void; onSave: (e: React.FormEvent) => void; onCancel: () => void;
}) {
  const id = useId();
  const threshold = useRef<HTMLInputElement>(null);
  useEffect(() => { threshold.current?.focus(); }, []);
  const set = (change: Partial<Draft>) => onDraft({ ...draft, ...change });
  /** the props that tie a control to its refusal, when it has one */
  const tie = (spot: Spot) => error?.at === spot
    ? { "aria-invalid": true, "aria-describedby": `${id}-${spot}-error` } : {};
  const said = (spot: Spot) => error?.at === spot ? <Refusal id={`${id}-${spot}-error`} text={error.text} /> : null;

  return (
    <form className="nx-mon-form" aria-label={`editing ${label}`} data-poll="hold" noValidate onSubmit={onSave}
          onKeyDown={(e) => {
            // Escape is the form's: it cancels the edit and goes no further, so the desk's
            // inspector, which closes on an Escape nobody handled, stays open
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
          }}>
      <p className="nx-mon-draft" data-testid="draft" aria-live="polite">{draftWords(rule, draft)}</p>
      {served ? <p className="nx-meta" data-testid="served">{`as saved: ${sentence(served)}`}</p> : null}
      <div className="nx-mon-fields">
        {rule.combo ? (
          <div className="nx-mon-field nx-mon-name">
            <label htmlFor={`${id}-name`}>name</label>
            <input id={`${id}-name`} autoComplete="off" value={draft.name}
                   onChange={(e) => set({ name: e.target.value })} {...tie("name")} />
            {said("name")}
            {renameNote(rule) ? <small className="nx-meta">{renameNote(rule)}</small> : null}
          </div>
        ) : null}
        <div className="nx-mon-field">
          <label htmlFor={`${id}-field`}>what it watches</label>
          <select id={`${id}-field`} value={draft.field} onChange={(e) => set({ field: e.target.value })} {...tie("field")}>
            {fieldsFor(rule).map((f) => <option key={f} value={f}>{fieldWords(f, rule.combo)}</option>)}
          </select>
          {said("field")}
        </div>
        <div className="nx-mon-field">
          <label htmlFor={`${id}-direction`}>direction</label>
          <select id={`${id}-direction`} value={draft.direction} onChange={(e) => set({ direction: e.target.value })}
                  {...tie("direction")}>
            <option value="above">≥ at or above</option>
            <option value="below">≤ at or below</option>
          </select>
          {said("direction")}
        </div>
        <div className="nx-mon-field">
          <label htmlFor={`${id}-compare`}>compare</label>
          <select id={`${id}-compare`} value={draft.compare} onChange={(e) => set({ compare: e.target.value })}
                  {...tie("compare")}>
            <option value="abs">its size, |x|</option>
            <option value="signed">signed</option>
          </select>
          {said("compare")}
        </div>
        <div className="nx-mon-field">
          <label htmlFor={`${id}-threshold`}>threshold</label>
          <input ref={threshold} id={`${id}-threshold`} inputMode="decimal" autoComplete="off" value={draft.threshold}
                 onChange={(e) => set({ threshold: e.target.value })} {...tie("threshold")} />
          {said("threshold")}
        </div>
      </div>
      {said("form")}
      <div className="nx-mon-actions">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "saving…" : "save"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>cancel</Button>
      </div>
    </form>
  );
}

/** A points figure as the service stores one: two places, or as many as four where it has them —
 *  a derived Entry is rounded to four (`round4`), and showing two would hide what was written. */
function points(n: number | null | undefined): string {
  if (n === undefined) return "not read";
  if (n === null) return DASH;
  const places = String(Number(n.toFixed(4))).split(".")[1]?.length ?? 0;
  return n.toFixed(Math.max(2, places));
}

/** Escape is the form's: it cancels and goes no further, so neither the desk's inspector nor the
 *  phone's sheet — whose dismissal does not ask whether the key was handled — closes under it. */
const escapeCancels = (onCancel: () => void, busy = false) => (e: React.KeyboardEvent) => {
  // and while a save is on its way it cancels nothing: the form stays to say how the save went,
  // a refusal included, rather than going and leaving a late refusal nowhere to be said
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!busy) onCancel(); }
};

/** A total entry across the holdings a rule covers (#336), with what each gets before it is saved.
 *  The refusal — the draft's or the service's — is said beside the box, the one thing typed here. */
function SplitForm({ rule, label, book, busy, error, onError, onSave, onCancel }: {
  rule: Rule; label: string; book: NonNullable<MonitorActions["book"]>; busy: boolean;
  error: { text: string } | null; onError: (text: string | null) => void;
  onSave: (entry: number) => Promise<void>; onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  // a REF as well as `busy`: two submits in one tick both read `busy` from before either set it
  const sending = useRef(false);
  const counts = splitCounts(rule, book.holdings, book.privacy);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const total = totalOf(text);
  const preview = splitPreview(rule, "entry" in total ? total.entry : null, book.monitors, book.holdings);
  const anyDerived = preview.rows.some((r) => r.derived);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if ("error" in total) { onError(total.error); return; }
    if (sending.current) return;
    sending.current = true;
    void onSave(total.entry).finally(() => { sending.current = false; });
  };
  return (
    <form className="nx-mon-form" aria-label={`split a total entry across ${label}`} data-poll="hold" noValidate
          onSubmit={save} onKeyDown={escapeCancels(onCancel, busy)}>
      <div className="nx-mon-fields">
        <div className="nx-mon-field">
          <label htmlFor={`${id}-total`}>total entry, per contract</label>
          <input ref={box} id={`${id}-total`} inputMode="decimal" autoComplete="off" value={text}
                 placeholder="credit +, debit −" aria-invalid={error ? true : undefined}
                 aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
                 onChange={(e) => { setText(e.target.value); onError(null); }} />
          {error ? <Refusal id={`${id}-error`} text={error.text} /> : null}
          <small id={`${id}-hint`} className="nx-meta">signed as an Entry: received positive, paid negative</small>
        </div>
      </div>
      <table className="nx-mon-split">
        <thead><tr><th scope="col">holding</th><th scope="col">entry now</th><th scope="col">after</th></tr></thead>
        <tbody>
          {preview.rows.map((r) => (
            <tr key={r.id} data-derived={r.derived ? "" : undefined}>
              <th scope="row">{r.name}</th>
              <td>{points(r.now)}</td>
              <td>{r.derived
                ? (r.after === undefined ? "the rest" : `${points(r.after)} — the rest`)
                : `${points(r.after)} — ${anyDerived ? "kept: it has a rule of its own" : "unchanged"}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {counts ? <p className="nx-mon-note" data-testid="split-counts">{counts}</p> : null}
      {preview.why ? (
        <p className="nx-mon-note" data-testid="split-why">{`The service will refuse this: ${preview.why}.`}</p>
      ) : null}
      <p className="nx-meta">
        The service writes one holding: the one no rule watches alone takes the total less the others&apos;
        Entries, so each holding&apos;s own Entry stays the one record of what it took in.
      </p>
      <div className="nx-mon-actions">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "saving…" : "save the split"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>cancel</Button>
      </div>
    </form>
  );
}

/** Where a holding's refusal is said: beside the four boxes this form has, or by its button. */
const holdSpot = (at: ContractSpot): "entry" | "contracts" | "opened" | "name" | "form" =>
  at === "entry" || at === "contracts" || at === "opened" || at === "name" ? at : "form";

/** Recording a holding of a watched contract (#336): what the add form's one-contract draft would
 *  post held, with THIS rule as it is saved, so the route replaces the watch rule with the
 *  holding's own in the same request (`edit.ts`'s `holdBody`). */
function HoldForm({ rule, label, book, today, busy, holdingNames, onSave, onCancel }: {
  rule: Rule; label: string; book: NonNullable<MonitorActions["book"]>; today: string; busy: boolean;
  holdingNames?: () => Promise<string[]>;
  /** throws the service's refusal, which this form files beside the box it is about */
  onSave: (body: SpreadsBody) => Promise<void>; onCancel: () => void;
}) {
  const id = useId();
  // named apart from every holding open now, and once they are read, from every one on record
  const [draft, setDraft] = useState<HoldDraft>(() => {
    const d = holdDraft(rule, today);
    return { ...d, name: uniqueName(d.name, (book.holdings ?? []).map((h) => h.name)) };
  });
  const named = useRef(false);
  useEffect(() => {
    let live = true;
    holdingNames?.().then((names) => {
      if (!live || named.current) return;
      setDraft((d) => ({ ...d, name: uniqueName(holdDraft(rule, today).name, names) }));
    }).catch(() => undefined);
    return () => { live = false; };
    // asked once, when the form opens
  }, []);
  const [error, setError] = useState<{ text: string; at: ReturnType<typeof holdSpot> } | null>(null);
  // a REF as well as `busy`: two presses in one tick both read `busy` from before either set it
  const sending = useRef(false);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const set = (change: Partial<HoldDraft>) => { setDraft((d) => ({ ...d, ...change })); setError(null); };
  const links = holdLinks(rule, book.monitors, book.holdings);
  const replaced = links.replaced.map(replacedWords);
  const tie = (spot: string) => error?.at === spot
    ? { "aria-invalid": true, "aria-describedby": `${id}-${spot}-error` } : {};
  const said = (spot: string) => error?.at === spot ? <Refusal id={`${id}-${spot}-error`} text={error.text} /> : null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending.current) return;
    const out = holdBody(rule, draft, today);
    if ("error" in out) { setError({ text: out.error, at: holdSpot(out.at) }); return; }
    sending.current = true;
    try {
      await onSave(out.body);
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      // a holding's name taken beside the name (`refusalSpot`); anything else — an unknown
      // contract, a rule another holding owns, a service down — by the button
      setError({ text, at: refusalSpot(text) === "name" ? "name" : "form" });
    } finally {
      sending.current = false;
    }
  };

  return (
    <form className="nx-mon-form" aria-label={`record a holding of ${label}`} data-poll="hold" noValidate
          onSubmit={(e) => void save(e)} onKeyDown={escapeCancels(onCancel, busy)}>
      {/* the same field, direction and compare, on a rule that is on: the route keeps its alarm
          (`editedMonitor`'s rule, #292) */}
      <p className="nx-mon-note" data-testid="hold-replaces">
        {`Replaces the watch rule ${replaced.length > 0 ? replaced.join(", ") : "on it"} with the holding's own, `
          + "the same rule, linked to it: its alarm carries over, so a ringing rule does not say it crossed again."}
      </p>
      <p className="nx-mon-note" data-testid="hold-links">
        {!links.known
          ? "The holdings have not been read, so which other Monitors it takes is the service's to say once it is saved."
          : links.linked.length === 0 ? "No other Monitor is linked to it."
            : "Also linked to it, by the service, as it links every rule no holding owns: "
              + links.linked.map(({ monitor, scope, watchlist }) => `${ruleLabel(ruleOfMonitor(monitor))} — ${scope === "all"
                ? "as covering the whole of it, so that row reads this holding's Entry and P&L" : "as one leg of it"}${watchlist
                // drawn where the book will draw it (placement.ts, #346)
                ? "; it is drawn in the Watchlist, with a note of the contracts it shares" : ""}`)
                .join("; ") + "."}
      </p>
      <div className="nx-mon-fields">
        <div className="nx-mon-field">
          <label htmlFor={`${id}-side`}>side</label>
          <select ref={first} id={`${id}-side`} value={draft.side}
                  onChange={(e) => set({ side: e.target.value as HoldDraft["side"] })}>
            <option value="short">short — sold</option>
            <option value="long">long — bought</option>
          </select>
        </div>
        <div className="nx-mon-field">
          <label htmlFor={`${id}-entry`}>entry, per contract</label>
          <input id={`${id}-entry`} inputMode="decimal" autoComplete="off" value={draft.entry} placeholder="unknown"
                 onChange={(e) => set({ entry: e.target.value })} {...tie("entry")} />
          {said("entry")}
          <small className="nx-meta">
            {`${draft.side === "short" ? "received" : "paid"}, per contract — the side signs it`}
          </small>
        </div>
        <div className="nx-mon-field">
          <label htmlFor={`${id}-contracts`}>contracts</label>
          {/* the count is hidden under privacy, as the dollars it multiplies are (ADR 0023) */}
          <input id={`${id}-contracts`} inputMode="numeric" autoComplete="off" value={draft.contracts}
                 className={book.privacy ? "nx-private" : undefined} data-private={book.privacy ? "" : undefined}
                 onChange={(e) => set({ contracts: e.target.value })} {...tie("contracts")} />
          {said("contracts")}
        </div>
        <div className="nx-mon-field">
          <label htmlFor={`${id}-opened`}>opened</label>
          <input id={`${id}-opened`} type="date" value={draft.opened} onChange={(e) => set({ opened: e.target.value })}
                 {...tie("opened")} />
          {said("opened")}
          <small className="nx-meta">the New York trading day</small>
        </div>
        <div className="nx-mon-field">
          <label htmlFor={`${id}-name`}>name</label>
          <input id={`${id}-name`} autoComplete="off" value={draft.name}
                 onChange={(e) => { named.current = true; set({ name: e.target.value }); }} {...tie("name")} />
          {said("name")}
        </div>
      </div>
      <p className="nx-meta">
        One request, all of it or none, through the add form&apos;s route: the holding of this one contract,
        and this rule made again as its own.
      </p>
      {said("form")}
      <div className="nx-mon-actions">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "recording…" : "Record holding"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>cancel</Button>
      </div>
    </form>
  );
}
