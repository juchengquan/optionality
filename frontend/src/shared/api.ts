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
import { hc, type InferRequestType } from "hono/client";

import type { AppType } from "backend";
import type { Source } from "backend/schemas";

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
export type Leg = NonNullable<Entry["legs"]>[number];
// Neither PositionRef nor Quote is re-exported: nothing imported either. The old PositionRef
// interface declared a `name` the components never read — they take `entry.positions` whole and use
// `.id`. `Quote` named one row's live figures, `NonNullable<Entry["quote"]>`, and was not referenced
// even inside this file; the figures are read off `entry.quote` where they are read at all.

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

/** SPX's derived price on a row, as the page reads it: null where the row says nothing at all.
 *  The service always sends the field (ADR 0024), but a row without it — an older service, a test
 *  service — reached the payoff chart as `undefined`, which drew it with NaN and threw (#337). */
function withSpx<T extends { spx?: number | null; spx_reason?: string | null }>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r, spx: r.spx ?? null, spx_reason: r.spx_reason ?? null }));
}

export const fetchQuotes = () => read<Entry[]>(client.quotes.$get(), "/quotes").then(withSpx);

/** What of a holding's pace gap vol accounts for, over its own stored samples (ADR 0011), and
 *  since #333 the whole split: why not where it cannot say, and the gap, the rest and what would
 *  cover it at the close the vol part runs to.
 *
 *  Deliberately NOT on the /quotes payload, which the dashboard polls every 15 seconds per open
 *  tab while this changes once a market day — the sheet asks for it when it opens. */
export type Vol = Exclude<Infer<typeof client.positions[":id"]["vol"]["$get"]>, { detail: string }>;
export const fetchVol = (id: string) =>
  read<Vol>(client.positions[":id"].vol.$get({ param: { id } }), `/positions/${id}/vol`);
export const fetchMonitors = () => read<Monitor[]>(client.monitors.$get(), "/monitors");

/** A holding's Daily samples (#295): each day's Cost to close, On-pace, legs' IV, vega and delta,
 *  and whether it was the close; with the Levels and the planned decay, both the service's. Stored
 *  history and no Provider call: asked once when a holding's history is drawn, and never polled. */
export type Samples = Exclude<Infer<typeof client.positions[":id"]["samples"]["$get"]>, { detail: string }>;
export type Sample = Samples["samples"][number];
export const fetchSamples = (id: string) =>
  read<Samples>(client.positions[":id"].samples.$get({ param: { id } }), `/positions/${id}/samples`);

/** A structure's payoff at expiry, in points across its contracts (#291): the P&L at each strike,
 *  the slope beyond the outer two, the breakevens and the maximums. At expiry only (ADR 0023).
 *
 *  Neither call asks the Provider: the payoff needs the legs, an Entry and a count and nothing
 *  else, so it is asked for once when a holding or a spread is opened and never polled. */
export type Payoff = Exclude<Infer<typeof client.positions[":id"]["payoff"]["$get"]>, { detail: string }>;
export const fetchPayoff = (id: string) =>
  read<Payoff>(client.positions[":id"].payoff.$get({ param: { id } }), `/positions/${id}/payoff`);

/** The payoff of legs nobody holds, at an Entry: the add form's preview, and a watched spread drawn
 *  at its current value. A POST because legs do not fit a query string; it writes nothing. */
export interface DraftPayoff {
  /** a leg's quantity only where it is not 1 (#351) */
  legs: { side: "short" | "long"; option_type: "CALL" | "PUT"; strike: number; qty?: number }[];
  entry: number;
  contracts?: number;
}
export const fetchDraftPayoff = (body: DraftPayoff) =>
  read<Payoff>(client.positions.payoff.$post({ json: body }), "/positions/payoff");

/** Spreads on one expiry, each held or watched, with the Monitors they start with — saved in ONE
 *  request, all of it or none (#293). The answer names what was made; the page reads the book
 *  again rather than trusting an echo of it. A refusal throws the service's own words, which the
 *  form shows where the owner is looking. */
export type Added = Exclude<Infer<typeof client.spreads.$post>, { detail: string }>;
export type SpreadsRequest = InferRequestType<typeof client.spreads.$post>["json"];
export async function addSpreads(body: SpreadsRequest): Promise<Added> {
  const response = await client.spreads.$post({ json: body });
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok || isRefusal(answer)) {
    throw new Error(isRefusal(answer) ? answer.detail : `/spreads → ${response.status}`);
  }
  return answer as Added;
}

/** The Securities kept on the page to read the market by (ADR 0018).
 *
 *  POLLED, with `/quotes`, because its figures are the market right now and a backdrop a sweep old
 *  would be read as current. That is a second bounded Provider call per poll per open tab, which
 *  ADR 0010 is explicit is not free — and the reason it is a call of its own rather than part of
 *  the watchlist's batch is containment: one Reference the Provider refuses would otherwise blank
 *  every row the owner acts on.
 *
 *  It cannot fail. The route declares no failure status: a Provider that is wholly down leaves
 *  every Reference a dash with its own sentence beside it, and the page still draws.
 */
export type Reference = Exclude<Infer<typeof client.references.$get>, { detail: string }>[number];
export const fetchReferences = () =>
  read<Reference[]>(client.references.$get(), "/references");

/** Keep a Security on the page. The code is RAW — `US.SPY`, not an expiry and a strike — because a
 *  Reference is a Security rather than a Contract, and the service probes it live before it agrees
 *  to remember it. */
export const addReference = (body: { code: string; label?: string; source: Source }) =>
  sent(client.references.$post({ json: body }), "/references");

/** Stop keeping one. The only way a Reference ever goes: nothing in the service removes one, and a
 *  Reference with no figure is a dash rather than an event. */
export const removeReference = (id: string) =>
  sent(client.references[":id"].$delete({ param: { id } }), `/references/${id}`);

/** What is actually HELD, with its live figures and its exit schedule.
 *
 *  FETCHED ON DEMAND, never on the poll. This route makes its own bounded OpenD batch — one
 *  snapshot call for every leg of every holding, a documented live-call exception like /quotes —
 *  so polling it would mean a second batch per interval per open tab, and ADR 0010 is explicit
 *  that polling is not free. Entry and Opened barely move; the figures beside them are worth a
 *  click.
 *
 *  It exists because the dashboard rendered RULES only, so a holding no rule watches had no
 *  screen at all — found with a live put spread carrying an entry, a P&L and a full schedule
 *  that nothing displayed. */
export type Holding = Awaited<ReturnType<typeof fetchHoldings>>[number];
export const fetchHoldings = () =>
  read<Exclude<Infer<typeof client.positions.values.$get>, { detail: string }>>(
    client.positions.values.$get(), "/positions/values",
  ).then(withSpx);
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

/** Remove a holding. The route clears its monitor links and its samples in the same transaction,
 *  because both reference the row — so this also discards the daily cost to close, per-leg IV and
 *  per-leg vega, which no later sweep can reconstruct (ADR 0011). The rules themselves survive
 *  and would adopt the holding again if it came back. */
export const deletePosition = (id: string) =>
  sent(client.positions[":id"].$delete({ param: { id } }), `/positions/${id}`);

/** Every holding on record, held or CLOSED (ADR 0022), as stored — no live figures, no market
 *  call. Asked for only when the closed list is shown — the journal, on first opening its fold and after a
 *  write that changes it (#296), never polled: nothing else on the page needs it, and the held ones' figures are `/positions/values`' to give. */
export type Recorded = Awaited<ReturnType<typeof fetchPositions>>[number];
export const fetchPositions = () =>
  read<Exclude<Infer<typeof client.positions.$get>, { detail: string }>>(
    client.positions.$get(), "/positions",
  );

/** What a close answers: the holding as it now stands, and the rules it switched off. */
export type Closed = Exclude<
  Infer<typeof client.positions[":id"]["close"]["$post"]>, { detail: string }
>;

/** Close a holding: it leaves the live list and is KEPT, with its samples, and the rules that
 *  watched it are switched off (ADR 0022). The one write here whose answer is more than whether it
 *  landed — the page says which rules went off, which only the service knows. */
export async function closePosition(
  id: string, given: { exit: number | null; closed_on?: string },
): Promise<Closed> {
  const response = await client.positions[":id"].close.$post({ param: { id }, json: given });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || isRefusal(body)) {
    throw new Error(isRefusal(body) ? body.detail : `/positions/${id}/close → ${response.status}`);
  }
  return body as Closed;
}

/** Correct a mistyped close — its Exit and its day — by the same PATCH that edits a held holding
 *  (ADR 0022), answered with the holding as it now stands, so the page can say what it now made
 *  in the service's own `realized_points` rather than working it out. */
export type Corrected = Exclude<Infer<typeof client.positions[":id"]["$patch"]>, { detail: string }>;
export const correctClose = (id: string, given: { exit?: number | null; closed_on?: string }) =>
  editPosition(id, given);

/** Edit a held holding — Entry, contracts, Opened, and a leg's quantity (#359) — answered with the
 *  holding as it now stands and what a corrected quantity did to its rules, which the page says
 *  rather than guessing. */
export async function editPosition(
  id: string, given: InferRequestType<typeof client.positions[":id"]["$patch"]>["json"],
): Promise<Corrected> {
  const response = await client.positions[":id"].$patch({ param: { id }, json: given });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || isRefusal(body)) {
    throw new Error(isRefusal(body) ? body.detail : `/positions/${id} → ${response.status}`);
  }
  return body as Corrected;
}

/** Record a credit taken in across everything a rule spans; the server derives the one wing
 *  that has no rule of its own, so the per-wing credits stay the single source of truth. */
export const setTotalEntry = (monitorId: string, entry: number) =>
  sent(
    client.monitors[":id"]["total-entry"].$post({ param: { id: monitorId }, json: { entry } }),
    `/monitors/${monitorId}/total-entry`,
  );
