/** A holding's legs as the service names them, and the delta it serves for each (#318). */
import type { Holding } from "../shared/api";

type Leg = Holding["legs"][number];

/** moomoo's code for a leg: `US.SPXW261218P7150000`, as the service builds it (`buildSpxCode`):
 *  the whole strike then 000, so a fraction is dropped there and must be dropped here. */
export function legCode(strikeDate: string, leg: Pick<Leg, "option_type" | "strike">): string {
  const yymmdd = strikeDate.slice(2).replaceAll("-", "");
  return `US.SPXW${yymmdd}${leg.option_type === "CALL" ? "C" : "P"}${Math.trunc(leg.strike)}000`;
}

/** The leg's OWN delta as `/positions/values` serves it, or null where the service sent none (its
 *  map is all or nothing, so one leg missing a delta leaves every leg without). */
export function servedDelta(holding: Holding, leg: Leg): number | null {
  const d = holding.legs_delta?.[legCode(holding.strike_date, leg)];
  return typeof d === "number" ? d : null;
}
