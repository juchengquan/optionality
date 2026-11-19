/** The MCP door (ADR 0026, #447), through the app as `main.ts` mounts it: the protocol, the tools,
 *  the cache in front of the live ones, and the two promises it is built on — a tool's data is
 *  exactly what its GET serves, and nothing here can write. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WATCHABLE_FIELDS } from "optionality/domain/monitor";
import { opendFields } from "optionality/vendors/fields";

import { type FakeProvider, type Harness, body, harness, json, pricedFetcher } from "../../../testing/harness.ts";
import type { Settings } from "../../env.ts";
import { DESCRIBED, LIVE_FOR_MS, type Rounding, byKey, canonical, roundTo, rounded, toolbox } from "./tools.ts";
import { mcpServer } from "./server.ts";
import { OPENED_WITHIN_DAYS, WRITES, allowedWrite } from "./writes.ts";

let h: Harness;
afterEach(() => h?.close());

const EXPIRY = "2026-12-18";
const CONDOR = {
  name: "1016_IC", strategy: "iron_condor", strike_date: EXPIRY, contracts: 1, entry: 3.0,
  legs: [
    { side: "short", option_type: "CALL", strike: 8050 },
    { side: "long", option_type: "CALL", strike: 8075 },
    { side: "short", option_type: "PUT", strike: 7100 },
    { side: "long", option_type: "PUT", strike: 7075 },
  ],
};
const RULE = {
  strike_date: EXPIRY, option_type: "CALL", strike: 8050, field: "option_delta", threshold: 0.2,
  direction: "above",
};

/** Every code the Provider was asked for, one batch per entry. */
let asked: string[][] = [];
const start = (fetchQuotes: FakeProvider = pricedFetcher as FakeProvider) => {
  asked = [];
  h = harness({ fetchQuotes: (codes) => { asked.push(codes); return fetchQuotes(codes); } });
  return h;
};

let nextId = 0;
/** One JSON-RPC message to `/mcp`, as an MCP client sends it. */
const rpc = (method: string, params?: unknown, init: { headers?: Record<string, string>; anonymous?: boolean } = {}) =>
  h.call("/mcp", {
    ...json({ jsonrpc: "2.0", id: ++nextId, method, ...(params === undefined ? {} : { params }) }),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...init.headers },
    anonymous: init.anonymous,
  });

const result = async (resp: Response) => {
  const answer = await body(resp);
  expect(resp.status, JSON.stringify(answer)).toBe(200);
  expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
  return answer.result;
};

/** A tool's answer, parsed: `{ source, read_at, data }`, or the error text. */
const call = async (name: string, args?: unknown) => {
  const r = await result(await rpc("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }));
  expect(r.content).toHaveLength(1);
  expect(r.content[0].type).toBe("text");
  return { isError: r.isError === true, text: r.content[0].text as string, ...(r.isError ? {} : JSON.parse(r.content[0].text)) };
};

const created = async (resp: Response): Promise<string> => {
  const data = await body(resp);
  expect(resp.status, JSON.stringify(data)).toBe(201);
  return data.id as string;
};

/** A held condor, a rule on its short call, and a Reference: something for every tool to read. */
const book = async () => {
  const position = await created(await h.call("/positions", json(CONDOR)));
  const monitor = await created(await h.call("/monitors", json(RULE)));
  await created(await h.call("/references", json({ code: "US.SPY", source: "moomoo" })));
  asked = [];
  return { position, monitor };
};

/** Every tool, the GET it serves and the arguments it takes on `book`'s records. */
const TOOLS = (ids: { position: string; monitor: string }) => [
  ["holdings", "/positions/values", undefined],
  ["watchlist", "/quotes", undefined],
  ["positions", "/positions", undefined],
  ["holding_history", `/positions/${ids.position}/samples`, { id: ids.position }],
  ["monitor_history", `/monitors/${ids.monitor}/samples`, { id: ids.monitor }],
  ["monitor_closes", "/monitors/closes", undefined],
  ["references", "/references", undefined],
  ["health", "/health", undefined],
] as const;

describe("the protocol", () => {
  it("initializes at the version the client asks for, where it speaks it", async () => {
    start();
    const r = await result(await rpc("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
    }));
    expect(r.protocolVersion).toBe("2025-06-18");
    expect(r.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.serverInfo).toMatchObject({ name: "optionality", version: "1" });
    // writes are off unless the owner switched them on (ADR 0028), and the instructions say so
    expect(r.instructions).toMatch(/WRITES ARE OFF/);
  });

  it("answers its newest version to one it does not speak, and the client decides", async () => {
    start();
    const r = await result(await rpc("initialize", { protocolVersion: "1999-01-01" }));
    expect(r.protocolVersion).toBe("2025-11-25");
  });

  it("speaks only the Streamable HTTP versions whose rules it follows", async () => {
    // 2025-03-26 allowed batches, which this server refuses; 2024-11-05 is the old HTTP+SSE
    // transport. A client asking for either is answered with the newest, and decides.
    start();
    for (const old of ["2025-03-26", "2024-11-05"]) {
      expect((await result(await rpc("initialize", { protocolVersion: old }))).protocolVersion).toBe("2025-11-25");
    }
  });

  it("refuses a request carrying an MCP-Protocol-Version it does not speak, with 400 and no id", async () => {
    start();
    const refused = await rpc("ping", undefined, { headers: { "MCP-Protocol-Version": "2025-03-26" } });
    expect(refused.status).toBe(400);
    expect(await body(refused)).toEqual({
      jsonrpc: "2.0", id: null, error: {
        code: -32600,
        message: "Bad Request: unsupported MCP-Protocol-Version 2025-03-26; this server speaks 2025-11-25, 2025-06-18",
      },
    });
    for (const spoken of ["2025-11-25", "2025-06-18"]) {
      expect(await result(await rpc("ping", undefined, { headers: { "MCP-Protocol-Version": spoken } }))).toEqual({});
    }
  });

  it("negotiates initialize from its body, whatever version its header names (#460)", async () => {
    // a newer client sends the version it asks for in the header of initialize as well; the
    // header rule is the transport's for requests AFTER initialization, so it never refuses this
    start();
    for (const header of ["2026-07-28", "2025-03-26", "2025-06-18"]) {
      const answered = await rpc("initialize", { protocolVersion: "2026-07-28" }, { headers: { "MCP-Protocol-Version": header } });
      expect(answered.status).toBe(200);
      expect((await result(answered)).protocolVersion).toBe("2025-11-25");
    }
    // the exemption is initialize's alone: the same header on any other request is still refused
    for (const method of ["ping", "tools/list"]) {
      expect((await rpc(method, undefined, { headers: { "MCP-Protocol-Version": "2026-07-28" } })).status).toBe(400);
    }
    // and an initialize REQUEST's alone (the owner, 2026-11-20): an initialize sent as a
    // notification, with no id, negotiates nothing and is refused for the header as before
    const notification = await h.call("/mcp", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "initialize" }),
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
    });
    expect(notification.status).toBe(400);
    expect((await body(notification)).error.code).toBe(-32600);
    // and the header's 400 still comes BEFORE the body's own faults: a body that is not JSON, sent
    // with a version this server does not speak, is refused for the version, as it was before #460
    const both = await h.call("/mcp", {
      method: "POST", body: "{nope",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
    });
    expect(both.status).toBe(400);
    expect(await body(both)).toEqual({
      jsonrpc: "2.0", id: null, error: {
        code: -32600,
        message: "Bad Request: unsupported MCP-Protocol-Version 2026-07-28; this server speaks 2025-11-25, 2025-06-18",
      },
    });
  });

  it("reads a body that starts with a UTF-8 BOM as the JSON after it (#462)", async () => {
    start();
    const BOM = [0xef, 0xbb, 0xbf];
    const post = (text: string, headers: Record<string, string> = {}) => h.call("/mcp", {
      method: "POST", body: new Uint8Array([...BOM, ...new TextEncoder().encode(text)]),
      headers: { "Content-Type": "application/json", ...headers },
    });
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
    for (const headers of [{}, { "MCP-Protocol-Version": "2026-07-28" }]) {
      const answered = await post(init, headers);
      expect(answered.status).toBe(200);
      expect((await body(answered)).result.protocolVersion).toBe("2025-11-25");
    }
    const notJson = await post("{nope");
    expect(notJson.status).toBe(400);
    expect((await body(notJson)).error.code).toBe(-32700);
  });

  it("echoes an integral id as an integer, whatever way it was written", async () => {
    start();
    const resp = await h.call("/mcp", {
      method: "POST", body: '{"jsonrpc":"2.0","id":1.0,"method":"ping"}', headers: { "Content-Type": "application/json" },
    });
    expect(await resp.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
  });

  it("answers a ping with nothing", async () => {
    start();
    expect(await result(await rpc("ping"))).toEqual({});
  });

  it("accepts a notification with 202 and no body", async () => {
    start();
    const resp = await h.call("/mcp", json({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(resp.status).toBe(202);
    expect(await resp.text()).toBe("");
  });

  it("says a method it does not have is not found, with the request's id", async () => {
    start();
    const resp = await rpc("resources/list");
    expect(resp.status).toBe(200);
    const answer = await body(resp);
    expect(answer).toEqual({
      jsonrpc: "2.0", id: nextId, error: { code: -32601, message: "Method not found: resources/list" },
    });
  });

  it("refuses a body that is not JSON, a batch, and a message that is not JSON-RPC, each with 400", async () => {
    start();
    const post = (raw: string) => h.call("/mcp", { method: "POST", body: raw, headers: { "Content-Type": "application/json" } });
    const notJson = await post("{nope");
    expect(notJson.status).toBe(400);
    expect((await body(notJson)).error.code).toBe(-32700);
    const batch = await post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(batch.status).toBe(400);
    expect((await body(batch)).error.code).toBe(-32600);
    const bare = await post(JSON.stringify({ id: 7, method: "ping" }));
    expect(bare.status).toBe(400);
    expect(await body(bare)).toMatchObject({ id: 7, error: { code: -32600 } });
  });

  it("offers no stream: a GET is 405, saying it takes a POST", async () => {
    start();
    const resp = await h.call("/mcp");
    expect(resp.status).toBe(405);
    expect(resp.headers.get("Allow")).toBe("POST");
  });

  it("refuses a request a browser page sent, which carries an Origin", async () => {
    start();
    const resp = await rpc("ping", undefined, { headers: { Origin: "https://evil.example" } });
    expect(resp.status).toBe(403);
  });

  it("wants the API's token, as every route does", async () => {
    start();
    expect((await rpc("ping", undefined, { anonymous: true })).status).toBe(401);
    expect((await rpc("tools/list", undefined, { anonymous: true })).status).toBe(401);
  });

  it("says nothing in the log about a call that worked, which is the flood an agent makes", async () => {
    start();
    const said: string[] = [];
    const saved = { log: console.log, error: console.error };
    console.log = (...a: unknown[]) => { said.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
    try {
      await rpc("ping");
      await call("positions");
    } finally {
      Object.assign(console, saved);
    }
    expect(said).toEqual([]);
  });
});

describe("the tools", () => {
  it("are exactly these, each a read that changes nothing", async () => {
    // The whole list, stated: a tool added — a write least of all — is a decision, not a diff
    // nobody reads (#447, decision 4).
    start();
    const { tools } = await result(await rpc("tools/list"));
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      "holdings", "watchlist", "positions", "holding_history", "monitor_history", "monitor_closes",
      "references", "price_spreads", "health",
    ]);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      });
      expect(tool.description.length, tool.name).toBeGreaterThan(200);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("each serve a GET the API documents, and nothing else", async () => {
    // the read handed to the door is a GET by construction (`app.ts`); this holds the table to
    // paths that ARE reads, so no tool can be a GET of something that is not there. A write tool
    // names its method (ADR 0028), and is held by the writes' own test below
    start();
    const spec = await body(await h.call("/openapi.json"));
    const { DESCRIBED } = await import("./tools.ts");
    for (const tool of DESCRIBED.tools.filter((t) => t.method === undefined)) {
      expect(spec.paths[tool.path]?.get, `${tool.name}: GET ${tool.path} is not documented`).toBeTruthy();
    }
  });

  it("answer with the very body their GET serves, said with its source and when it was read", async () => {
    start();
    const ids = await book();
    for (const [name, path, args] of TOOLS(ids)) {
      const answer = await call(name, args);
      expect(answer.isError, `${name}: ${answer.text}`).toBe(false);
      const direct = await h.call(path);
      expect(direct.status, path).toBe(200);
      // the body as the GET serves it, each figure rounded by its key (#454) and nothing else
      expect(answer.data, name).toEqual(rounded(await body(direct), DESCRIBED.tools.find((t) => t.name === name)!.round));
      expect(answer.source).toBe(`GET ${path}`);
      expect(answer.read_at).toBe("2026-10-02 13:26:06+08:00");
    }
  });

  it("write the answer with its keys sorted and no spaces, so both backends write the same text", async () => {
    start();
    const answer = await call("health");
    expect(answer.text.startsWith('{"data":{"db":true,"golden_cases":')).toBe(true);
    expect(answer.text).not.toMatch(/": /);
  });

  it("refuse an id or a name that is not one of the service's, in words an agent can correct", async () => {
    start();
    expect(await call("holding_history", { id: "nope" })).toMatchObject({
      isError: true,
      text: 'no holding is "nope": tried it as a holding\'s id and as its name. positions lists every holding\'s id',
    });
    expect(await call("monitor_history", { id: "nope" })).toMatchObject({
      isError: true,
      text: 'no rule is "nope": tried it as a rule\'s id, as its code or combo name. watchlist lists every rule\'s id',
    });
  });

  it("refuse arguments that are not the tool's before asking the API anything", async () => {
    start();
    const pattern = "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]{1,64}$";
    for (const id of ["dec\u0000condor", "dec\ncondor", "dec\u009fcondor", "x".repeat(65), "", "dec \u{1F985}"]) {
      expect(await call("holding_history", { id }), JSON.stringify(id)).toMatchObject({
        isError: true, text: `argument "id" must be a string matching ${pattern}`,
      });
    }
    expect(await call("holding_history", { id: 7 })).toMatchObject({ isError: true });
    expect(await call("holding_history")).toMatchObject({ isError: true, text: 'missing argument "id"' });
    expect(await call("holding_history", { id: "a", at: "b" })).toMatchObject({
      isError: true, text: 'unexpected argument "at": holding_history takes only "id"',
    });
    expect(await call("watchlist", { fresh: true })).toMatchObject({
      isError: true, text: 'unexpected argument "fresh": watchlist takes no arguments',
    });
    expect(await call("health", [])).toMatchObject({ isError: true, text: "arguments must be an object" });
    expect(asked).toEqual([]);
  });

  it("say a tool they do not have is unknown, as a protocol error", async () => {
    start();
    const answer = await body(await rpc("tools/call", { name: "close_position", arguments: { id: "x" } }));
    expect(answer.error).toEqual({ code: -32602, message: "Unknown tool: close_position" });
  });

  it("carry a Provider's failure as a tool error in the service's own words", async () => {
    let down = false;
    start((codes) => down ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:33333")) : pricedFetcher(codes));
    await book();
    down = true;
    const answer = await call("watchlist");
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^GET \/quotes answered 502: .*ECONNREFUSED/);
  });
});

describe("price_spreads prices any structure through GET /spreads/quote (#452, ADR 0027)", () => {
  const D = EXPIRY.replaceAll("-", "");
  const PUTS = { expiry: D, legs: [{ side: "short", option_type: "PUT", strike: 7100 }, { side: "long", option_type: "PUT", strike: 7075 }] };
  const RATIO = {
    expiry: EXPIRY, entry: -1.5,
    legs: [{ side: "long", option_type: "CALL", strike: 8050 }, { side: "short", option_type: "CALL", strike: 8075, qty: 2 }],
  };

  it("encodes the structures into the route's query and answers its very body", async () => {
    start();
    const answer = await call("price_spreads", { structures: [PUTS, RATIO] });
    expect(answer.isError, answer.text).toBe(false);
    const path = `/spreads/quote?spread=${encodeURIComponent(`${D}:-P7100,+P7075`)}`
      + `&spread=${encodeURIComponent(`${EXPIRY}:+C8050,-C8075x2@-1.5`)}`;
    expect(answer.source).toBe(`GET ${path}`);
    expect(asked).toHaveLength(1);
    expect(answer.data).toEqual(rounded(await body(await h.call(path)), DESCRIBED.tools.find((t) => t.name === "price_spreads")!.round));
    // the harness's quotes carry a mid and no sides, which is no two-sided quote: a shape, then the entry
    expect(answer.data.spreads.map((s: { payoff_basis: string }) => s.payoff_basis)).toEqual(["shape", "entry"]);
  });

  it("leaves the sharing to the route, so a batch is never held twice over", async () => {
    start();
    await call("price_spreads", { structures: [PUTS] });
    h.now = new Date(h.now.getTime() + 4000);
    // the route's batch is shared, so the Provider is not asked again...
    const again = await call("price_spreads", { structures: [PUTS] });
    expect(asked).toHaveLength(1);
    // ...but the door read it afresh, at its own instant
    expect(again.read_at).toBe("2026-10-02 13:26:10+08:00");
    h.now = new Date(h.now.getTime() + 1000);
    await call("price_spreads", { structures: [PUTS] });
    expect(asked).toHaveLength(2);
  });

  it("carries the route's refusal as a tool error in its own words, asking nothing", async () => {
    start();
    const answer = await call("price_spreads", { structures: [{ ...PUTS, legs: [{ side: "short", option_type: "PUT", strike: 7100, qty: 11 }] }] });
    expect(answer).toMatchObject({ isError: true });
    expect(answer.text).toMatch(/answered 422: spread 1, leg 1: a quantity is 1 to 10, not 11$/);
    expect(asked).toEqual([]);
  });

  it.each([
    [{}, 'missing argument "structures"'],
    [{ structures: "20261218:-P6800" }, '"structures" must be a list of structures'],
    [{ structures: [7] }, "structures[0] must be an object"],
    [{ structures: [{ legs: [] }] }, "structures[0] is missing \"expiry\""],
    [{ structures: [{ ...PUTS, expiry: "Dec 18" }] }, "structures[0].expiry must be a string matching ^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$"],
    [{ structures: [{ ...PUTS, legs: "-P7100" }] }, "structures[0].legs must be a list of legs"],
    [{ structures: [{ ...PUTS, size: 2 }] }, "structures[0] has an unexpected \"size\": a structure takes only \"expiry\", \"legs\", \"entry\""],
    [{ structures: [{ ...PUTS, entry: "1.5" }] }, "structures[0].entry must be a number"],
    [{ structures: [{ ...PUTS, legs: [{ side: "sold", option_type: "PUT", strike: 7100 }] }] }, "structures[0].legs[0].side must be \"short\" or \"long\""],
    [{ structures: [{ ...PUTS, legs: [{ side: "short", option_type: "P", strike: 7100 }] }] }, "structures[0].legs[0].option_type must be \"CALL\" or \"PUT\""],
    [{ structures: [{ ...PUTS, legs: [{ side: "short", option_type: "PUT", strike: "7100" }] }] }, "structures[0].legs[0].strike must be a number"],
    [{ structures: [{ ...PUTS, legs: [{ side: "short", option_type: "PUT", strike: 7100, qty: "2" }] }] }, "structures[0].legs[0].qty must be a number"],
    [{ structures: [{ ...PUTS, legs: [{ side: "short", option_type: "PUT" }] }] }, "structures[0].legs[0] is missing \"strike\""],
    [{ structures: [{ ...PUTS, legs: [{ side: "short", option_type: "PUT", strike: 7100, sign: -1 }] }] },
      "structures[0].legs[0] has an unexpected \"sign\": a leg takes only \"side\", \"option_type\", \"strike\", \"qty\""],
  ])("refuses arguments it cannot write as a query, before asking anything: %j", async (args, words) => {
    start();
    expect(await call("price_spreads", args)).toMatchObject({ isError: true, text: words });
    expect(asked).toEqual([]);
  });
});

describe("the history tools take a name as well as an id", () => {
  // An agent asked "how has 1218-6800 moved?" called monitor_history with the name, got a 404, and
  // recovered only by searching the watchlist for the id (2026-11-18): one call, not three.
  const PUT_RULE = { strike_date: EXPIRY, option_type: "PUT", strike: 7100, field: "option_delta", threshold: 0.15, direction: "above" };
  const COMBO = {
    name: "1218-6800", strike_date: EXPIRY, field: "mid_price", threshold: 2.5, direction: "above",
    legs: [{ sign: -1, option_type: "PUT", strike: 7100 }, { sign: 1, option_type: "PUT", strike: 7075 }],
  };

  /** `book`, plus a second rule on the short put (its price beside its Δ), a combo, and a closed holding. */
  const names = async () => {
    const ids = await book();
    const putDelta = await created(await h.call("/monitors", json(PUT_RULE)));
    const putPrice = await created(await h.call("/monitors", json({ ...PUT_RULE, field: "mid_price", threshold: 9.5 })));
    const comboRule = await created(await h.call("/monitors", json(COMBO)));
    const closed = await created(await h.call("/positions", json({ ...CONDOR, name: "oct-condor" })));
    const shut = await h.call(`/positions/${closed}/close`, json({ exit: 1.25, closed_on: "2026-10-01" }));
    expect(shut.status, await shut.clone().text()).toBe(200);
    asked = [];
    return { ...ids, putDelta, putPrice, comboRule, closed };
  };

  /** The answer `given` reads, held to the GET by `id`'s own: the same data, `source` naming the id. */
  const same = async (name: "holding_history" | "monitor_history", given: string, id: string) => {
    const path = name === "holding_history" ? `/positions/${id}/samples` : `/monitors/${id}/samples`;
    const answer = await call(name, { id: given });
    expect(answer.isError, `${given}: ${answer.text}`).toBe(false);
    expect(answer.source, given).toBe(`GET ${path}`);
    expect(answer.data, given).toEqual(await body(await h.call(path)));
  };

  it("read a holding by its id or its name, open or closed", async () => {
    start();
    const ids = await names();
    await same("holding_history", ids.position, ids.position);
    await same("holding_history", "1016_IC", ids.position);
    await same("holding_history", "  1016_IC ", ids.position);
    await same("holding_history", "oct-condor", ids.closed);
    expect(asked).toEqual([]);
  });

  it("read a rule by its id, its code as stored, or its contract as the page and the bot write it", async () => {
    start();
    const ids = await names();
    await same("monitor_history", ids.monitor, ids.monitor);
    await same("monitor_history", "1218-6800", ids.comboRule);
    await same("monitor_history", "US.SPXW261218C8050000", ids.monitor);
    for (const spelled of ["20261218 C8050", "261218 C8050", "20261218c8050", " 20261218 C8050 "]) {
      await same("monitor_history", spelled, ids.monitor);
    }
    expect(asked).toEqual([]);
  });

  it("match a name exactly: case is the owner's, except in a contract written the page's way", async () => {
    start();
    await names();
    expect((await call("holding_history", { id: "1016_ic" })).isError).toBe(true);
    expect((await call("monitor_history", { id: "1218-6800 " })).isError).toBe(false);
    expect((await call("monitor_history", { id: "us.spxw261218c8050000" })).isError).toBe(true);
  });

  it("trim as JavaScript does, which the Python spells out", async () => {
    // Python's strip() takes U+001C–U+001F and U+0085, which trim does not (all refused as control
    // characters anyway); trim takes U+FEFF and U+3000, as the Python must too
    start();
    const ids = await names();
    await same("holding_history", "\uFEFF1016_IC\u3000", ids.position);
  });

  it("list each candidate where a name matches several rules, to call again with one id", async () => {
    start();
    const ids = await names();
    for (const given of ["20261218 P7100", "US.SPXW261218P7100000"]) {
      expect(await call("monitor_history", { id: given })).toEqual({
        isError: true,
        text: [`"${given}" names 2 rules; call again with one of their ids:`,
          `${ids.putDelta} — |Δ| ≥ 0.15`, `${ids.putPrice} — |value| ≥ 9.50`].join("\n"),
      });
    }
  });

  it("say what was tried when nothing matches, the contract included", async () => {
    start();
    await names();
    expect(await call("monitor_history", { id: "20261218 C9999" })).toEqual({
      isError: true,
      text: 'no rule is "20261218 C9999": tried it as a rule\'s id, as its code or combo name, and as the contract US.SPXW261218C9999000. watchlist lists every rule\'s id',
    });
  });

  it("never put what the caller typed in a path: a name like a path is looked up, and not found", async () => {
    start();
    await names();
    for (const given of ["../quotes", "../../settings", "%2e%2e%2fquotes", "1016_IC/../../quotes", "?id=x"]) {
      expect((await call("holding_history", { id: given })).text, given).toMatch(/^no holding is /);
      expect((await call("monitor_history", { id: given })).text, given).toMatch(/^no rule is /);
    }
    expect(asked).toEqual([]);
  });

  it("read only the list and the resolved id's history, both GETs the door already makes", async () => {
    const reads: string[] = [];
    const rows: Record<string, unknown[]> = {
      "/monitors": [{ id: "mon-7", code: "1218-6800", field: "mid_price", compare: "signed", direction: "above", threshold: 1, legs: [{}, {}] }],
      "/positions": [{ id: "pos-7", name: "../quotes" }],
    };
    const box = toolbox({
      now: () => new Date("2026-11-18T00:00:00Z"), displayTz: "UTC",
      read: async (path) => { reads.push(path); return { status: 200, body: JSON.stringify(rows[path] ?? {}) }; },
    });
    expect((await box.call("monitor_history", { id: "1218-6800" }, null)).isError).toBeUndefined();
    expect((await box.call("holding_history", { id: "../quotes" }, null)).isError).toBeUndefined();
    expect(reads).toEqual(["/monitors", "/monitors/mon-7/samples", "/positions", "/positions/pos-7/samples"]);
  });

  it("refuse to build a path from a stored id that is not an id", async () => {
    const reads: string[] = [];
    const box = toolbox({
      now: () => new Date("2026-11-18T00:00:00Z"), displayTz: "UTC",
      read: async (path) => { reads.push(path); return { status: 200, body: JSON.stringify([{ id: "../quotes", name: "odd" }]) }; },
    });
    expect(await box.call("holding_history", { id: "odd" }, null)).toEqual({
      isError: true, content: [{ type: "text", text: 'the holding "odd" has an id no path can carry' }],
    });
    expect(reads).toEqual(["/positions"]);
  });

  it("carry a list that cannot be read as a tool error in the service's own words", async () => {
    const box = toolbox({
      now: () => new Date("2026-11-18T00:00:00Z"), displayTz: "UTC",
      read: async () => ({ status: 500, body: JSON.stringify({ detail: "database is locked" }) }),
    });
    expect(await box.call("monitor_history", { id: "mon-1" }, null)).toEqual({
      isError: true, content: [{ type: "text", text: "GET /monitors answered 500: database is locked" }],
    });
  });
});

describe("the live reads' shared cache", () => {
  it("asks the Provider once for an agent calling in a tight loop, and again once the window has passed", async () => {
    start();
    await book();
    for (let i = 0; i < 50; i++) await call("watchlist");
    expect(asked).toHaveLength(1);
    h.now = new Date(h.now.getTime() + LIVE_FOR_MS - 1);
    const shared = await call("watchlist");
    expect(asked).toHaveLength(1);
    // the answer says when it was READ, which is the first call's instant, not this one's
    expect(shared.read_at).toBe("2026-10-02 13:26:06+08:00");
    h.now = new Date(h.now.getTime() + 1);
    const again = await call("watchlist");
    expect(asked).toHaveLength(2);
    expect(again.read_at).toBe("2026-10-02 13:26:11+08:00");
  });

  it("shares a read still in flight with everyone who asks meanwhile", async () => {
    start();
    await book();
    await Promise.all(Array.from({ length: 20 }, () => call("watchlist")));
    expect(asked).toHaveLength(1);
  });

  it("covers every live tool, each with its own read", async () => {
    start();
    await book();
    for (const name of ["holdings", "watchlist", "references"]) {
      const before = asked.length;
      await call(name);
      expect(asked.length, `${name} asked nothing at all — not a live tool any more?`).toBe(before + 1);
      for (let i = 0; i < 10; i++) await call(name);
      expect(asked.length, `${name} is not shared`).toBe(before + 1);
    }
  });

  it("shares a refusal too, so a Provider that is down is asked once per window", async () => {
    let down = false;
    start((codes) => down ? Promise.reject(new Error("down")) : pricedFetcher(codes));
    await book();
    down = true;
    for (let i = 0; i < 10; i++) expect((await call("watchlist")).isError).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("leaves the page and the reads that are not live alone", async () => {
    start();
    await book();
    await call("watchlist");
    expect(asked).toHaveLength(1);
    // the dashboard's own poll is never served from the MCP's window
    await h.call("/quotes");
    await h.call("/quotes");
    expect(asked).toHaveLength(3);
    // and a stored read is read afresh each time: a sweep may have written since
    expect((await call("positions")).data[0].name).toBe("1016_IC");
    h.db.prepare("update positions set name = 'renamed'").run();
    expect((await call("positions")).data[0].name).toBe("renamed");
  });
});

describe("figures are rounded by key, per tool (#454)", () => {
  const SHARED = JSON.parse(readFileSync(new URL("../../../../testdata/mcp/rounding.json", import.meta.url), "utf8")) as
    { cases: [number, number, string][] };

  it("half away from zero on the stored value, to a number, -0 written 0: the cases both backends hold", () => {
    expect(SHARED.cases.length).toBeGreaterThan(20);
    for (const [value, places, text] of SHARED.cases) {
      const r = roundTo(value, places);
      expect(typeof r).toBe("number");
      expect(canonical(r), `${value} to ${places}`).toBe(text);
      expect(Object.is(r, -0), `${value} to ${places}`).toBe(false);
    }
  });

  it("round a figure by its key, the numbers of an array under it, a map's every value, and a rule's by its field", () => {
    const table: Rounding = { keys: { value: 2, breakevens: 2, sigma: 4 }, maps: { legs_delta: 4 }, by_field: ["watched", "threshold"] };
    const data = {
      value: -4.100000000000001, sigma: 1.234567, strike: 6800.5, dte: 39, error: "3.14159", nothing: null, flag: true,
      breakevens: [6301.456, 6398.555],
      legs_delta: { "US.SPXW261218P6800000": -0.234567, "US.SPXW261218P6750000": null },
      // an object in a list does not inherit its list's key
      payoff: [{ value: 1.005, other: 1.23456789 }],
      rows: [
        { field: "mid_price", watched: -1.1000000000000003, threshold: 4.125, distance: 3.0249999999999995 },
        { field: "option_gamma", watched: -0.0000403, threshold: 0.00012 },
        { field: "option_delta", watched: 0.123456789, threshold: 0.31234 },
        { field: "something_else", watched: 0.123456789 },
        { watched: 0.123456789 },
      ],
      // a key the prototype carries is not a key the table names
      constructor: 1.23456789, toString: 2.3456789,
    };
    expect(rounded(data, table)).toEqual({
      value: -4.1, sigma: 1.2346, strike: 6800.5, dte: 39, error: "3.14159", nothing: null, flag: true,
      breakevens: [6301.46, 6398.56],
      legs_delta: { "US.SPXW261218P6800000": -0.2346, "US.SPXW261218P6750000": null },
      payoff: [{ value: 1, other: 1.23456789 }],
      rows: [
        { field: "mid_price", watched: -1.1, threshold: 4.13, distance: 3.0249999999999995 },
        { field: "option_gamma", watched: -0.00004, threshold: 0.00012 },
        { field: "option_delta", watched: 0.1235, threshold: 0.3123 },
        { field: "something_else", watched: 0.123456789 },
        { watched: 0.123456789 },
      ],
      constructor: 1.23456789, toString: 2.3456789,
    });
  });

  it("are tabled for every tool, to 2, 4 or 6 places, and a rule's figures by the six fields a rule may watch", () => {
    expect(DESCRIBED.rounding.by_field).toMatchObject({
      mid_price: 2, option_delta: 4, option_gamma: 6, option_theta: 4, option_vega: 4, option_implied_volatility: 4,
    });
    for (const tool of DESCRIBED.tools) {
      const { keys = {}, maps = {}, by_field = [] } = tool.round;
      for (const places of [...Object.values(keys), ...Object.values(maps)]) expect([2, 4, 6], tool.name).toContain(places);
      // a key is in one row of the table, never two
      const named = [...Object.keys(keys), ...Object.keys(maps), ...by_field];
      expect(new Set(named).size, tool.name).toBe(named.length);
    }
  });

  it("place every field a rule may watch, and nothing else, in the by-field table: a number, or null for never", () => {
    // a rule on a field with no place would have its watched, threshold and distance left raw
    // (review of #455, the owner's decision 2)
    const table = DESCRIBED.rounding.by_field;
    expect(Object.keys(table).sort()).toEqual([...WATCHABLE_FIELDS].sort());
    for (const field of WATCHABLE_FIELDS) expect([2, 4, 6, null], field).toContain(table[field]);
  });

  it("round a quote's figure as a rule watching that field is rounded, and every figure of moomoo's record", () => {
    // the watchlist's `quote` is moomoo's whole record (review of #455, the owner's decision 1): every
    // number in it is a watchable field, so the by-field table places each, in every tool alike
    const numbers = opendFields.RECORD_FIELDS.filter((f) => WATCHABLE_FIELDS.includes(f));
    expect(numbers.length).toBeGreaterThan(25);
    const watchlist = DESCRIBED.tools.find((t) => t.name === "watchlist")!.round.keys!;
    for (const field of numbers) {
      expect(watchlist[field] ?? null, field).toBe(DESCRIBED.rounding.by_field[field]);
    }
    for (const tool of DESCRIBED.tools) {
      for (const [key, places] of Object.entries(tool.round.keys ?? {})) {
        if (WATCHABLE_FIELDS.includes(key)) expect(places, `${tool.name}: ${key}`).toBe(DESCRIBED.rounding.by_field[key]);
      }
    }
  });

  it("leave no figure in any MCP scenario's answer under a key the table does not name, nor unrounded under one it does", () => {
    const dir = new URL("../../../../testdata/scenarios/http/", import.meta.url).pathname;
    let walked = 0;
    for (const file of readdirSync(dir).filter((f) => f.startsWith("post-mcp-"))) {
      const scenario = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const { method, params } = scenario.request.body ?? {};
      const result = scenario.expect.response.body?.result;
      if (method !== "tools/call" || result === undefined || result.isError) continue;
      const tool = DESCRIBED.tools.find((t) => t.name === params.name)!;
      byKey(JSON.parse(result.content[0].text).data, tool.round, (value, places) => {
        walked++;
        if (places === null) expect(Number.isInteger(value), `${file}: ${value} is under no key the table names`).toBe(true);
        else expect(roundTo(value, places), `${file}: ${value} is not rounded to ${places}`).toBe(value);
        return value;
      });
    }
    // what it walked, so a walk of nothing cannot pass
    expect(walked).toBeGreaterThan(200);
  });
});

describe("an agent's writes: add_rule and edit_rule, behind MCP_WRITES (#456, ADR 0028)", () => {
  const D = EXPIRY.replaceAll("-", "");
  const PUT_SPREAD = {
    expiry: D, name: "1218-7100", threshold: 3,
    legs: [{ side: "short", option_type: "PUT", strike: 7100 }, { side: "long", option_type: "PUT", strike: 7075 }],
  };
  const TELEGRAM = { telegramBotToken: "t", telegramChatId: "42" };
  const READS = [
    "holdings", "watchlist", "positions", "holding_history", "monitor_history", "monitor_closes",
    "references", "price_spreads", "health",
  ];

  /** The harness with writes on (unless said), Telegram configured (unless said), and the Provider
   *  counted as `start` counts it. */
  const writing = (settings: Partial<Settings> = {}, fetchQuotes: FakeProvider = pricedFetcher as FakeProvider) => {
    asked = [];
    h = harness({
      settings: { mcpWrites: true, ...TELEGRAM, ...settings },
      fetchQuotes: (codes) => { asked.push(codes); return fetchQuotes(codes); },
    });
    return h;
  };
  const rules = async () => (await body(await h.call("/monitors"))) as Record<string, unknown>[];
  /** The log lines a block wrote, info and warnings and errors alike. */
  const logged = async (fn: () => Promise<unknown>) => {
    const said: string[] = [];
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const take = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
    Object.assign(console, { log: take, info: take, warn: take, error: take });
    try {
      await fn();
    } finally {
      Object.assign(console, saved);
    }
    return said;
  };
  const WRITES_OFF = "writes are off on this service: add_rule and edit_rule need MCP_WRITES=1 in its .env, which only its owner sets";

  describe("the switch", () => {
    it("is off by default: the writes are not listed, every tool listed is a read, and the instructions say so", async () => {
      start();
      const { tools } = await result(await rpc("tools/list"));
      expect(tools.map((t: { name: string }) => t.name)).toEqual(READS);
      for (const tool of tools) expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      const { instructions } = await result(await rpc("initialize", { protocolVersion: "2025-11-25" }));
      expect(instructions).toContain("WRITES ARE OFF on this service");
      expect(instructions).not.toContain("WRITES ARE ON");
    });

    it("off, refuses a write before asking anything, writing nothing and counting nothing", async () => {
      start();
      await book();
      const before = await rules();
      for (const [name, args] of [["add_rule", PUT_SPREAD], ["edit_rule", { id: "anything", threshold: 1 }]] as const) {
        expect(await call(name, args)).toMatchObject({ isError: true, text: WRITES_OFF });
      }
      // even arguments that are not the tool's: the switch is the first thing said
      expect(await call("add_rule", { nonsense: true })).toMatchObject({ isError: true, text: WRITES_OFF });
      expect(asked).toEqual([]);
      expect(await rules()).toEqual(before);
      expect(h.sent).toEqual([]);
    });

    it("on, lists the two writes after the reads, each annotated as the write it is, and the instructions say so", async () => {
      writing({ mcpWritesPer10Min: 7 });
      const { tools } = await result(await rpc("tools/list"));
      expect(tools.map((t: { name: string }) => t.name)).toEqual([...READS, "add_rule", "edit_rule"]);
      const annotations = Object.fromEntries(tools.map((t: { name: string; annotations: unknown }) => [t.name, t.annotations]));
      for (const name of READS) {
        expect(annotations[name], name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      }
      expect(annotations.add_rule).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      expect(annotations.edit_rule).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      const { instructions } = await result(await rpc("initialize", { protocolVersion: "2025-11-25" }));
      expect(instructions).toContain("WRITES ARE ON, for alarm rules");
      expect(instructions).toContain("Writes to the BOOK are off");
      expect(instructions).toContain("at most 7 writes of any kind may reach the service in any ten minutes");
      expect(instructions).not.toContain("{cap}");
    });
  });

  describe("the door's reach for a write", () => {
    it("lists exactly four writes in server.json, two of rules and two of the book, each a route the API documents (ADR 0029)", async () => {
      start();
      expect(WRITES.map((w) => `${w.tier} ${w.method} ${w.path}`)).toEqual([
        "rules POST /monitors", "rules PATCH /monitors/{id}", "positions POST /positions", "positions PATCH /positions/{id}",
      ]);
      const spec = await body(await h.call("/openapi.json"));
      for (const { method, path } of WRITES) {
        expect(spec.paths[path]?.[method.toLowerCase()], `${method} ${path} is not documented`).toBeTruthy();
      }
    });

    it("lets through only the pairs server.json lists, refusing every other before the app is asked", async () => {
      const made: string[] = [];
      const write = allowedWrite(async (method, path) => { made.push(`${method} ${path}`); return { status: 200, body: "{}" }; });
      await write("POST", "/monitors", {}, null);
      await write("PATCH", "/monitors/mon-1", {}, null);
      await write("PATCH", "/monitors/00000000000000000000000000000001", {}, null);
      await write("POST", "/positions", {}, null);
      await write("PATCH", "/positions/pos-1", {}, null);
      for (const [method, path] of [
        ["GET", "/monitors"], ["DELETE", "/monitors/mon-1"], ["PUT", "/monitors/mon-1"], ["POST", "/monitors/mon-1"],
        ["PATCH", "/monitors"], ["PATCH", "/positions"], ["POST", "/positions/pos-1"], ["PUT", "/positions/pos-1"],
        ["POST", "/positions/payoff"], ["PATCH", "/positions/pos-1/close"], ["POST", "/positions/"],
        ["PATCH", "/positions/../monitors/mon-1"], ["PATCH", "/positions/pos-1?exit=1"], ["patch", "/positions/pos-1"],
        ["POST", "/spreads"],
        ["PATCH", "/settings"], ["POST", "/monitors/mon-1/total-entry"], ["PATCH", "/monitors/../positions/pos-1"],
        ["PATCH", "/monitors/mon 1"], ["PATCH", "/monitors/mon-1?x=1"], ["post", "/monitors"], ["POST", "/monitors/"],
        ["DELETE", "/positions/pos-1"], ["POST", "/positions/pos-1/close"], ["PATCH", `/monitors/${"x".repeat(65)}`],
        ["PATCH", "/monitors/mon-1\n"],
      ]) {
        await expect(write(method!, path!, {}, null), `${method} ${path}`).rejects
          .toThrow(`the MCP door may not ${method} ${path}: it writes only POST /monitors, PATCH /monitors/{id}, POST /positions and PATCH /positions/{id}`);
      }
      expect(made).toEqual([
        "POST /monitors", "PATCH /monitors/mon-1", "PATCH /monitors/00000000000000000000000000000001",
        "POST /positions", "PATCH /positions/pos-1",
      ]);
    });
  });

  describe("add_rule", () => {
    it("adds a put spread's rule through POST /monitors, answers the rule as created, and tells the owner once", async () => {
      writing();
      const answer = await call("add_rule", PUT_SPREAD);
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.source).toBe("POST /monitors");
      expect(answer.read_at).toBe("2026-10-02 13:26:06+08:00");
      const [made] = await rules();
      expect(answer.data).toEqual(made);
      expect(made).toMatchObject({
        code: "1218-7100", field: "mid_price", threshold: 3, direction: "above", compare: "abs", enabled: true,
        legs: [{ sign: -1, option_type: "PUT", strike: 7100 }, { sign: 1, option_type: "PUT", strike: 7075 }],
      });
      // the route's own probe, of both legs, in one call
      expect(asked).toHaveLength(1);
      expect([...asked[0]!].sort()).toEqual(["US.SPXW261218P7075000", "US.SPXW261218P7100000"]);
      expect(h.sent).toEqual(["🤖 agent added 1218-7100 |value| ≥ 3.00"]);
    });

    it("adds a rule on one contract, its side meaning nothing, with the route's defaults", async () => {
      writing();
      const answer = await call("add_rule", { expiry: EXPIRY, legs: [{ side: "short", option_type: "CALL", strike: 8050, qty: 1 }], threshold: 0.2 });
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.data).toMatchObject({ code: "US.SPXW261218C8050000", field: "option_delta", direction: "above", compare: "abs", legs: null });
      expect(h.sent).toEqual(["🤖 agent added 20261218 C8050 |Δ| ≥ 0.20"]);
    });

    it("adds a rule the route links to a holding, and names the holding in the notice (review of #457)", async () => {
      writing();
      await created(await h.call("/positions", json(CONDOR)));
      const answer = await call("add_rule", { expiry: D, legs: [{ side: "short", option_type: "PUT", strike: 7100 }], threshold: 0.2 });
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.data.positions).toEqual([{ id: expect.any(String), name: "1016_IC" }]);
      expect(h.sent).toEqual(["🤖 agent added 20261218 P7100 |Δ| ≥ 0.20 on 1016_IC"]);
    });

    it("passes field, direction and compare only where given", async () => {
      writing();
      const answer = await call("add_rule", { ...PUT_SPREAD, compare: "signed", direction: "below", threshold: -4.5 });
      expect(answer.data).toMatchObject({ field: "mid_price", compare: "signed", direction: "below", threshold: -4.5 });
      expect(h.sent).toEqual(["🤖 agent added 1218-7100 close ≥ 4.50"]);
    });

    it("refuses a quantity, a combo with no name, a name on one contract and a wrong shape, asking nothing and counting nothing", async () => {
      writing({ mcpWritesPer10Min: 1 });
      const one = { expiry: D, legs: [{ side: "long", option_type: "CALL", strike: 8050 }], threshold: 0.2 };
      for (const [args, words] of [
        [{ ...PUT_SPREAD, legs: [PUT_SPREAD.legs[0], { ...PUT_SPREAD.legs[1], qty: 2 }] },
          "legs[1].qty is 2: a rule here watches one of each contract — a rule on a structure with quantities is made on the page"],
        [{ ...PUT_SPREAD, name: undefined },
          'a rule on 2 legs is a combo, and a combo needs a "name": it becomes the rule\'s code ("1218-6750")'],
        [{ ...one, name: "mine" }, 'a rule on one contract takes no "name": its code is the contract\'s'],
        [{ ...one, legs: [] }, '"legs" must hold one leg or more'],
        [{ ...one, legs: "P7100" }, '"legs" must be a list of legs'],
        [{ ...one, expiry: "Dec 18" }, 'argument "expiry" must be a string matching ^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$'],
        [{ ...one, legs: [{ side: "sold", option_type: "CALL", strike: 8050 }] }, 'legs[0].side must be "short" or "long"'],
        [{ ...one, legs: [{ side: "long", option_type: "CALL", strike: "8050" }] }, "legs[0].strike must be a number"],
        [{ ...one, legs: [{ side: "long", option_type: "CALL", strike: 8050, entry: 1 }] },
          'legs[0] has an unexpected "entry": a leg takes only "side", "option_type", "strike", "qty"'],
        [{ ...one, threshold: "0.2" }, '"threshold" must be a number'],
        [{ ...one, direction: 1 }, '"direction" must be a string'],
        [{ ...one, threshold: undefined }, 'missing argument "threshold"'],
        [{ ...one, enabled: false }, 'unexpected argument "enabled": add_rule takes only "expiry", "legs", "field", "threshold", "direction", "compare", "name"'],
      ] as const) {
        const clean = JSON.parse(JSON.stringify(args));
        expect(await call("add_rule", clean), JSON.stringify(clean)).toMatchObject({ isError: true, text: words });
      }
      expect(asked).toEqual([]);
      expect(await rules()).toEqual([]);
      // none of them counted: the cap of one still has its one
      expect((await call("add_rule", PUT_SPREAD)).isError).toBe(false);
    });

    it("carries the route's refusal in its own words, and counts it: a refused probe still asked the Provider", async () => {
      writing({ mcpWritesPer10Min: 1 }, (codes) => Promise.resolve({ records: [], unknown: codes }));
      const refused = await call("add_rule", PUT_SPREAD);
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^POST \/monitors answered 422: /);
      expect(asked).toHaveLength(1);
      expect(h.sent).toEqual([]);
      const capped = await call("add_rule", PUT_SPREAD);
      expect(capped).toMatchObject({
        isError: true, text: "agent writes are capped at 1 in ten minutes: the next is allowed in 600s",
      });
      expect(asked).toHaveLength(1);
    });
  });

  describe("the cap", () => {
    it("refuses the eleventh write within ten minutes with the wait, and allows the next once the first is ten minutes old", async () => {
      writing();
      expect((await call("add_rule", PUT_SPREAD)).isError).toBe(false);
      for (let i = 1; i < 10; i++) {
        h.now = new Date(h.now.getTime() + 1000);
        const edited = await call("edit_rule", { id: "1218-7100", threshold: 3 + i });
        expect(edited.isError, edited.text).toBe(false);
      }
      const capped = await call("edit_rule", { id: "1218-7100", threshold: 20 });
      // the first was made 9s ago: 591s until it leaves the window
      expect(capped).toMatchObject({ isError: true, text: "agent writes are capped at 10 in ten minutes: the next is allowed in 591s" });
      expect((await rules())[0]!.threshold).toBe(12);
      h.now = new Date(h.now.getTime() + 591_000);
      expect((await call("edit_rule", { id: "1218-7100", threshold: 20 })).isError).toBe(false);
    });

    it("counts only the MCP's writes: the page's are not counted", async () => {
      writing({ mcpWritesPer10Min: 1 });
      for (let i = 0; i < 3; i++) await h.call("/monitors", json(RULE)).then((r) => r.text());
      expect((await call("add_rule", PUT_SPREAD)).isError).toBe(false);
    });
  });

  describe("edit_rule", () => {
    const COMBO = {
      name: "1218-6800", strike_date: EXPIRY, field: "mid_price", threshold: 4.51,
      legs: [{ sign: -1, option_type: "PUT", strike: 7100 }, { sign: 1, option_type: "PUT", strike: 7075 }],
    };
    const setUp = async (settings: Partial<Settings> = {}) => {
      writing(settings);
      const combo = await created(await h.call("/monitors", json(COMBO)));
      const delta = await created(await h.call("/monitors", json({ ...RULE, option_type: "PUT", strike: 7100 })));
      asked = [];
      return { combo, delta };
    };

    it("finds a rule by its combo name, changes its threshold through PATCH, and tells the owner before and after", async () => {
      const { combo } = await setUp();
      const answer = await call("edit_rule", { id: "1218-6800", threshold: 4.8 });
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.source).toBe(`PATCH /monitors/${combo}`);
      expect(answer.data).toEqual((await rules()).find((r) => r.id === combo));
      expect(answer.data.threshold).toBe(4.8);
      expect(h.sent).toEqual(["🤖 agent: 1218-6800 |value| ≥ 4.51 → ≥ 4.80"]);
      expect(asked).toEqual([]);
    });

    it("mutes a rule as the owner muting it by hand would, and unmutes it", async () => {
      const { delta } = await setUp();
      const muted = await call("edit_rule", { id: "20261218 P7100", enabled: false });
      expect(muted.data).toMatchObject({ id: delta, enabled: false, disabled_reason: "manual" });
      const unmuted = await call("edit_rule", { id: delta, enabled: true });
      expect(unmuted.data).toMatchObject({ id: delta, enabled: true, disabled_reason: null });
      expect(h.sent).toEqual(["🤖 agent muted 20261218 P7100 |Δ| ≥ 0.20", "🤖 agent unmuted 20261218 P7100 |Δ| ≥ 0.20"]);
    });

    it("refuses to unmute a rule the service switched off, with its reason, writing nothing and counting nothing", async () => {
      const { delta } = await setUp({ mcpWritesPer10Min: 1 });
      for (const reason of ["unknown-contract", "no-figure", "unreadable", "expired", "holding-closed"]) {
        h.db.prepare("update monitors set enabled = 0, disabled_reason = ? where id = ?").run(reason, delta);
        expect(await call("edit_rule", { id: delta, enabled: true, threshold: 0.3 }), reason).toMatchObject({
          isError: true,
          text: `the rule "${delta}" is off as "${reason}", not muted by hand: edit_rule unmutes only a rule muted by hand (disabled_reason "manual")`,
        });
      }
      expect((await rules()).find((r) => r.id === delta)).toMatchObject({ enabled: false, threshold: 0.2 });
      expect(h.sent).toEqual([]);
      // a quarantined rule may still be edited while it stays off, and nothing above was counted
      expect((await call("edit_rule", { id: delta, threshold: 0.3 })).isError).toBe(false);
    });

    it("refuses to mute a rule the service switched off, which would make it one muted by hand and so unmutable here", async () => {
      // review of #457: muting first rewrote its reason to "manual", and the unmute guard then let it on
      const { delta } = await setUp({ mcpWritesPer10Min: 1 });
      for (const reason of ["unknown-contract", "no-figure", "unreadable", "expired", "holding-closed"]) {
        h.db.prepare("update monitors set enabled = 0, disabled_reason = ? where id = ?").run(reason, delta);
        expect(await call("edit_rule", { id: delta, enabled: false }), reason).toMatchObject({
          isError: true,
          text: `the rule "${delta}" is already off as "${reason}", not muted by hand: edit_rule does not mute it again, `
            + 'which would make it a rule muted by hand (disabled_reason "manual")',
        });
        expect(await call("edit_rule", { id: delta, enabled: true }), reason).toMatchObject({ isError: true });
        expect((await rules()).find((r) => r.id === delta), reason).toMatchObject({ enabled: false, disabled_reason: reason });
      }
      expect(h.sent).toEqual([]);
      // an edit that leaves enabled alone keeps the service's reason, and the cap of one was never spent
      const moved = await call("edit_rule", { id: delta, threshold: 0.3 });
      expect(moved.isError, moved.text).toBe(false);
      expect(moved.data).toMatchObject({ enabled: false, disabled_reason: "holding-closed", threshold: 0.3 });
    });

    it("changes only a watch rule: a holding's rule is refused before any write, counting nothing (the owner, #456)", async () => {
      writing({ mcpWritesPer10Min: 1 });
      await created(await h.call("/positions", json(CONDOR)));
      const held = await created(await h.call("/monitors", json(RULE)));
      const [rule] = (await rules()).filter((r) => r.id === held);
      expect(rule!.positions).toEqual([{ id: expect.any(String), name: "1016_IC" }]);
      for (const change of [{ threshold: 0.3 }, { enabled: false }, { direction: "below" }]) {
        expect(await call("edit_rule", { id: held, ...change }), JSON.stringify(change)).toMatchObject({
          isError: true,
          text: `the rule "${held}" watches the holding 1016_IC: a holding's rules are changed on the page, `
            + "and edit_rule changes only a watch rule",
        });
      }
      expect((await rules()).find((r) => r.id === held)).toMatchObject({ threshold: 0.2, enabled: true });
      expect(h.sent).toEqual([]);
      // none of it counted: the cap of one still has its one, for a watch rule
      const watch = await created(await h.call("/monitors", json({ ...RULE, strike: 9000 })));
      expect((await call("edit_rule", { id: watch, threshold: 0.3 })).isError).toBe(false);
    });

    it("refuses a rule whose scope is set though no link is listed, as a holding's", async () => {
      const { delta } = await setUp();
      h.db.prepare("update monitors set scope = 'leg' where id = ?").run(delta);
      expect(await call("edit_rule", { id: delta, threshold: 0.3 })).toMatchObject({
        isError: true,
        text: `the rule "${delta}" watches a holding: a holding's rules are changed on the page, and edit_rule changes only a watch rule`,
      });
      expect(h.sent).toEqual([]);
    });

    it("lets a rule muted by hand be muted again, which changes nothing", async () => {
      const { delta } = await setUp();
      await call("edit_rule", { id: delta, enabled: false });
      const again = await call("edit_rule", { id: delta, enabled: false });
      expect(again.isError, again.text).toBe(false);
      expect(again.data).toMatchObject({ enabled: false, disabled_reason: "manual" });
    });

    it("lets a rule already on be sent enabled true, which changes nothing", async () => {
      await setUp();
      const answer = await call("edit_rule", { id: "1218-6800", enabled: true });
      expect(answer.isError, answer.text).toBe(false);
      expect(h.sent).toEqual(["🤖 agent: 1218-6800 |value| ≥ 4.51, unchanged"]);
    });

    it("refuses field, and an edit of nothing, before writing anything", async () => {
      await setUp({ mcpWritesPer10Min: 1 });
      expect(await call("edit_rule", { id: "1218-6800", field: "option_delta" })).toMatchObject({
        isError: true,
        text: 'unexpected argument "field": edit_rule takes only "id", "threshold", "direction", "compare", "name", "enabled"',
      });
      expect(await call("edit_rule", { id: "1218-6800" })).toMatchObject({
        isError: true, text: "edit_rule needs at least one change: threshold, direction, compare, name or enabled",
      });
      expect(await call("edit_rule", { id: "1218-6800", enabled: "no" })).toMatchObject({
        isError: true, text: '"enabled" must be true or false',
      });
      expect(h.sent).toEqual([]);
      expect((await call("edit_rule", { id: "1218-6800", threshold: 5 })).isError).toBe(false);
    });

    it("names the rules a name fits and what it tried when none, as monitor_history does, writing nothing", async () => {
      await setUp();
      await created(await h.call("/monitors", json({ ...RULE, option_type: "PUT", strike: 7100, field: "mid_price", threshold: 3 })));
      const several = await call("edit_rule", { id: "20261218 P7100", threshold: 1 });
      expect(several.isError).toBe(true);
      expect(several.text).toBe((await call("monitor_history", { id: "20261218 P7100" })).text);
      const none = await call("edit_rule", { id: "nope", threshold: 1 });
      expect(none.text).toBe((await call("monitor_history", { id: "nope" })).text);
      expect(h.sent).toEqual([]);
    });

    it("carries the route's refusal in its own words, and counts it", async () => {
      const { delta } = await setUp({ mcpWritesPer10Min: 1 });
      const refused = await call("edit_rule", { id: delta, name: "renamed" });
      expect(refused).toMatchObject({
        isError: true,
        text: `PATCH /monitors/${delta} answered 422: only combo monitors can be renamed; a single-leg code is derived from its contract`,
      });
      expect((await call("edit_rule", { id: delta, threshold: 0.3 })).text).toMatch(/^agent writes are capped at 1/);
    });
  });

  describe("the notice and the log", () => {
    it("logs one line for every write attempted, the door's refusals included, and none for a read", async () => {
      writing();
      const said = await logged(async () => {
        await call("add_rule", PUT_SPREAD);
        await call("add_rule", { ...PUT_SPREAD, name: undefined });
        await call("watchlist");
        await call("edit_rule", { id: "1218-7100", threshold: 4 });
      });
      const mcp = said.filter((line) => line.startsWith("mcp "));
      expect(mcp).toHaveLength(3);
      expect(mcp[0]).toMatch(/^mcp add_rule \{.*"name":"1218-7100".*\}: POST \/monitors answered 201: rule [0-9a-f]{32}, notice sent$/);
      expect(mcp[1]).toMatch(/^mcp add_rule \{.*\}: refused by the door: a rule on 2 legs is a combo/);
      expect(mcp[2]).toMatch(/^mcp edit_rule \{"id":"1218-7100","threshold":4\}: PATCH \/monitors\/[0-9a-f]{32} answered 200: rule [0-9a-f]{32}, notice sent$/);
    });

    it("logs a write refused while writes are off", async () => {
      start();
      const said = await logged(() => call("edit_rule", { id: "x", threshold: 1 }));
      expect(said).toEqual([`mcp edit_rule {"id":"x","threshold":1}: refused by the door: ${WRITES_OFF}`]);
    });

    it("lets a write stand with Telegram not configured, and logs that no notice was sent", async () => {
      writing({ telegramBotToken: "", telegramChatId: "" });
      const said = await logged(async () => {
        expect((await call("add_rule", PUT_SPREAD)).isError).toBe(false);
      });
      expect(await rules()).toHaveLength(1);
      expect(h.sent).toEqual([]);
      expect(said).toContain("telegram not configured; alarm suppressed: 🤖 agent added 1218-7100 |value| ≥ 3.00");
      expect(said.find((line) => line.startsWith("mcp add_rule"))).toMatch(/, no notice: Telegram is not configured$/);
    });

    it("lets a write stand when Telegram refuses the notice, and logs that it was not sent", async () => {
      asked = [];
      h = harness({
        settings: { mcpWrites: true, ...TELEGRAM },
        send: () => { throw new Error("telegram is down"); },
      });
      const said = await logged(async () => {
        expect((await call("add_rule", PUT_SPREAD)).isError).toBe(false);
      });
      expect(await rules()).toHaveLength(1);
      expect(said.some((line) => line.startsWith("telegram send failed:"))).toBe(true);
      expect(said.find((line) => line.startsWith("mcp add_rule"))).toMatch(/, its notice not sent$/);
    });
  });
  // --- the second tier: writes to the book (#458, ADR 0029) ------------------------------------
  describe("record_holding and correct_close, behind MCP_WRITES_POSITIONS (#458, ADR 0029)", () => {
    const BOOK_OFF = "writes to the book are off on this service: record_holding and correct_close need "
      + "MCP_WRITES_POSITIONS=1, beside MCP_WRITES=1, in its .env, which only its owner sets";
    /** today's New York market day on the harness's clock, 2026-10-02 */
    const TODAY = "20261002";
    const PUT_HOLDING = {
      name: "oct-puts", expiry: D, entry: 1.25, contracts: 2, opened_at: TODAY,
      legs: [{ side: "long", option_type: "PUT", strike: 7075 }, { side: "short", option_type: "PUT", strike: 7100 }],
    };
    const booking = (settings: Partial<Settings> = {}, fetchQuotes?: FakeProvider) =>
      writing({ mcpWritesPositions: true, ...settings }, fetchQuotes);
    const holdings = async () => (await body(await h.call("/positions"))) as Record<string, unknown>[];
    /** a holding recorded through the page and closed there, as the owner would have */
    const closedCondor = async () => {
      const id = await created(await h.call("/positions", json({ ...CONDOR, opened_at: "2026-09-28" })));
      const closed = await h.call(`/positions/${id}/close`, json({ exit: 0.4, closed_on: "2026-10-01" }));
      expect(closed.status, await closed.clone().text()).toBe(200);
      asked = [];
      return id;
    };

    describe("the switch", () => {
      it("with rule writes on and this one unset, lists the rule tools only and refuses either, asking nothing and counting nothing", async () => {
        writing({ mcpWritesPer10Min: 1 });
        await closedCondor();
        const { tools } = await result(await rpc("tools/list"));
        expect(tools.map((t: { name: string }) => t.name)).toEqual([...READS, "add_rule", "edit_rule"]);
        const before = await holdings();
        for (const [name, args] of [["record_holding", PUT_HOLDING], ["correct_close", { id: "1016_IC", exit: 0.35 }]] as const) {
          expect(await call(name, args), name).toMatchObject({ isError: true, text: BOOK_OFF });
        }
        expect(await call("correct_close", { nonsense: true })).toMatchObject({ isError: true, text: BOOK_OFF });
        expect(asked).toEqual([]);
        expect(await holdings()).toEqual(before);
        expect(h.sent).toEqual([]);
        // nothing counted: the cap of one still has its one
        expect((await call("add_rule", PUT_SPREAD)).isError).toBe(false);
      });

      it("on while MCP_WRITES is off, is off: no write is listed, the instructions say writes are off, and the log says why once", async () => {
        let said: string[] = [];
        said = await logged(async () => {
          asked = [];
          h = harness({ settings: { mcpWritesPositions: true, ...TELEGRAM } });
          const { tools } = await result(await rpc("tools/list"));
          expect(tools.map((t: { name: string }) => t.name)).toEqual(READS);
          const { instructions } = await result(await rpc("initialize", { protocolVersion: "2025-11-25" }));
          expect(instructions).toContain("WRITES ARE OFF on this service");
          expect(instructions).not.toContain("BOOK");
          expect(await call("record_holding", PUT_HOLDING)).toMatchObject({ isError: true, text: BOOK_OFF });
        });
        expect(said.filter((line) => line.includes("MCP_WRITES_POSITIONS is on but MCP_WRITES is off"))).toEqual([
          "MCP_WRITES_POSITIONS is on but MCP_WRITES is off: an agent's writes to the book stay off until MCP_WRITES is on too",
        ]);
        expect(await holdings()).toEqual([]);
        expect(h.sent).toEqual([]);
      });

      it("with both on, lists all four writes after the reads, annotated, and the instructions say the book's are on", async () => {
        const said = await logged(async () => { booking(); });
        expect(said.filter((line) => line.includes("MCP_WRITES_POSITIONS"))).toEqual([]);
        const { tools } = await result(await rpc("tools/list"));
        expect(tools.map((t: { name: string }) => t.name)).toEqual([...READS, "add_rule", "edit_rule", "record_holding", "correct_close"]);
        const annotations = Object.fromEntries(tools.map((t: { name: string; annotations: unknown }) => [t.name, t.annotations]));
        expect(annotations.record_holding).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        expect(annotations.correct_close).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
        const { instructions } = await result(await rpc("initialize", { protocolVersion: "2025-11-25" }));
        expect(instructions).toContain("WRITES ARE ON, for alarm rules");
        expect(instructions).toContain("Writes to the BOOK are ON, for two things only");
      });

      it("states the 5 days of record_holding's window in its description, as the door holds it", () => {
        expect(OPENED_WITHIN_DAYS).toBe(5);
        const tool = DESCRIBED.tools.find((t) => t.name === "record_holding")!;
        expect(tool.description).toContain(`at most ${OPENED_WITHIN_DAYS} calendar days before it`);
        expect(tool.inputSchema.properties.opened_at!.description).toContain(`at most ${OPENED_WITHIN_DAYS} calendar days before it`);
      });
    });

    describe("record_holding", () => {
      it("records a put spread through POST /positions as given, answers it as recorded, and tells the owner once", async () => {
        booking();
        const answer = await call("record_holding", { ...PUT_HOLDING, strategy: "put spread" });
        expect(answer.isError, answer.text).toBe(false);
        expect(answer.source).toBe("POST /positions");
        const [made] = await holdings();
        expect(answer.data).toEqual(made);
        expect(made).toMatchObject({
          name: "oct-puts", strike_date: EXPIRY, entry: 1.25, contracts: 2, opened_at: "2026-10-02", strategy: "put spread",
          closed_on: null, exit: null,
          legs: [{ side: "long", option_type: "PUT", strike: 7075 }, { side: "short", option_type: "PUT", strike: 7100 }],
        });
        // the route's own probe, of both legs, in one call
        expect(asked).toHaveLength(1);
        expect([...asked[0]!].sort()).toEqual(["US.SPXW261218P7075000", "US.SPXW261218P7100000"]);
        expect(h.sent).toEqual(["🤖 agent recorded oct-puts 20261218 −P7100 +P7075 ×2 @ 1.25, opened 20261002"]);
      });

      it("passes a leg's quantity, and leaves strategy to the route where it is not given", async () => {
        booking();
        const answer = await call("record_holding", {
          ...PUT_HOLDING, legs: [{ ...PUT_HOLDING.legs[0], qty: 2 }, PUT_HOLDING.legs[1]], entry: -0.5, contracts: 1,
        });
        expect(answer.isError, answer.text).toBe(false);
        expect(answer.data).toMatchObject({ strategy: null, legs: [{ side: "long", option_type: "PUT", strike: 7075, qty: 2 }, { strike: 7100 }] });
        expect(h.sent).toEqual(["🤖 agent recorded oct-puts 20261218 −P7100 +2P7075 ×1 @ −0.50, opened 20261002"]);
      });

      it("names the watch rule the new holding took over, which edit_rule then refuses as the holding's", async () => {
        booking();
        const rule = await created(await h.call("/monitors", json({
          name: "1218-7100", strike_date: EXPIRY, field: "mid_price", threshold: 4.51,
          legs: [{ sign: -1, option_type: "PUT", strike: 7100 }, { sign: 1, option_type: "PUT", strike: 7075 }],
        })));
        // a rule on another contract stays a watch rule, and is not named
        await created(await h.call("/monitors", json({ ...RULE, strike: 9000 })));
        asked = [];
        const answer = await call("record_holding", PUT_HOLDING);
        expect(answer.isError, answer.text).toBe(false);
        expect((await rules()).find((r) => r.id === rule)!.positions).toEqual([{ id: answer.data.id, name: "oct-puts" }]);
        expect(h.sent).toEqual([
          "🤖 agent recorded oct-puts 20261218 −P7100 +P7075 ×2 @ 1.25, opened 20261002, taking over 1218-7100 |value| ≥ 4.51",
        ]);
        expect(await call("edit_rule", { id: rule, threshold: 5 })).toMatchObject({ isError: true });
      });

      it("refuses a missing or empty entry, contracts or opened_at, and a wrong shape, asking nothing and counting nothing", async () => {
        booking({ mcpWritesPer10Min: 1 });
        for (const [args, words] of [
          [{ ...PUT_HOLDING, entry: undefined }, 'missing argument "entry"'],
          [{ ...PUT_HOLDING, contracts: undefined }, 'missing argument "contracts"'],
          [{ ...PUT_HOLDING, opened_at: undefined }, 'missing argument "opened_at"'],
          [{ ...PUT_HOLDING, entry: null }, '"entry" must be a number'],
          [{ ...PUT_HOLDING, contracts: null }, '"contracts" must be a number'],
          [{ ...PUT_HOLDING, opened_at: null }, 'argument "opened_at" must be a string matching ^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$'],
          [{ ...PUT_HOLDING, name: 7 }, '"name" must be a string'],
          [{ ...PUT_HOLDING, strategy: 7 }, '"strategy" must be a string'],
          [{ ...PUT_HOLDING, legs: [] }, '"legs" must hold one leg or more'],
          [{ ...PUT_HOLDING, legs: [{ side: "sold", option_type: "PUT", strike: 7100 }] }, 'legs[0].side must be "short" or "long"'],
          [{ ...PUT_HOLDING, legs: [{ side: "short", option_type: "PUT", strike: 7100, qty: "2" }] }, "legs[0].qty must be a number"],
          [{ ...PUT_HOLDING, opened_at: "20261340" }, "opened_at 20261340 is not a day: use YYYY-MM-DD or YYYYMMDD"],
          [{ ...PUT_HOLDING, exit: 1 }, 'unexpected argument "exit": record_holding takes only "name", "expiry", "legs", "entry", "contracts", "opened_at", "strategy"'],
        ] as const) {
          const clean = JSON.parse(JSON.stringify(args));
          expect(await call("record_holding", clean), JSON.stringify(clean)).toMatchObject({ isError: true, text: words });
        }
        expect(asked).toEqual([]);
        expect(await holdings()).toEqual([]);
        expect((await call("record_holding", PUT_HOLDING)).isError).toBe(false);
      });

      it("takes an opened_at from today's New York market day back 5 days, and refuses tomorrow and 6 days back, uncounted", async () => {
        booking({ mcpWritesPer10Min: 1 });
        expect(await call("record_holding", { ...PUT_HOLDING, opened_at: "2026-10-03" })).toMatchObject({
          isError: true,
          text: "opened_at 2026-10-03 is after today's New York market day, 2026-10-02: a holding is recorded here once it is opened",
        });
        expect(await call("record_holding", { ...PUT_HOLDING, opened_at: "20260926" })).toMatchObject({
          isError: true,
          text: "opened_at 2026-09-26 is more than 5 days before today's New York market day, 2026-10-02: "
            + "a holding opened earlier is recorded on the page",
        });
        expect(asked).toEqual([]);
        const answer = await call("record_holding", { ...PUT_HOLDING, opened_at: "20260927" });
        expect(answer.isError, answer.text).toBe(false);
        expect(answer.data.opened_at).toBe("2026-09-27");
      });

      it("reads the market day from the injected clock in New York, not UTC's: at 22:00 there, UTC's tomorrow is refused", async () => {
        booking();
        h.now = new Date("2026-10-03T02:00:00Z");
        expect(await call("record_holding", { ...PUT_HOLDING, opened_at: "20261003" })).toMatchObject({
          isError: true,
          text: "opened_at 2026-10-03 is after today's New York market day, 2026-10-02: a holding is recorded here once it is opened",
        });
        expect((await call("record_holding", { ...PUT_HOLDING, opened_at: "20261002" })).isError).toBe(false);
        // and five days back from New York's day, not from UTC's
        expect((await call("record_holding", { ...PUT_HOLDING, name: "b", opened_at: "20260927" })).isError).toBe(false);
      });

      it("carries the route's 409 on a name already recorded in its words, and counts it", async () => {
        booking({ mcpWritesPer10Min: 2 });
        expect((await call("record_holding", PUT_HOLDING)).isError).toBe(false);
        const refused = await call("record_holding", PUT_HOLDING);
        expect(refused).toMatchObject({ isError: true, text: "POST /positions answered 409: position 'oct-puts' already exists" });
        expect(await call("record_holding", { ...PUT_HOLDING, name: "other" })).toMatchObject({
          isError: true, text: "agent writes are capped at 2 in ten minutes: the next is allowed in 600s",
        });
        expect(h.sent).toHaveLength(1);
      });
    });

    describe("correct_close", () => {
      it("corrects a closed holding's exit by its name, and tells the owner only what changed", async () => {
        booking();
        const id = await closedCondor();
        const answer = await call("correct_close", { id: "1016_IC", exit: 0.35 });
        expect(answer.isError, answer.text).toBe(false);
        expect(answer.source).toBe(`PATCH /positions/${id}`);
        expect(answer.data).toMatchObject({ id, exit: 0.35, closed_on: "2026-10-01", entry: 3 });
        expect((await holdings())[0]).toMatchObject({ exit: 0.35, closed_on: "2026-10-01" });
        expect(h.sent).toEqual(["🤖 agent corrected the close of 1016_IC: exit 0.40 → 0.35"]);
        expect(asked).toEqual([]);
      });

      it("corrects both, by id, saying both", async () => {
        booking();
        const id = await closedCondor();
        const answer = await call("correct_close", { id, exit: 0.35, closed_on: "20261002" });
        expect(answer.isError, answer.text).toBe(false);
        expect(h.sent).toEqual(["🤖 agent corrected the close of 1016_IC: exit 0.40 → 0.35, closed 20261001 → 20261002"]);
      });

      it("on an OPEN holding is the route's refusal, which closes nothing, and counts", async () => {
        booking({ mcpWritesPer10Min: 1 });
        await created(await h.call("/positions", json(CONDOR)));
        expect(await call("correct_close", { id: "1016_IC", exit: 0.35 })).toMatchObject({
          isError: true, text: expect.stringMatching(/^PATCH \/positions\/[0-9a-f]{32} answered 422: position '1016_IC' is not closed: close it first$/),
        });
        expect((await holdings())[0]).toMatchObject({ closed_on: null, exit: null });
        expect(h.sent).toEqual([]);
        expect(await call("add_rule", PUT_SPREAD)).toMatchObject({ isError: true, text: expect.stringMatching(/^agent writes are capped at 1/) });
      });

      it("refuses any other field, no change, an unknown holding and a wrong type before writing, counting nothing", async () => {
        booking({ mcpWritesPer10Min: 1 });
        const id = await closedCondor();
        for (const [args, words] of [
          [{ id, entry: 2 }, 'unexpected argument "entry": correct_close takes only "id", "exit", "closed_on"'],
          [{ id, exit: 0.35, contracts: 2 }, 'unexpected argument "contracts": correct_close takes only "id", "exit", "closed_on"'],
          [{ id, legs: [] }, 'unexpected argument "legs": correct_close takes only "id", "exit", "closed_on"'],
          [{ id }, "correct_close needs at least one change: exit or closed_on"],
          [{ id, exit: null }, "correct_close needs at least one change: exit or closed_on"],
          [{ id, exit: 0.4 }, `the close of 1016_IC already says exit 0.4: correct_close needs a change`],
          [{ id, exit: 0.4, closed_on: "2026-10-01" }, `the close of 1016_IC already says exit 0.4 and closed_on 2026-10-01: correct_close needs a change`],
          [{ id, exit: "0.35" }, '"exit" must be a number'],
          [{ id, closed_on: "2026-13-01" }, "closed_on 2026-13-01 is not a day: use YYYY-MM-DD or YYYYMMDD"],
          [{ id: "nobody", exit: 0.35 }, 'no holding is "nobody": tried it as a holding\'s id and as its name. positions lists every holding\'s id'],
        ] as const) {
          expect(await call("correct_close", args), JSON.stringify(args)).toMatchObject({ isError: true, text: words });
        }
        expect((await holdings())[0]).toMatchObject({ exit: 0.4, closed_on: "2026-10-01", entry: 3, contracts: 1 });
        expect(h.sent).toEqual([]);
        expect((await call("correct_close", { id, closed_on: "2026-10-01", exit: 0.3 })).isError).toBe(false);
      });

      it("writes the route a body of exit and closed_on alone, to the resolved id's path", async () => {
        const writes: { method: string; path: string; body: unknown }[] = [];
        const row = {
          id: "pos-1", name: "1016_IC", strike_date: EXPIRY, entry: 3, contracts: 1, opened_at: "2026-09-28",
          legs: CONDOR.legs, exit: 0.4, closed_on: "2026-10-01",
        };
        const serve = mcpServer({
          read: async () => ({ status: 200, body: JSON.stringify([row]) }),
          write: async (method, path, payload) => {
            writes.push({ method, path, body: payload });
            return { status: 200, body: JSON.stringify({ ...row, ...(payload as object) }) };
          },
          notify: async () => "sent", now: () => new Date("2026-10-02T05:26:06Z"), displayTz: "UTC",
          writes: true, writesPositions: true, writesPer10Min: 10,
        });
        const ask = (args: unknown) => serve(new Request("http://x/mcp", {
          method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "correct_close", arguments: args } }),
        }));
        await ask({ id: "1016_IC", exit: 0.35 });
        await ask({ id: "1016_IC", closed_on: "20261002" });
        await ask({ id: "1016_IC", exit: 0.35, closed_on: "2026-10-02" });
        expect(writes).toEqual([
          { method: "PATCH", path: "/positions/pos-1", body: { exit: 0.35 } },
          { method: "PATCH", path: "/positions/pos-1", body: { closed_on: "20261002" } },
          { method: "PATCH", path: "/positions/pos-1", body: { exit: 0.35, closed_on: "2026-10-02" } },
        ]);
      });
    });

    describe("a number too large for a double (review of #459)", () => {
      it("is no number: a tool error in the door's words, as the Python says it, writing nothing", async () => {
        booking();
        const HUGE = "1".repeat(400);
        // written by hand, as JSON.stringify cannot write the digits an agent may send
        const raw = async (name: string, args: string) => {
          const text = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${name}","arguments":${args}}}`;
          const r = await result(await h.call("/mcp", { method: "POST", body: text, headers: { "Content-Type": "application/json" } }));
          return { isError: r.isError === true, text: r.content[0].text as string };
        };
        const holding = (key: string) => JSON.stringify({ ...PUT_HOLDING, [key]: 0 }).replace(`"${key}":0`, `"${key}":${HUGE}`);
        for (const [name, args, words] of [
          ["record_holding", holding("entry"), '"entry" must be a number'],
          ["record_holding", holding("contracts"), '"contracts" must be a number'],
          ["record_holding", JSON.stringify({ ...PUT_HOLDING, legs: [] }).replace('"legs":[]', `"legs":[{"side":"short","option_type":"PUT","strike":${HUGE}}]`),
            "legs[0].strike must be a number"],
          ["record_holding", JSON.stringify({ ...PUT_HOLDING, legs: [] }).replace('"legs":[]', `"legs":[{"side":"short","option_type":"PUT","strike":7100,"qty":${HUGE}}]`),
            "legs[0].qty must be a number"],
          ["add_rule", JSON.stringify(PUT_SPREAD).replace('"threshold":3', `"threshold":${HUGE}`), '"threshold" must be a number'],
          ["correct_close", `{"id":"x","exit":${HUGE}}`, '"exit" must be a number'],
        ] as const) {
          expect(await raw(name, args), `${name} ${words}`).toEqual({ isError: true, text: words });
        }
        expect(await holdings()).toEqual([]);
        expect(asked).toEqual([]);
        // and its log line writes the number as JSON.stringify writes Infinity, as the Python does
        const said = await logged(() => raw("correct_close", `{"id":"x","exit":${HUGE}}`));
        expect(said).toEqual(['mcp correct_close {"exit":null,"id":"x"}: refused by the door: "exit" must be a number']);
      });
    });

    describe("the read after a record (review of #459)", () => {
      const recordWith = async (monitors: () => Promise<{ status: number; body: string }>) => {
        const sent: string[] = [];
        const serve = mcpServer({
          read: (path) => (path === "/monitors" ? monitors() : Promise.resolve({ status: 200, body: "[]" })),
          write: async (_method, _path, payload) =>
            ({ status: 201, body: JSON.stringify({ id: "pos-9", ...(payload as object), strike_date: EXPIRY, exit: null, closed_on: null }) }),
          notify: async (text) => { sent.push(text); return "sent"; },
          now: () => new Date("2026-10-02T05:26:06Z"), displayTz: "UTC",
          writes: true, writesPositions: true, writesPer10Min: 10,
        });
        let answer: { result: { isError?: boolean; content: { text: string }[] } } | undefined;
        const said = await logged(async () => {
          const resp = await serve(new Request("http://x/mcp", {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_holding", arguments: PUT_HOLDING } }),
          }));
          answer = (await resp.json()) as typeof answer;
        });
        return { answer: answer!, sent, line: said.find((l) => l.startsWith("mcp record_holding"))! };
      };

      it("names no rule where GET /monitors throws, answers non-JSON or no list, and the write stands, said in the log", async () => {
        for (const [monitors, why] of [
          [() => Promise.reject(new Error("socket hang up")), "GET /monitors failed: socket hang up"],
          [() => Promise.resolve({ status: 200, body: "<html>" }), "GET /monitors answered 200 with no list of rules"],
          [() => Promise.resolve({ status: 200, body: "{\"a\":1}" }), "GET /monitors answered 200 with no list of rules"],
          [() => Promise.resolve({ status: 200, body: "[null, 5]" }), null],
          [() => Promise.resolve({ status: 500, body: "{}" }), "GET /monitors answered 500"],
        ] as const) {
          const { answer, sent, line } = await recordWith(monitors);
          expect(answer.result.isError, `${why}: ${answer.result.content[0]!.text}`).toBeUndefined();
          expect(JSON.parse(answer.result.content[0]!.text).source).toBe("POST /positions");
          expect(sent).toEqual(["🤖 agent recorded oct-puts 20261218 −P7100 +P7075 ×2 @ 1.25, opened 20261002"]);
          expect(line).toBe(`mcp record_holding ${canonical(PUT_HOLDING)}: POST /positions answered 201: holding pos-9, notice sent${why === null ? "" : `; its rules not named: ${why}`}`);
        }
      });
    });

    describe("the cap, shared", () => {
      it("counts rule and book writes together: 6 add_rule and 4 record_holding, then the 11th of either is refused with the wait", async () => {
        booking();
        for (let i = 0; i < 6; i++) {
          const added = await call("add_rule", { ...PUT_SPREAD, name: `r-${i}` });
          expect(added.isError, added.text).toBe(false);
          h.now = new Date(h.now.getTime() + 1000);
        }
        for (let i = 0; i < 4; i++) {
          const recorded = await call("record_holding", { ...PUT_HOLDING, name: `h-${i}` });
          expect(recorded.isError, recorded.text).toBe(false);
          h.now = new Date(h.now.getTime() + 1000);
        }
        const capped = "agent writes are capped at 10 in ten minutes: the next is allowed in 590s";
        expect(await call("record_holding", { ...PUT_HOLDING, name: "h-4" })).toMatchObject({ isError: true, text: capped });
        expect(await call("add_rule", { ...PUT_SPREAD, name: "r-6" })).toMatchObject({ isError: true, text: capped });
        expect(await holdings()).toHaveLength(4);
      });
    });

    describe("the log", () => {
      it("logs one line for every write to the book attempted, refusals included", async () => {
        booking();
        const said = await logged(async () => {
          await call("record_holding", PUT_HOLDING);
          await call("record_holding", { ...PUT_HOLDING, opened_at: "20261003" });
          await call("correct_close", { id: "oct-puts", exit: 0.1 });
        });
        const mcp = said.filter((line) => line.startsWith("mcp "));
        expect(mcp).toHaveLength(3);
        expect(mcp[0]).toMatch(/^mcp record_holding \{.*"name":"oct-puts".*\}: POST \/positions answered 201: holding [0-9a-f]{32}, notice sent$/);
        expect(mcp[1]).toMatch(/^mcp record_holding \{.*\}: refused by the door: opened_at 2026-10-03 is after today's/);
        expect(mcp[2]).toMatch(/^mcp correct_close \{"exit":0.1,"id":"oct-puts"\}: PATCH \/positions\/[0-9a-f]{32} answered 422: position 'oct-puts' is not closed/);
      });
    });
  });

});

describe("the door's reach", () => {
  it("imports nothing of the service: no route, no query, no engine, no write", () => {
    // It is handed a GET of the API's own, a write it holds to four routes and a notifier, and that
    // is all it may use (ADR 0026, 0028). Read from the source, so a write path added later fails
    // here rather than in a review.
    const dir = new URL(".", import.meta.url).pathname;
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.sort()).toEqual(["index.ts", "server.ts", "tools.ts", "writes.ts"]);
    const reached = sources.flatMap((f) => [...readFileSync(join(dir, f), "utf8")
      .matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!));
    const outside = reached.filter((spec) => !spec.startsWith("./"));
    // `ports.ts` for the types it is handed, `Read`, `Write` and `Notify`, and nothing that runs; and the library's
    // pure domain for the words — a contract as the page writes it is read by `/unwatch`'s own
    // parser, and a rule is said in its short form; New York's market day bounds a holding's open
    // day (ADR 0029) — which reach nothing of the service either
    expect([...new Set(outside)].sort()).toEqual([
      "../../ports.ts", "node:fs", "optionality/domain/alarm", "optionality/domain/contract",
      "optionality/domain/expiry", "optionality/domain/timefmt",
    ]);
  });
});
