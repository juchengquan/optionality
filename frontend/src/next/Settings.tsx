import type { Health, Reference } from "../api";
import type { Source } from "backend/schemas";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import type { ArrangementChoice, EntryStyle, UpColour } from "../prefs";
import { References } from "../References";
import type { Need } from "./needs";

/** The cadences offered, as the Service panel at `/opt` offers them. */
const REFRESH_PRESETS = [5, 10, 15, 30, 60, 120];

export interface SettingsProps {
  up: UpColour; onUp: (up: UpColour) => void;
  entryStyle: EntryStyle; onEntryStyle: (style: EntryStyle) => void;
  privacy: boolean; onPrivacy: (on: boolean) => void;
  choice: ArrangementChoice; onChoice: (choice: ArrangementChoice) => void;
  refresh: number; onRefresh: (seconds: number) => void;
  health: Health | null;
  /** the whole list, holdings included where the page has them valued */
  needs: Need[];
  /** whether the list can claim to be whole: only with every holding valued (ADR 0012) */
  complete: boolean;
  references: Reference[];
  onAddReference: (body: { code: string; label?: string; source: Source }) => Promise<boolean>;
  onRemoveReference: (id: string) => void;
}

/** Settings and the Service panel's content in one place (ADR 0023): what this viewer prefers, and
 *  where the service stands in full. On the desk it is a side panel; on the phone, a tab.
 *
 *  Every preference is a cookie, as viewer preferences are (CLAUDE.md: Config), and every one is
 *  applied the moment it is chosen — there is no Save, so nothing chosen can be lost by closing.
 */
export function Settings(p: SettingsProps) {
  return (
    <div className="nx-settings">
      <section data-testid="needs">
        <h3>needs you</h3>
        {p.needs.length === 0
          ? <p className="nx-meta">{p.complete ? "nothing needs you"
            : "nothing the page can see — the holdings are not valued, so this may be short"}</p>
          : <ul className="nx-meta">{p.needs.map((n) => <li key={n.kind + n.text}>{n.text}</li>)}</ul>}
      </section>

      <section data-testid="service">
        <h3>service</h3>
        <p className="nx-meta">
          {p.health ? `${p.health.provider.name} ${p.health.provider.ok ? "up" : "down"}` : "provider unknown"}
          {p.health ? ` · alarms ${p.health.monitor.alarms.label}` : ""}
          {p.health?.monitor.last_sweep_at ? ` · last sweep ${p.health.monitor.last_sweep_at}` : ""}
        </p>
      </section>

      <Field>
        <FieldLabel htmlFor="nx-up">up is</FieldLabel>
        <NativeSelect id="nx-up" value={p.up}
                      onChange={(e) => p.onUp(e.target.value === "red" ? "red" : "green")}>
          <option value="green">green — red is down</option>
          <option value="red">red — green is down</option>
        </NativeSelect>
        <FieldDescription>
          Prices and P&L follow this. Alarms, faults and entry signals never do: they keep their own
          colour and a glyph, so a ringing row cannot be read as the market moving.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="nx-entry">a fired entry signal looks</FieldLabel>
        <NativeSelect id="nx-entry" value={p.entryStyle}
                      onChange={(e) => p.onEntryStyle(e.target.value === "risk" ? "risk" : "opportunity")}>
          <option value="opportunity">like an opportunity</option>
          <option value="risk">like an alarm</option>
        </NativeSelect>
        <FieldDescription>
          A watchlist rule that fires says a spread is worth selling — good news, not a risk on
          something held.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="nx-privacy">money</FieldLabel>
        <NativeSelect id="nx-privacy" value={p.privacy ? "hidden" : "shown"}
                      onChange={(e) => p.onPrivacy(e.target.value === "hidden")}>
          <option value="shown">shown</option>
          <option value="hidden">hidden — %, Δ and DTE stay</option>
        </NativeSelect>
        <FieldDescription>For a screen somebody else can see.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="nx-arrangement">arrangement</FieldLabel>
        <NativeSelect id="nx-arrangement" value={p.choice}
                      onChange={(e) => p.onChoice(
                        e.target.value === "desk" || e.target.value === "phone" ? e.target.value : "auto")}>
          <option value="auto">by the screen's width</option>
          <option value="desk">always the desk</option>
          <option value="phone">always the phone</option>
        </NativeSelect>
        <FieldDescription>For this device only.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="nx-refresh">refresh every</FieldLabel>
        <NativeSelect id="nx-refresh" value={p.refresh}
                      onChange={(e) => p.onRefresh(Number(e.target.value))}>
          {REFRESH_PRESETS.map((n) => <option key={n} value={n}>{n}s</option>)}
        </NativeSelect>
        <FieldDescription>
          Each poll is a live call, so faster is not free (ADR 0010)
          {p.health ? ` — the service sweeps every ${p.health.settings.sweep_seconds}s` : ""}.
        </FieldDescription>
      </Field>

      <References references={p.references} onAdd={p.onAddReference} onRemove={p.onRemoveReference} />
    </div>
  );
}
