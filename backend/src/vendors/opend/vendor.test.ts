/** moomoo's descriptor hands the client's own quote grade to `/health` (#464, review of #465).
 *
 *  The client's suite holds when the grade is read; this holds that the descriptor passes THAT
 *  reading on, rather than something shaped like it. The SDK is faked at the package, the one
 *  thing the descriptor does not let a caller replace: a test must never reach a real OpenD, which
 *  blocks for ever on a dead port (CLAUDE.md).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("moomoo-api", () => ({
  default: class {
    onlogin?: (ok: boolean, msg: unknown) => void;
    websock = { close: () => { /* nothing to hang up */ } };
    start() { setTimeout(() => this.onlogin?.(true, "Succeed"), 0); }
    stop() { /* nothing registered */ }
    GetSecuritySnapshot(req: { c2s: { securityList: { market: number; code: string }[] } }) {
      return Promise.resolve({
        retType: 0,
        s2c: { snapshotList: req.c2s.securityList.map((security) => ({ basic: { security } })) },
      });
    }
    // GetUserInfo (1005): this account's options, Level 1, as OpenD answered on 2026-11-20
    _sendCmd() { return Promise.resolve({ retType: 0, s2c: { usOptionQotRight: 2 } }); }
  },
}));

const { settingsFor } = await import("../../env.ts");
const { moomooVendor } = await import("./vendor.ts");

describe("moomoo's descriptor", () => {
  it("hands /health the grade its client read after a fetch that worked", async () => {
    const provider = moomooVendor.open(settingsFor({ provider: "moomoo", moomooWsKey: "k" }))!;
    expect(provider.quoteGrade()).toEqual({ read: null, failure: null });

    await provider.fetchQuotes(["US.SPXW261218C8100000"]);

    await vi.waitFor(() => expect(provider.quoteGrade()?.read).toMatchObject({ usOption: "LV1", realtime: true }));
    expect(provider.quoteGrade()?.failure).toBeNull();
    provider.close();
  });
});
