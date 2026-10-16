/** The npm package ships no types at all (ADR 0009, phase 6).
 *
 *  Declared as narrowly as the service uses it rather than `any`: one constructor, and the methods
 *  described in ./types.ts. An `any` here would make every field name in snapshot.ts unchecked, which
 *  is exactly the mapping a wrong name is silent in.
 */
declare module "moomoo-api" {
  import type { MoomooClient } from "./types.ts";

  const mmWebsocket: new () => MoomooClient;
  export default mmWebsocket;

  export const mmCmdID: Record<string, { cmd: number; name: string; description: string }>;
}
