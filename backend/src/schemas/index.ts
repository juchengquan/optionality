/** What the backend publishes to the frontend, as `backend/schemas` (ADR 0014).
 *
 *  The REQUEST shapes, so that the frontend's tests parse what its forms post with the same
 *  schemas the routes validate with and a form cannot disagree with its route unnoticed. They used
 *  to reach into this directory by relative path; this entry is what they may use instead, and
 *  anything not exported here is the backend's own business.
 *
 *  And two vocabularies, for the same reason: a list the service writes from, published rather
 *  than hand-written a second time on the other side. The reasons the service disables a monitor
 *  for, which the dashboard groups its muted tables by (#167); and `SOURCES`, every vendor a
 *  Reference may name, which the dashboard's "from" box offers. `VENDORS` is held to `SOURCES` on
 *  this side and the box is held to it on that one, so adding a vendor stays a descriptor plus a
 *  line in `VENDORS` (and its client in the library), as it already was for the backend alone.
 */
export {
  ComboMonitorIn, DISABLED_REASONS, type DisabledReason, MonitorCreateIn, MonitorIn, MonitorPatch,
  TotalEntryIn,
} from "./monitor.ts";
export { ClosePositionIn, LegIn, PositionIn, PositionPatch } from "./position.ts";
export { ReferenceIn, type Source, SOURCES } from "./reference.ts";
// and `backend/schemas/sources` publishes that list ALONE, which is what the dashboard's box
// imports: this entry carries the schemas and therefore zod, which a page must not pay for.
