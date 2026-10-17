/** What the backend publishes about its REQUEST shapes, as `backend/schemas` (ADR 0014).
 *
 *  The frontend's tests parse what its forms post with these, so a form and the route it posts to
 *  cannot disagree unnoticed. They used to reach into this directory by relative path; this entry
 *  is what they may use instead, and anything not exported here is the backend's own business.
 */
export { ComboMonitorIn, MonitorCreateIn, MonitorIn, MonitorPatch, TotalEntryIn } from "./monitor.ts";
export { LegIn, PositionIn, PositionPatch } from "./position.ts";
