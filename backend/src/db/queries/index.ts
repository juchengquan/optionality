/** The SQL the rest of the service runs (ADR 0009, phase 5), by aggregate.
 *
 *  Hand-written because there is no ORM: node:sqlite directly, so nothing to rebuild when Node
 *  moves. Gathered out of the handlers so that the statements are greppable and the routes stay
 *  about HTTP.
 *
 *  This was one 322-line file with thirty-five exports across five tables, which is readable
 *  enough and still the wrong shape: a monitors query and a samples query share nothing but a
 *  database handle, and every reader of one scrolled past the other four. The split is by TABLE
 *  rather than by caller, because a table's rules belong together — `links.ts` exists as its own
 *  file precisely because `monitor_positions` has a hazard of its own.
 *
 *  This file re-exports, so every caller keeps one import path and a query can move between
 *  these modules without touching a route. `sql.ts` holds what all of them were repeating.
 *
 *  Every write that touches more than one row goes through `atomic` from `../open.ts`. Reading is
 *  cheap and uncoordinated; writing is not.
 */
export { databaseResponds } from "./sql.ts";
export {
  clearScopeOfOrphans, deleteMonitorRow, enabledMonitors, findComboByName, findMonitor,
  findMonitorByCodeField, findMonitorsByIdentifier, insertMonitor, listMonitors, orphanMonitors,
  setMonitorScope, updateMonitorFields,
} from "./monitors.ts";
export {
  deletePositionRow, findPosition, findPositionByName, insertPosition, listPositions,
  openPositions, setPositionEntry, stampManageNotified, updatePositionFields,
} from "./positions.ts";
export {
  clearMonitorLinks, clearPositionLinks, linkMonitorToPositions, monitorsWatching,
  positionsForMonitor, positionsForMonitors, solelyWatchedPositions,
} from "./links.ts";
export {
  clearPositionSamples, findPositionSample, listPositionSamples, recordPositionSample,
} from "./samples.ts";
export {
  deleteReferenceRow, findReference, findReferenceByCode, insertReference, listReferences,
} from "./references.ts";
