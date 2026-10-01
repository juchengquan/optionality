/** The number the dashboard and the API use to agree they are the same age.
 *
 *  They deploy separately (ADR 0006), so a bundle can outlive the API it was built against. This
 *  integer is the only thing both sides read: the bundle bakes it at build time, the API reports it
 *  on /health, and the dashboard says so out loud when they differ instead of failing at whatever
 *  field happens to have moved.
 *
 *  Read from the SAME file the Python reads and the Vite build reads, rather than copied — a second
 *  copy is a third thing to forget. ADR 0009 retires the banner in phase 8 once `hc` makes the
 *  skew a compile error instead of a runtime one; until then this has to agree with the Python
 *  exactly, because during the cutover either service might be the one answering.
 */
import { readFileSync } from "node:fs";

const CONTRACT_FILE = new URL(
  "../../src/optionality/service/contract.json",
  import.meta.url,
);

export const CONTRACT_VERSION: number = (
  JSON.parse(readFileSync(CONTRACT_FILE, "utf8")) as { version: number }
).version;
