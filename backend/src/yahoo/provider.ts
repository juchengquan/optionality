/** Yahoo as a named Reference source. No configuration, so always available (ADR 0019). */
import { yahooFetcher } from "./client.ts";
import type { Sources } from "../references.ts";

export function yahooSource(): Sources {
  return { yahoo: yahooFetcher() };
}
