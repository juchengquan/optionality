/** Adding one contract (#331, ADR 0023): a Monitor on a single Contract — any of its six fields,
 *  either direction, either compare — and, if it is held, the lone-contract holding it warns about.
 *  Drawn where the spread form is, on the desk's panel and in the phone's Add sheet, chosen above
 *  it (`AddSpread.tsx`), so either arrangement can do what the other can.
 *
 *  What a save posts is `contract.ts`'s: a spread of ONE leg through `POST /spreads`, the spread
 *  form's own route, in one request — all of it or none, with that route's strict live probe, its
 *  linking and its replacing. A refusal — the draft's own or the service's — is said beside the box
 *  it is about, or by the button that was pressed, inside the form as the spread form says one.
 */
import { useEffect, useId, useRef, useState } from "react";

import { addSpreads, type Added, type Monitor } from "../api";
import { Button } from "@/components/ui/button";
import {
  CONTRACT_FIELDS, contractBody, contractName, contractNote, contractPreview, contractReplaces,
  contractSaveWords, refusalSpot, thresholdFault, type ContractDraft, type ContractSpot,
} from "./contract";
import { fieldWords, ruleWords } from "./needs";
import { DraftPreview } from "./Payoff";

export function AddContract({
  privacy, monitors, spx, spxReason, onSaved, onCancel, autoFocus, today, draft, setDraft, saving, setSaving,
}: {
  privacy: boolean;
  /** every rule, as `/monitors` gave them: what a held contract will replace is read from these */
  monitors: Monitor[];
  spx: number | null;
  spxReason: string | null;
  onSaved: (added: Added) => void;
  onCancel: () => void;
  autoFocus?: boolean;
  /** the New York trading day: an expiry before it has passed, and Opened may not be after it */
  today: string;
  /** kept by the caller, so switching to a spread and back loses nothing typed */
  draft: ContractDraft;
  setDraft: (d: ContractDraft) => void;
  /** a save in flight, held by the caller for both forms, so neither can send a second */
  saving: boolean;
  setSaving: (s: boolean) => void;
}) {
  const [error, setError] = useState<{ text: string; at: ContractSpot } | null>(null);
  const id = useId();
  const expiry = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) expiry.current?.focus(); }, [autoFocus]);
  const set = (change: Partial<ContractDraft>) => { setDraft({ ...draft, ...change }); setError(null); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = contractBody(draft, today);
    if ("error" in out) { setError({ text: out.error, at: out.at }); return; }
    if (saving) return;
    setSaving(true);
    try {
      onSaved(await addSpreads(out.body));
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setError({ text, at: refusalSpot(text) });
    } finally {
      setSaving(false);
    }
  };

  // the threshold the route would refuse, said beside the box as it is typed (CLAUDE.md: Alarms)
  const fault = thresholdFault(draft.compare, draft.threshold);
  const errorId = (spot: ContractSpot) => `${id}-${spot}-error`;
  /** the props that tie a box to what is said about it */
  const tie = (spot: ContractSpot) => error?.at === spot
    ? { "aria-invalid": true, "aria-describedby": errorId(spot) } : {};
  const said = (spot: ContractSpot) => error?.at === spot
    ? <p id={errorId(spot)} className="nx-add-error" role="alert">{error.text}</p> : null;
  const thresholdTie = error?.at === "threshold" ? tie("threshold")
    : fault && (draft.rule || !draft.held) ? { "aria-invalid": true, "aria-describedby": `${id}-fault` } : {};

  const held = draft.held;
  // a watched contract always has its rule: with none it would record nothing
  const ruleOn = draft.rule || !held;
  const replacing = contractReplaces(draft, monitors);
  const type = draft.option_type.toLowerCase();
  const words = `${draft.strike.trim() || "…"} ${type} `
    + ruleWords(draft.field, false, draft.compare, draft.direction, draft.threshold.trim() || "…");
  const preview = contractPreview(draft);
  return (
    <form className="nx-add nx-add-contract" aria-label="add one contract" onSubmit={(e) => void save(e)}
          data-poll="hold" noValidate>
      <div className="nx-add-row">
        <div className="nx-seg" role="group" aria-label="add as">
          <button type="button" aria-pressed={held} onClick={() => set({ held: true })}>I hold it</button>
          <button type="button" aria-pressed={!held} onClick={() => set({ held: false })}>Watch it</button>
        </div>
      </div>
      <div className="nx-add-row">
        <label className="nx-add-field">
          <span>expiry</span>
          <input ref={expiry} type="date" aria-label="expiry" value={draft.expiry} {...tie("expiry")}
                 onChange={(e) => set({ expiry: e.target.value })} />
        </label>
        {held ? (
          <label className="nx-add-field">
            <span>opened</span>
            <input type="date" aria-label="opened" value={draft.opened} {...tie("opened")}
                   onChange={(e) => set({ opened: e.target.value })} />
            <small className="nx-meta">the New York trading day</small>
          </label>
        ) : null}
      </div>
      {said("expiry")}
      {said("opened")}

      <fieldset className="nx-add-spread">
        <legend>the contract</legend>
        <div className="nx-add-split">
          <div className="nx-add-fields">
            <div className="nx-add-row">
              <div className="nx-seg" role="group" aria-label="type">
                {(["PUT", "CALL"] as const).map((t) => (
                  <button key={t} type="button" aria-pressed={draft.option_type === t}
                          onClick={() => set({ option_type: t })}>{t}</button>
                ))}
              </div>
              <label className="nx-add-field nx-add-strike">
                <span>strike</span>
                <input aria-label="strike" inputMode="decimal" value={draft.strike} autoComplete="off" {...tie("strike")}
                       onChange={(e) => set({ strike: e.target.value })} />
              </label>
            </div>
            {said("strike")}
            {held ? (
              <>
                <div className="nx-add-row">
                  <div className="nx-seg" role="group" aria-label="side">
                    {(["short", "long"] as const).map((s) => (
                      <button key={s} type="button" aria-pressed={draft.side === s}
                              onClick={() => set({ side: s })}>{s}</button>
                    ))}
                  </div>
                  <label className="nx-add-field nx-add-entry">
                    <span>{`entry ${draft.side === "short" ? "received" : "paid"}, per contract`}</span>
                    <input aria-label="entry" inputMode="decimal" value={draft.entry} autoComplete="off"
                           placeholder={draft.side === "short" ? "received" : "paid"} {...tie("entry")}
                           onChange={(e) => set({ entry: e.target.value })} />
                  </label>
                  <label className="nx-add-field nx-add-count">
                    <span>contracts</span>
                    {/* the count is hidden under privacy, as the dollars it multiplies are (ADR 0023) */}
                    <input aria-label="contracts" inputMode="numeric" value={draft.contracts}
                           className={privacy ? "nx-private" : undefined} data-private={privacy ? "" : undefined}
                           autoComplete="off" {...tie("contracts")} onChange={(e) => set({ contracts: e.target.value })} />
                  </label>
                </div>
                {said("entry")}
                {said("contracts")}
                <label className="nx-add-field nx-add-name">
                  <span>name</span>
                  <input aria-label="name" value={draft.name} autoComplete="off" {...tie("name")}
                         placeholder={namePlaceholder(draft)}
                         onChange={(e) => set({ name: e.target.value })} />
                </label>
                {said("name")}
              </>
            ) : null}

            <div className="nx-add-rule" role="group" aria-label="its rule" data-on={ruleOn ? "" : undefined}>
              {held ? (
                <div className="nx-add-monitor">
                  <button type="button" role="switch" aria-checked={draft.rule} aria-label="its Monitor"
                          className="nx-add-switch" onClick={() => set({ rule: !draft.rule })}>
                    {draft.rule ? "on" : "off"}
                  </button>
                  <small className="nx-meta">{draft.rule ? "a Monitor on this contract" : "no rule: the holding alone"}</small>
                </div>
              ) : null}
              <p className="nx-add-sentence" data-testid="contract-draft" aria-live="polite">{ruleOn ? words : "no Monitor"}</p>
              <div className="nx-add-rule-fields">
                <label className="nx-add-field">
                  <span>what it watches</span>
                  <select aria-label="what it watches" disabled={!ruleOn} value={draft.field} {...tie("field")}
                          onChange={(e) => set({ field: e.target.value })}>
                    {CONTRACT_FIELDS.map((f) => <option key={f} value={f}>{fieldWords(f, false)}</option>)}
                  </select>
                </label>
                <label className="nx-add-field">
                  <span>direction</span>
                  <select aria-label="direction" disabled={!ruleOn} value={draft.direction}
                          onChange={(e) => set({ direction: e.target.value as ContractDraft["direction"] })}>
                    <option value="above">≥ at or above</option>
                    <option value="below">≤ at or below</option>
                  </select>
                </label>
                <label className="nx-add-field">
                  <span>compare</span>
                  <select aria-label="compare" disabled={!ruleOn} value={draft.compare}
                          onChange={(e) => set({ compare: e.target.value as ContractDraft["compare"] })}>
                    <option value="abs">its size, |x|</option>
                    <option value="signed">signed</option>
                  </select>
                </label>
                <label className="nx-add-field">
                  <span>threshold</span>
                  <input aria-label="threshold" disabled={!ruleOn} inputMode="decimal" value={draft.threshold} autoComplete="off"
                         {...thresholdTie} onChange={(e) => set({ threshold: e.target.value })} />
                </label>
              </div>
              {said("field")}
              {error?.at === "threshold" ? said("threshold")
                : fault && ruleOn ? <p id={`${id}-fault`} className="nx-add-warn" role="status">{fault}</p> : null}
              {replacing.length > 0
                ? <p className="nx-meta nx-add-replaces">{`Replaces the watch rules: ${replacing.join(", ")}`}</p>
                : null}
            </div>
          </div>
          {held ? (
            <DraftPreview subject={`${id}-contract`} draft={preview} spx={spx} spxReason={spxReason}
                          blank="type the strike to see its payoff at expiry"
                          note={contractNote(draft)} />
          ) : null}
        </div>
      </fieldset>

      {said("form")}
      <div className="nx-add-row nx-add-actions">
        <Button type="submit" disabled={saving}>{saving ? "saving…" : contractSaveWords(draft)}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <p className="nx-meta">
        {held ? "One save makes all of it, or none of it if anything is refused." : "Watching a contract records no holding."}
      </p>
    </form>
  );
}

/** The name a blank box takes: the strike as the number it parses to, as the save will name it. */
function namePlaceholder(d: ContractDraft): string {
  const t = d.strike.trim();
  const n = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
  return n > 0 ? contractName(d.expiry, d.option_type, n) : "name";
}
