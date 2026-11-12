/** Editing a Monitor in place (#292): every field — what it watches, its direction, its compare and
 *  its threshold — and mute, unmute and delete, from the desk's inspector and the phone's sheet
 *  alike, so either can do what the other can (ADR 0023's parity).
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

import type { Entry } from "../api";
import { Button } from "@/components/ui/button";
import {
  deletesOn, draftOf, draftWords, fieldsFor, patchOf, QUARANTINE_WHY, ruleLabel, spotOf, stateOf,
  type Draft, type PatchBody, type Rule, type Spot,
} from "./edit";
import { fieldWords, sentence } from "./needs";
import "./monitor-edit.css";

export interface MonitorActions {
  /** a change, then the page as the service now tells it; throws the service's refusal */
  patch: (id: string, body: PatchBody) => Promise<void>;
  remove: (id: string) => Promise<void>;
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

type Mode = "idle" | "editing" | "deleting" | "enabling";

function Controls({ actions, rule, served }: { actions: MonitorActions; rule: Rule; served: Entry | null }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule));
  const [error, setError] = useState<{ text: string; at: Spot } | null>(null);
  const [busy, setBusy] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const label = ruleLabel(rule);
  const state = stateOf(rule, (actions.now?.() ?? new Date()).toISOString().slice(0, 10));

  const to = (next: Mode) => { setError(null); setMode(next); };
  const close = () => { to("idle"); editButton.current?.focus(); };

  /** One write, its refusal said where `at` says, or beside the buttons. While it is on its way
   *  every control that writes is disabled — a "keep it" pressed during a delete closed the
   *  question while the delete went through. */
  const run = async (write: () => Promise<void>, after: () => void, refocus = false) => {
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
      setError({ text, at: mode === "editing" ? spotOf(text) : "form" });
    } finally {
      setBusy(false);
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const out = patchOf(rule, draft);
    if ("error" in out) { setError({ text: out.error, at: out.at }); return; }
    if (out.body === null) { close(); return; }
    void run(() => actions.patch(rule.id, out.body!), close);
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
                onClick={() => { if (mode === "editing") { close(); return; } setDraft(draftOf(rule)); to("editing"); }}>
          edit
        </button>
        {toggle ? (
          <button type="button" className="nx-mon-button" aria-label={toggle.label} disabled={busy}
                  onClick={() => void run(() => actions.patch(rule.id, toggle.body), () => to("idle"), true)}>
            {toggle.words}
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
      {error && mode !== "editing" ? <Refusal text={error.text} /> : null}

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
