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

export const createMonitor = (body: Record<string, unknown>) =>
  sent(client.monitors.$post({ json: body as never }), "/monitors");
