/** A crosshair nobody moves, for a test that draws one panel of a holding's history alone (#395):
 *  no stops, none pointed at. */
import type { Cross } from "../Crosshair";

export const stillCross = (): Cross => ({ stops: [], pointed: null, point: () => {}, plots: { current: new Set() } });
