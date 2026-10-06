/** The API, typed by the API (ADR 0009, phase 8).
 *
 *  This file used to declare six interfaces describing what the service returns. They were written by
 *  hand, kept in step by hand, and the only thing that noticed when they drifted was a blank column on
 *  the dashboard — which is why the service also published a contract version and this bundle showed a
 *  banner when the two disagreed (ADR 0006).
 *
 *  All of that is replaced by `hc<AppType>`: the shapes are READ from the backend's route definitions,
 *  so a response that changes shape is a compile error here rather than a blank cell after the next
 *  sweep. The interfaces, the contract version and the banner all retire together.
 *
 *  The import is type-only, so nothing of the backend reaches the bundle — `node:sqlite` and the rest
 *  are erased before Vite sees them. What crosses the boundary is a type, and the client that reads it.
 */
import { hc } from "hono/client";

import type { AppType } from "../../backend/src/app.ts";

/** Where the API lives, relative to wherever this bundle was deployed.
 *
 * The page cannot work its own prefix out at runtime: `tailscale serve` strips it before
 * proxying, so the app only ever sees the stripped spelling. BASE_URL is baked at build
 * time from UI_BASE (see the Makefile) and locates both the assets and the API, so the two
 * cannot end up pointing at different deployments. ADR 0006 has the reasoning.
 */
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

const client = hc<AppType>(API_BASE);

/** The response types, inferred rather than declared.
 *
 *  Exported under the names the components already use, so that the change is to where these come from
 *  and not to every file that reads one. `InferResponseType` is hc's own helper; it gives the SUCCESS
 *  body, with the error arm narrowed away — the error path is handled once, in `send` below.
 */
type Infer<T extends (...args: never[]) => Promise<{ json: () => Promise<unknown> }>> =
  Awaited<ReturnType<Awaited<ReturnType<T>>["json"]>>;

type QuotesResponse = Exclude<Infer<typeof client.quotes.$get>, { detail: string }>;
type MonitorsResponse = Exclude<Infer<typeof client.monitors.$get>, { detail: string }>;

export type Entry = QuotesResponse[number];
export type Monitor = MonitorsResponse[number];
export type Health = Exclude<Infer<typeof client.health.$get>, { detail: string }>;
export type Snapshot = NonNullable<Entry["snapshot"]>;
export type Leg = NonNullable<Entry["legs"]>[number];
// PositionRef is not re-exported: nothing imported it. The old interface declared a `name` the
// components never read — they take `entry.positions` whole and use `.id`. Five types replace six.

/** A reply the service refused. The shape is `{detail}` on every failure path, and the service explains
 *  itself properly — a duplicate, a dead contract, an unsplittable total — so its words are surfaced
 *  rather than a status code. */
function isRefusal(body: unknown): body is { detail: string } {
  return typeof body === "object" && body !== null && "detail" in body
    && typeof (body as { detail: unknown }).detail === "string";
}

async function read<T>(
  request: Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
  what: string,
): Promise<T> {
  const response = await request;
  if (!response.ok) throw new Error(`${what} → ${response.status}`);
  const body = await response.json();
  // `hc` types this as the union of every answer the route can give, so the refusal arm has to be
  // narrowed away before the caller sees rows. That narrowing is the whole point: the old interfaces
  // claimed the happy shape and a 422 arrived as undefined fields.
  if (isRefusal(body)) throw new Error(body.detail);
  return body as T;
}

export const fetchQuotes = () => read<Entry[]>(client.quotes.$get(), "/quotes");
export const fetchMonitors = () => read<Monitor[]>(client.monitors.$get(), "/monitors");
export const fetchHealth = () => read<Health>(client.health.$get(), "/health");

/** A write, whose only interesting answer is whether it was refused. */
async function sent(
  request: Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
  what: string,
): Promise<void> {
  const response = await request;
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  throw new Error(isRefusal(body) ? body.detail : `${what} → ${response.status}`);
}

export const patchMonitor = (id: string, body: Record<string, unknown>) =>
  sent(client.monitors[":id"].$patch({ param: { id }, json: body }), `/monitors/${id}`);

export const deleteMonitor = (id: string) =>
  sent(client.monitors[":id"].$delete({ param: { id } }), `/monitors/${id}`);

export const patchPosition = (id: string, body: Record<string, unknown>) =>
  sent(client.positions[":id"].$patch({ param: { id }, json: body }), `/positions/${id}`);

/** Record a credit taken in across everything a rule spans; the server derives the one wing
 *  that has no rule of its own, so the per-wing credits stay the single source of truth. */
export const setTotalEntry = (monitorId: string, entry: number) =>
  sent(
    client.monitors[":id"]["total-entry"].$post({ param: { id: monitorId }, json: { entry } }),
    `/monitors/${monitorId}/total-entry`,
  );

/** `sign` is the combo's vocabulary and `side` the holding's: the minus the add-combo form offers
 *  means short, and a short leg is one you sold. The two signings are inverses in the position
 *  maths (domain/position.ts), so reversing this would invert every P&L rather than fail.
 *
 *  One convention, stated the same way everywhere since 2026-10-06: the schema, the bot's help and
 *  the sentence above the legs on this form all say minus is short. ComboLegIn said the opposite
 *  until then — "+ on sold legs watches the cost to close" — and nothing failed, because the sign
 *  is otherwise just a multiplier and `compare: abs` is indifferent to it. The relationship is
 *  pinned in backend/src/domain/position.test.ts rather than left to these comments.
 */
interface ComboLeg { sign: number; option_type: string; strike: number }
const holdingLegs = (legs: ComboLeg[]) =>
  legs.map((leg) => ({
    side: leg.sign < 0 ? "sold" : "bought",
    option_type: leg.option_type,
    strike: leg.strike,
  }));

/** The holding a form described, ready for POST /positions.
 *
 *  A combo names itself and states its legs with signs. A single monitor has neither: its code is
 *  derived from the contract, so the holding's name is too — the two records are then visibly
 *  about the same option, and a second attempt at it is refused by name rather than silently
 *  making that contract held twice (which `positionsHolding` reads as ambiguous and refuses to
 *  link at all).
 *
 *  `entry` is a net credit RECEIVED, so a long is NEGATIVE. P&L is entry − costToClose and
 *  costToClose is itself negative for a long: bought at 5.00 and now worth 8.00, entry −5 gives
 *  +300 and entry +5 gives +1300. Verified against the domain code rather than reasoned about.
 *  The combo form takes that signed figure directly, because a structure's net credit is signed
 *  whatever its legs are; the monitor form asks which side you are on and signs it here, so that
 *  the number typed there is only ever what moved.
 */
function holding(
  monitor: Record<string, unknown>, entry: number, side: string | undefined,
): Record<string, unknown> {
  if (Array.isArray(monitor.legs)) {
    return {
      name: monitor.name,
      strike_date: monitor.strike_date,
      entry,
      legs: holdingLegs(monitor.legs as ComboLeg[]),
    };
  }
  const optionType = monitor.option_type as string;
  const bought = side === "bought";
  return {
    name: `${String(monitor.strike_date)}_${optionType === "CALL" ? "C" : "P"}${String(monitor.strike)}`,
    strike_date: monitor.strike_date,
    entry: bought ? -entry : entry,
    legs: [{ side: bought ? "bought" : "sold", option_type: optionType, strike: monitor.strike }],
  };
}

/** Create the rule, and — when the form said what was paid — the holding it warns about.
 *
 *  Two calls rather than one wider body. The service keeps the two apart deliberately: "a Monitor
 *  exists to warn, never to record what you own", so it does not bring a Position into being, and
 *  teaching POST /monitors to do it would break the invariant the entry linkage rests on. POST
 *  /positions calls adoptOrphanMonitors itself, so the rule picks up its entry and its scope with
 *  no third call — either order links, which is why only failure decides the order here.
 *
 *  The rule goes FIRST. Both routes probe the contracts strictly, so if the second call is refused
 *  what matters is which record is left behind: a rule with no entry is exactly the state you were
 *  in before, while a holding nothing watches has no screen on this dashboard that lists it.
 *
 *  `contracts` is not sent — the form does not ask and the service defaults it. An entry typed
 *  wrongly is correctable from the row's own entry box; nothing here is a one-way door.
 */
export async function createWatch(body: Record<string, unknown>): Promise<void> {
  const { entry, side, ...monitor } =
    body as { entry?: number | null; side?: string } & Record<string, unknown>;
  await sent(client.monitors.$post({ json: monitor as never }), "/monitors");
  if (entry === null || entry === undefined) return;
  await sent(
    client.positions.$post({ json: holding(monitor, entry, side) as never }),
    "/positions",
  );
}
