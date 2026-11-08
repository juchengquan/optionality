import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import type { Reference } from "./api";
import { ConfirmDelete } from "./ConfirmDelete";
import { referenceTitle } from "./ReferenceStrip";

/** Which Securities are kept on the page, and the door for adding one (ADR 0018, 0019).
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
  onAdd: (body: { code: string; label?: string; source: "moomoo" | "ibkr" | "yahoo" }) =>
    Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState<"moomoo" | "ibkr" | "yahoo">("moomoo");

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
          void onAdd({
            code,
            ...(label ? { label } : {}),
            source,
          }).then((landed) => {
            if (!landed) return;
            setCode("");
            setLabel("");
            // the source is NOT cleared: adding two References from one vendor is the common
            // case, and resetting it would make the second one a mistake waiting to happen
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
          <FieldLabel htmlFor="r-source">from</FieldLabel>
          <NativeSelect
            id="r-source"
            aria-label="from"
            value={source}
            onChange={(e) => setSource(e.target.value as typeof source)}
          >
            <option value="moomoo">moomoo</option>
            <option value="ibkr">ibkr</option>
            <option value="yahoo">yahoo</option>
          </NativeSelect>
          <FieldDescription>
            Which vendor answers for this code. Named outright and not "the Provider", so the strip
            can say where the figure came from — the only reason a Reference is allowed a source
            the rest of the service does not use. A vendor this build cannot reach is refused here
            with that reason, rather than becoming a permanent dash.
          </FieldDescription>
        </Field>
        <Button type="submit" size="sm" variant="secondary">keep it</Button>
      </form>
    </section>
  );
}
