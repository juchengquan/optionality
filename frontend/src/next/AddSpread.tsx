/** Adding a spread in one step, with its Monitors and a payoff preview (#293, ADR 0023): a panel
 *  on the desk, and the phone's Add tab opening it as a bottom sheet. The same form in both, so
 *  either can do what the other can (ADR 0023's parity).
 *
 *  What a save posts is `add.ts`'s; this draws the draft and says what went wrong. A refusal — the
 *  draft's own, or the service's — is said INSIDE the form, by the button that was pressed: the old
 *  form's toast was drawn underneath it, and a refused form looked like nothing had happened.
 *
 *  The same place adds ONE contract (#331): a choice above the form, and `AddContract.tsx` in the
 *  spread form's stead. Each draft is kept here, so switching back and forth loses neither.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { addSpreads, type Added, type Monitor, type Payoff } from "../api";
import { Button } from "@/components/ui/button";
import { marketDay } from "../format";
import {
  addLeg, addSpread, deltaEnabled, derivedName, deltaShown, flipSide, MAX_LEGS, MIN_LEGS, newDraft, previewOf,
  removeLeg, removeSpread, replaces, saveWords, setLeg, setSpread, spreadsBody, stopWarning, valueEnabled,
  valueHint, valueShown, type AddDraft, type Preset, type SpreadDraft,
} from "./add";
import { AddContract } from "./AddContract";
import { newContract, type ContractDraft } from "./contract";
import { DraftPreview } from "./Payoff";
import "./add.css";

type Props = {
  privacy: boolean;
  /** every rule, as `/monitors` gave them: what a held spread will replace is read from these */
  monitors: Monitor[];
  /** SPX's derived price from the book's last batch, for the preview's marker, or null */
  spx: number | null;
  spxReason: string | null;
  onSaved: (added: Added) => void;
  onCancel: () => void;
  /** take the focus on opening: the desk's panel does; the phone's sheet moves it itself */
  autoFocus?: boolean;
  /** injected only by tests: Opened starts as the New York trading day on this clock */
  now?: Date;
};

/** What to add — a spread, or one contract — and the form for it. */
export function AddSpread(props: Props) {
  const [kind, setKind] = useState<"spread" | "contract">("spread");
  // the focus goes into the form when it opens, and stays on the choice when the choice is changed
  const [chosen, setChosen] = useState(false);
  const choose = (k: "spread" | "contract") => { setKind(k); setChosen(true); };
  const [spread, setSpreadDraft] = useState<AddDraft>(() => newDraft(marketDay(props.now)));
  const [contract, setContract] = useState<ContractDraft>(() => newContract(marketDay(props.now)));
  // one save in flight for the whole place, not per form: switching form mid-save would otherwise
  // mount a fresh save button that sends the same thing again (review of #340)
  const [saving, setSaving] = useState(false);
  return (
    <div className="nx-add-what">
      <div className="nx-seg" role="group" aria-label="what to add">
        <button type="button" aria-pressed={kind === "spread"} disabled={saving} onClick={() => choose("spread")}>a spread</button>
        <button type="button" aria-pressed={kind === "contract"} disabled={saving} onClick={() => choose("contract")}>one contract</button>
      </div>
      {kind === "spread"
        ? <SpreadForm {...props} autoFocus={props.autoFocus && !chosen} draft={spread} setDraft={setSpreadDraft}
                      saving={saving} setSaving={setSaving} />
        : <AddContract privacy={props.privacy} monitors={props.monitors} spx={props.spx} spxReason={props.spxReason}
                       onSaved={props.onSaved} onCancel={props.onCancel} today={marketDay(props.now)}
                       draft={contract} setDraft={setContract} saving={saving} setSaving={setSaving} />}
    </div>
  );
}

function SpreadForm({
  privacy, monitors, spx, spxReason, onSaved, onCancel, autoFocus, draft, setDraft, saving, setSaving,
}: Props & {
  draft: AddDraft; setDraft: (d: AddDraft) => void; saving: boolean; setSaving: (s: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const change = (next: AddDraft) => { setDraft(next); setError(null); };
  const expiry = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) expiry.current?.focus(); }, [autoFocus]);
  const replacing = replaces(draft, monitors);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = spreadsBody(draft);
    if ("error" in out) { setError(out.error); return; }
    if (saving) return;
    setSaving(true);
    try {
      onSaved(await addSpreads(out.body));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const held = draft.held;
  return (
    <form className="nx-add" aria-label="add a spread" onSubmit={(e) => void save(e)} data-poll="hold" noValidate>
      <div className="nx-add-row">
        <div className="nx-seg" role="group" aria-label="add as">
          <button type="button" aria-pressed={held} onClick={() => change({ ...draft, held: true })}>I hold it</button>
          <button type="button" aria-pressed={!held} onClick={() => change({ ...draft, held: false })}>Watch it</button>
        </div>
      </div>
      <div className="nx-add-row">
        <label className="nx-add-field">
          <span>expiry</span>
          <input ref={expiry} type="date" aria-label="expiry" value={draft.expiry}
                 onChange={(e) => change({ ...draft, expiry: e.target.value })} />
        </label>
        {held ? (
          <label className="nx-add-field">
            <span>opened</span>
            <input type="date" aria-label="opened" value={draft.opened}
                   onChange={(e) => change({ ...draft, opened: e.target.value })} />
            <small className="nx-meta">the New York trading day</small>
          </label>
        ) : null}
      </div>

      {draft.spreads.map((s, i) => (
        <SpreadFields key={s.key} index={i} spread={s} draft={draft} privacy={privacy} id={id}
                      replacing={replacing[i] ?? []}
                      spx={spx} spxReason={spxReason} onChange={change}
                      onRemove={draft.spreads.length > 1 ? () => change(removeSpread(draft, s.key)) : null} />
      ))}

      <div className="nx-add-row nx-add-more" role="group" aria-label="add another">
        {(["put", "call", "condor"] as Preset[]).map((p) => (
          <button key={p} type="button" className="nx-add-ghost" onClick={() => change(addSpread(draft, p))}>
            <Plus aria-hidden="true" />{PRESET_WORDS[p]}
          </button>
        ))}
      </div>

      {error ? <p className="nx-add-error" role="alert">{error}</p> : null}
      <div className="nx-add-row nx-add-actions">
        <Button type="submit" disabled={saving}>{saving ? "saving…" : saveWords(draft)}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <p className="nx-meta">One save makes all of it, or none of it if anything is refused.</p>
    </form>
  );
}

const PRESET_WORDS: Record<Preset, string> = {
  put: "put spread", call: "call spread", condor: "condor as one holding",
};

function SpreadFields({ index, spread: s, draft, privacy, id, replacing, spx, spxReason, onChange, onRemove }: {
  index: number; spread: SpreadDraft; draft: AddDraft; privacy: boolean; id: string;
  /** the watch rules saving this spread will replace, in words */
  replacing: string[];
  spx: number | null; spxReason: string | null;
  onChange: (d: AddDraft) => void; onRemove: (() => void) | null;
}) {
  const n = index + 1;
  const held = draft.held;
  const set = (change: Partial<SpreadDraft>) => onChange(setSpread(draft, s.key, change));
  const preview = previewOf(draft, s);
  const credit = preview?.entry ?? 0;
  // the payoff the preview was served, which the stop's warning reads its ceiling from
  const [drawn, setDrawn] = useState<{ key: string; payoff: Payoff } | null>(null);
  const warning = stopWarning(draft, s, drawn);
  const valueOn = valueEnabled(held, s);
  const deltaOn = deltaEnabled(s);
  const shorts = s.legs.filter((l) => l.side === "short").length;
  return (
    <fieldset className="nx-add-spread" data-spread={n}>
      <legend>{`spread ${n}`}</legend>
      <div className="nx-add-split">
        <div className="nx-add-fields">
          <label className="nx-add-field nx-add-name">
            <span>name</span>
            <input aria-label={`spread ${n} name`} value={s.name} placeholder={derivedName(draft.expiry, s.legs)}
                   onChange={(e) => set({ name: e.target.value })} />
          </label>
          <ol className="nx-add-legs">
            {s.legs.map((l, j) => (
              <li key={j} className="nx-add-leg" data-side={l.side}>
                <button type="button" className="nx-add-toggle" data-side={l.side}
                        aria-label={`spread ${n}, leg ${j + 1} side: ${l.side} — flip`}
                        onClick={() => onChange(flipSide(draft, s.key, j))}>{l.side}</button>
                <button type="button" className="nx-add-toggle"
                        aria-label={`spread ${n}, leg ${j + 1} type: ${l.option_type} — change`}
                        onClick={() => onChange(setLeg(draft, s.key, j, { option_type: l.option_type === "PUT" ? "CALL" : "PUT" }))}>
                  {l.option_type}
                </button>
                <input aria-label={`spread ${n}, leg ${j + 1} strike`} inputMode="decimal" value={l.strike}
                       placeholder="strike" onChange={(e) => onChange(setLeg(draft, s.key, j, { strike: e.target.value }))} />
                {s.legs.length > MIN_LEGS ? (
                  <button type="button" className="nx-add-toggle nx-add-unleg" aria-label={`remove spread ${n}, leg ${j + 1}`}
                          onClick={() => onChange(removeLeg(draft, s.key, j))}>
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {s.legs.length < MAX_LEGS ? (
            <button type="button" className="nx-add-ghost" aria-label={`spread ${n}: add a leg`}
                    onClick={() => onChange(addLeg(draft, s.key))}>
              <Plus aria-hidden="true" />leg
            </button>
          ) : null}
          {held ? (
            <div className="nx-add-row">
              <label className="nx-add-field">
                <span>entry, per contract</span>
                <input aria-label={`spread ${n} entry`} inputMode="decimal" value={s.entry} placeholder="credit +, debit −"
                       onChange={(e) => set({ entry: e.target.value })} />
              </label>
              <label className="nx-add-field nx-add-count">
                <span>contracts</span>
                {/* the count is hidden under privacy, as the dollars it multiplies are (ADR 0023) */}
                <input aria-label={`spread ${n} contracts`} inputMode="numeric" value={s.contracts}
                       className={privacy ? "nx-private" : undefined} data-private={privacy ? "" : undefined}
                       autoComplete="off" onChange={(e) => set({ contracts: e.target.value })} />
              </label>
            </div>
          ) : null}
          <div className="nx-add-monitors" role="group" aria-label={`spread ${n}'s Monitors`}>
            <MonitorLine on={valueOn} onToggle={() => set({ valueOn: !valueOn })} label={`spread ${n} value Monitor`}
                         words="spread value ≥" hint={valueHint(held, s)}
                         value={valueShown(held, s)} onValue={(v) => set({ valueAt: v })}
                         inputLabel={`spread ${n} value threshold`} />
            <MonitorLine on={deltaOn} onToggle={() => set({ deltaOn: !deltaOn })} label={`spread ${n} delta Monitor`}
                         words={`short leg${shorts === 1 ? "'s" : "s'"} |Δ| ≥`}
                         hint={shorts === 0 ? "no short leg to watch" : held ? "risk" : "an entry signal"}
                         value={deltaShown(held, s)} onValue={(v) => set({ deltaAt: v })}
                         inputLabel={`spread ${n} delta threshold`} />
          </div>
          {warning ? <p className="nx-add-warn" role="status" aria-label={`spread ${n}'s stop`}>{warning}</p> : null}
          {replacing.length > 0
            ? <p className="nx-meta nx-add-replaces">{`Replaces the watch rules: ${replacing.join(", ")}`}</p>
            : null}
          {onRemove ? (
            <button type="button" className="nx-add-ghost" aria-label={`remove spread ${n}`} onClick={onRemove}>
              <X aria-hidden="true" />remove
            </button>
          ) : null}
        </div>
        <DraftPreview subject={`${id}-${s.key}`} draft={preview} spx={spx} spxReason={spxReason} onDrawn={setDrawn}
                      blank="type the strikes to see its payoff at expiry"
                      note={`per contract, at ${Math.abs(credit).toFixed(2)} ${credit < 0 ? "debit" : "credit"}${held ? "" : ": the value it watches for"}`} />
      </div>
    </fieldset>
  );
}

function MonitorLine({ on, onToggle, label, words, hint, value, onValue, inputLabel }: {
  on: boolean; onToggle: () => void; label: string; words: string; hint: string;
  value: string; onValue: (v: string) => void; inputLabel: string;
}) {
  return (
    <div className="nx-add-monitor" data-on={on ? "" : undefined}>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="nx-add-switch"
              onClick={onToggle}>{on ? "on" : "off"}</button>
      <span>{words}</span>
      <input aria-label={inputLabel} inputMode="decimal" value={value} disabled={!on}
             onChange={(e) => onValue(e.target.value)} />
      <small className="nx-meta">{hint}</small>
    </div>
  );
}
