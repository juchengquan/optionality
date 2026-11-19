/** The MCP door (ADR 0026, #447), through the app as `main.ts` mounts it: the protocol, the tools,
 *  the cache in front of the live ones, and the two promises it is built on — a tool's data is
 *  exactly what its GET serves, and nothing here can write. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type FakeProvider, type Harness, body, harness, json, pricedFetcher } from "../../../testing/harness.ts";
import { LIVE_FOR_MS, toolbox } from "./tools.ts";

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
    expect(r.instructions).toMatch(/read-only/i);
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
    // paths that ARE reads, so no tool can be a GET of something that is not there
    start();
    const spec = await body(await h.call("/openapi.json"));
    const { DESCRIBED } = await import("./tools.ts");
    for (const tool of DESCRIBED.tools) {
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
      expect(answer.data, name).toEqual(await body(direct));
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
    expect(answer.data).toEqual(await body(await h.call(path)));
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

describe("the door's reach", () => {
  it("imports nothing of the service: no route, no query, no engine, no write", () => {
    // It is handed a GET of the API's own and that is all it may use (ADR 0026). Read from the
    // source, so a write path added later fails here rather than in a review.
    const dir = new URL(".", import.meta.url).pathname;
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.sort()).toEqual(["index.ts", "server.ts", "tools.ts"]);
    const reached = sources.flatMap((f) => [...readFileSync(join(dir, f), "utf8")
      .matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!));
    const outside = reached.filter((spec) => !spec.startsWith("./"));
    // `ports.ts` for the one type it is handed, `Read`, and nothing that runs; and the library's
    // pure domain for the words — a contract as the page writes it is read by `/unwatch`'s own
    // parser, and a rule is said in its short form — which reach nothing of the service either
    expect([...new Set(outside)].sort()).toEqual([
      "../../ports.ts", "node:fs", "optionality/domain/alarm", "optionality/domain/contract",
      "optionality/domain/timefmt",
    ]);
  });
});
