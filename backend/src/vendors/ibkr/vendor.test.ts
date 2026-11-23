/** IB Gateway's descriptor: the account's one read over the library's client, every way it ends
 *  sorted for `GET /account` (ADR 0030, #470). Against the library's fake gateway, replaying the
 *  constructed account conversations, so the real client's read and refusals are what is sorted. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ibkrFields } from "optionality/vendors/fields";
import { IbkrClient } from "optionality/vendors/ibkr/client";
import { type FakeGateway, startFakeGateway } from "optionality/vendors/ibkr/fake";

import { AccountBook, NOT_ANSWERING } from "../../account.ts";
import { settingsFor } from "../../env.ts";
import { accountReader, ibkrVendor } from "./vendor.ts";

const opened: { gateway?: FakeGateway; client?: IbkrClient }[] = [];
afterEach(async () => {
  for (const { gateway, client } of opened.splice(0)) {
    client?.close();
    await gateway?.close();
  }
});

async function against(conversation: string, requestTimeoutMs = 1000) {
  const gateway = await startFakeGateway(0, { conversation });
  const client = new IbkrClient({
    host: "127.0.0.1", port: gateway.port, clientId: 31419, connectTimeoutMs: 1000, requestTimeoutMs,
  });
  opened.push({ gateway, client });
  return { read: accountReader(client), gateway };
}

describe("the account's read", () => {
  it("answers the library's account, its id masked by the library", async () => {
    const { read } = await against("account-stocks-and-options");
    const reading = await read(null);
    expect(reading).toHaveProperty("account");
    if (!("account" in reading)) return;
    expect(reading.account.account).toBe(ibkrFields.maskAccount("U0000000"));
    expect(reading.account.holdings.length).toBeGreaterThan(0);
  });

  it("reads the account it is asked for", async () => {
    const { read } = await against("account-several");
    const reading = await read("U0000001");
    expect("account" in reading && reading.account.account).toBe(ibkrFields.maskAccount("U0000001"));
  });

  it("is a refusal, in the library's words, where several accounts and none is named", async () => {
    const { read, gateway } = await against("account-several");
    expect(await read(null)).toEqual({
      refused: `several accounts on this login; set IBKR_ACCOUNT to one of ${
        ["U0000000", "U0000001"].map(ibkrFields.maskAccount).join(", ")}`,
    });
    // a refusal sends nothing
    expect(gateway.received.filter((m) => m[0] === "6")).toEqual([]);
  });

  it("is a refusal where IBKR_ACCOUNT names no account on the login", async () => {
    const { read } = await against("account-several");
    const reading = await read("DU0000001");
    expect(reading).toHaveProperty("refused");
    expect(JSON.stringify(reading)).not.toContain("DU0000001");
  });

  it("is a failure in the library's words where the read does not finish by its deadline", async () => {
    const { read } = await against("account-never-ends", 300);
    expect(await read(null)).toEqual({ failed: expect.stringMatching(/did not finish sending the account within 300ms/) });
  });

  it("is unreachable, in the connect's own words, where nothing answers at the gateway's address", async () => {
    const client = new IbkrClient({ host: "127.0.0.1", port: 1, clientId: 31419, connectTimeoutMs: 500 });
    opened.push({ client });
    expect(await accountReader(client)(null))
      .toEqual({ unreachable: "could not reach IB Gateway at 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1" });
  });

  it("is unreachable in the gateway's own words where it refuses the session", async () => {
    const { read } = await against("client-id-in-use");
    const reading = await read(null);
    expect(reading).toEqual({ unreachable: expect.stringMatching(/^IB Gateway refused the session: 326 /) });
  });
});

describe("through the route's service", () => {
  // the whole way: the library's client against a recording, the descriptor's read, the book
  const book = (read: ReturnType<typeof accountReader>) => new AccountBook({
    read, wanted: "", now: () => new Date("2026-11-23T15:00:00.000Z"), displayTz: "",
  });

  it("answers a refused session's 502 in the gateway's words, not as a gateway that is down", async () => {
    const { read } = await against("client-id-in-use");
    const result = await book(read).read();
    expect(result).toEqual({ fault: { status: 502, message: expect.stringMatching(/^IB Gateway refused the session: 326 Unable to connect as the client id is already in use/) } });
  });

  it("answers a gateway nothing listens for as one that did not answer", async () => {
    const client = new IbkrClient({ host: "127.0.0.1", port: 1, clientId: 31419, connectTimeoutMs: 500 });
    opened.push({ client });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await book(accountReader(client)).read()).toEqual({ fault: { status: 502, message: NOT_ANSWERING } });
    // the connect's own words reach the log
    expect(quiet).toHaveBeenCalledWith(
      "IBKR account: could not reach IB Gateway at 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1");
    quiet.mockRestore();
  });
});

describe("the descriptor", () => {
  it("hands back the account's read with the client it opens, opening no connection", async () => {
    // a gateway listening where the settings point, so a connection made on opening would be seen
    const gateway = await startFakeGateway(0, { conversation: "account-stocks-and-options" });
    const client = ibkrVendor.open(settingsFor({ ibkrHost: "127.0.0.1", ibkrPort: gateway.port }));
    opened.push({ gateway, client: { close: () => client?.close() } as IbkrClient });
    expect(typeof client?.readAccount).toBe("function");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.connections).toBe(0);
    expect(gateway.sessionsAsked).toBe(0);
  });
});
