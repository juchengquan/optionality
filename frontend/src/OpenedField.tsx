import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import { marketDay } from "./format";

/** The day a holding was PUT ON — one control, used by all four forms that set it.
 *
 *  Blank by default and never today: a date nobody chose would be wrong for exactly the trades
 *  most likely to be recorded late, and wrong INVISIBLY, under figures as load-bearing as on-pace
 *  (ADR 0011). The button below is therefore an offer, not a default — pressing it is a choice.
 *
 *  What it offers is the TRADING day, named in full. `opened_at` is a market date: the sampler
 *  keys `observed_on` to the New York calendar and `volAttribution` returns null unless the first
 *  sample's day equals this field, so a date from the local calendar costs the vol figure with no
 *  error anywhere. Through the Singapore morning the two differ, and that is precisely when a
 *  trade gets recorded — the 1130 spread was recorded on 2026-10-20 for a 2026-10-19 fill and its
 *  /vol answered null while the comparable holding answered -0.41.
 *
 *  Four copies of a bare date input stood here before, in RowActions, Holdings and both add forms,
 *  each with its own paragraph about ADR 0011 and none of them saying which calendar it meant.
 */
export function OpenedField({ id, value, onChange, description, className, now }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** extra words where the form has room for them — the add forms do, a table row does not */
  description?: React.ReactNode;
  className?: string;
  /** injected only by tests: the trading day depends on the clock, and a test that computed the
   *  expected answer the same way the subject does would pass however wrong both were */
  now?: Date;
}) {
  const trading = marketDay(now);
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>opened</FieldLabel>
      <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      <FieldDescription>
        {description}
        <Button type="button" variant="link" size="sm" className="h-auto p-0 font-normal"
                title="the New York trading day, which is what Opened is measured in"
                onClick={() => onChange(trading)}>
          {`trading day: ${trading}`}
        </Button>
      </FieldDescription>
    </Field>
  );
}
