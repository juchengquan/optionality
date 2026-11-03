import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import type { Reference } from "./api";
import { ConfirmDelete } from "./ConfirmDelete";
import { referenceTitle } from "./ReferenceStrip";

/** Which Securities are kept on the page, and the door for adding one (ADR 0018).
 *
 *  In the Service panel rather than on the page, for the same reason the column pickers are not:
 *  this is set once and read never. The STRIP is what gets read, and it carries a figure and a
 *  dash and nothing else — so the reason a Reference has no figure lives here, in full, where
 *  somebody has come to do something about it.
 */
export function References({
  references, onAdd, onRemove,
}: {
  references: Reference[];
  /** answers whether it landed, so the boxes are cleared only on a Reference that now exists */
  onAdd: (body: { code: string; label?: string; scale?: number }) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [scale, setScale] = useState("");

  return (
    <section data-testid="references">
      <h3 className="text-sm font-semibold mb-1">on the page</h3>
      {references.length === 0 ? (
        <p className="meta">nothing kept — the strip above the tables stays away until there is</p>
      ) : (
        <ul className="meta">
          {references.map((r) => (
            <li key={r.id}>
              {referenceTitle(r)}
              {/* the whole sentence, where the strip shows a dash: a class refusal reads
                  "US stock indices are not supported", which is the one thing that explains why
                  an index cannot be kept directly (ADR 0018) */}
              {r.error ? ` — ${r.error}` : ""}
              {/* its own wording: the default reassures about a threshold and about muting, and a
                  Reference has neither — what it actually costs is nothing, which is worth saying
                  rather than leaving the monitor's sentence to imply otherwise */}
              <ConfirmDelete
                name={referenceTitle(r)} what="reference" onConfirm={() => onRemove(r.id)}
                description={
                  "This takes it off the page. Nothing is watching it and nothing is derived from"
                  + " it, so there is nothing else to lose — keeping it again is one line in this"
                  + " box."
                }
              >
                remove
              </ConfirmDelete>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const scaled = Number(scale);
          void onAdd({
            code,
            ...(label ? { label } : {}),
            // an empty box is no scale, which the service stores as null and reads as ×1
            ...(scale && Number.isFinite(scaled) ? { scale: scaled } : {}),
          }).then((landed) => {
            if (!landed) return;
            setCode("");
            setLabel("");
            setScale("");
          });
        }}
      >
        <Field>
          <FieldLabel htmlFor="r-code">code</FieldLabel>
          <Input id="r-code" aria-label="code" value={code} placeholder="US.SPY" required
                 onChange={(e) => setCode(e.target.value)} />
          <FieldDescription>
            A raw code, not an expiry and a strike: a Reference is any Security the Provider can
            quote. The service probes it live before it agrees to remember it, so a code nothing
            can price is refused here rather than becoming a permanent dash.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="r-label">call it</FieldLabel>
          <Input id="r-label" aria-label="call it" value={label} placeholder="SPX"
                 onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="r-scale">×</FieldLabel>
          <Input id="r-scale" aria-label="scale" type="number" step="any" min="0"
                 value={scale} placeholder="10" onChange={(e) => setScale(e.target.value)} />
          <FieldDescription>
            SPY quotes at 758 against strikes of 6950, so SPX is read through SPY ×10 — and the
            strip shows that arithmetic rather than charging a mental ×10 at every glance. It never
            claims to BE the index: SPY×10 has tracking error, it has dividends, and the two trade
            different sessions. Blank is ×1.
          </FieldDescription>
        </Field>
        <Button type="submit" size="sm" variant="secondary">keep it</Button>
      </form>
    </section>
  );
}
