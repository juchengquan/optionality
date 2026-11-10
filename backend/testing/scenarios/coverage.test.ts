/** A scenario for everything each door can do — held to the service, not to a list kept here.
 *
 *  The HTTP door is held to its own `/openapi.json` (built from the routes, and `openapi.test.ts`
 *  holds it to them), the bot to the "/" menu it publishes to Telegram on start, and the sweep to
 *  `outcomes.ts`, whose own completeness is held to what the engine imports. So a seventeenth
 *  endpoint, a fifteenth command or a new kind of quarantine fails here until a scenario shows it —
 *  which is the whole point of a door scenario a second backend will have to meet (ADR 0021): an
 *  event nobody wrote down is an event the Python can get wrong in silence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readScenario, scenarioFiles } from "./corpus.ts";
import { announcedCommands, runHttp } from "./doors.ts";
import type { BotScenario, HttpScenario, SweepScenario } from "./format.ts";
import { request, world } from "./inputs/fixtures.ts";
import { NOT_A_DECISION, OUTCOMES } from "./outcomes.ts";

const all = <T>(door: "http" | "bot" | "sweep") =>
  scenarioFiles(door).map((file) => ({ file, scenario: readScenario<T>(door, file) }));

/** The documented path a concrete request path is aimed at: `/monitors/abc` is
 *  `/monitors/{id}`. A literal segment outranks a parameter, so `/positions/values` is never read
 *  as a position called "values". */
function endpointOf(path: string, templates: string[]): string | undefined {
  const bare = path.split("?")[0]!;
  const matching = templates.filter((t) => new RegExp(
    `^${t.replace(/\{[^}]+\}/g, "[^/]+")}$`,
  ).test(bare));
  return matching.sort((a, b) => (a.match(/\{/g) ?? []).length - (b.match(/\{/g) ?? []).length)[0];
}

/** The two routes the description does not list, because they ARE the description (`mountDocs`:
 *  for people, not for `hc`). Their scenarios hold the Python to the TypeScript's words; the last
 *  test below holds each to one, so naming a route here is no way round the guard. */
const DESCRIPTION = ["GET /openapi.json", "GET /docs"];

/** The command a message names, the way the bot reads it: `/Watch@thebot` is `watch`. */
function commandOf(text: string): string | undefined {
  const first = text.trim().split(/\s+/)[0] ?? "";
  return first.startsWith("/") ? first.split("@")[0]!.slice(1).toLowerCase() : undefined;
}

describe("the HTTP door's coverage", () => {
  const documented = async () => {
    const answer = await runHttp({ world: world(), request: request("GET", "/openapi.json") });
    const spec = answer.response.body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    return Object.entries(spec.paths).flatMap(([path, ops]) => Object.entries(ops).flatMap(
      ([method, op]) => Object.keys(op.responses).map((status) => ({
        method: method.toUpperCase(), path, status: Number(status),
      })),
    ));
  };

  it("has a scenario for every status every documented endpoint can answer", async () => {
    const answers = await documented();
    const templates = [...new Set(answers.map((a) => a.path))];
    const scenarios = all<HttpScenario>("http").map((s) => s.scenario);
    const missing = answers.filter(({ method, path, status }) => !scenarios.some((s) =>
      s.request.method === method && endpointOf(s.request.path, templates) === path
      && s.expect.response.status === status,
    )).map(({ method, path, status }) => `${method} ${path} → ${status}`);

    expect(missing, "write a scenario for each in backend/testing/scenarios/inputs/http.ts")
      .toEqual([]);
    // and there IS something to compare: sixteen endpoints, every one with at least a success
    const endpoints = new Set(answers.map(({ method, path }) => `${method} ${path}`));
    expect(endpoints.size, "the service documents no endpoints").toBeGreaterThanOrEqual(16);
  });

  it("aims every scenario at an endpoint the service documents", async () => {
    const answers = await documented();
    const templates = [...new Set(answers.map((a) => a.path))];
    const astray = all<HttpScenario>("http")
      .filter(({ scenario: { request: r } }) => !DESCRIPTION.includes(`${r.method} ${r.path}`))
      .filter(({ scenario }) => {
        const path = endpointOf(scenario.request.path, templates);
        return path === undefined
          || !answers.some((a) => a.path === path && a.method === scenario.request.method);
      })
      .map(({ file }) => file);
    expect(astray, "these requests reach no documented endpoint").toEqual([]);
  });

  it("has a scenario for each of the description's own routes, which it does not list", async () => {
    const listed = new Set((await documented()).map(({ method, path }) => `${method} ${path}`));
    const scenarios = all<HttpScenario>("http").map((s) => s.scenario);
    for (const route of DESCRIPTION) {
      expect(listed.has(route), `${route} is listed after all: take it out of DESCRIPTION`)
        .toBe(false);
      expect(scenarios.some((s) => `${s.request.method} ${s.request.path}` === route
        && s.expect.response.status === 200), `no scenario answers ${route}`).toBe(true);
    }
  });

  it("reads a concrete path as the endpoint it is", () => {
    // the one place the guard could pass by being wrong: a path matched to nothing would report
    // every parameterised endpoint missing, and a match too loose would cover anything
    const templates = ["/positions", "/positions/values", "/positions/{id}", "/positions/{id}/vol"];
    expect(endpointOf("/positions/values", templates)).toBe("/positions/values");
    expect(endpointOf("/positions/pos-1", templates)).toBe("/positions/{id}");
    expect(endpointOf("/positions/pos-1/vol", templates)).toBe("/positions/{id}/vol");
    expect(endpointOf("/positions/pos-1/other", templates)).toBeUndefined();
  });
});

describe("the bot door's coverage", () => {
  it("has a scenario for every command the bot announces", async () => {
    const announced = await announcedCommands(world());
    const typed = new Set(all<BotScenario>("bot")
      .map(({ scenario }) => commandOf(scenario.update.message.text)));
    const missing = announced.filter((c) => !typed.has(c));
    expect(missing, "write a scenario for each in backend/testing/scenarios/inputs/bot.ts")
      .toEqual([]);
    expect(announced.length, "the bot announces no commands").toBeGreaterThanOrEqual(14);
  });

  it("reads a command the way the bot does", () => {
    expect(commandOf("/Watch@optionality_bot 2026-12-18 CALL 7300 0.3")).toBe("watch");
    expect(commandOf("  /health")).toBe("health");
    expect(commandOf("hello")).toBeUndefined();
  });
});

const ENGINE = new URL("../../src/engine/", import.meta.url).pathname;

/** The engine's own source, as text: every non-test module behind its door. */
function engineSources(): Record<string, string> {
  return Object.fromEntries(readdirSync(ENGINE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .map((f) => [f, readFileSync(join(ENGINE, f), "utf8")]));
}

/** What the engine decides with: every value it imports from `domain/`, and every function
 *  `positions.ts` exports for a sweep's batch. Read from the source rather than listed, so a new
 *  decision arrives here whether or not anybody remembers this file. */
function engineDecisions(sources: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const text of Object.values(sources)) {
    for (const [, head, names, spec] of text.matchAll(
      /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
    )) {
      if (head || !/(^|\/)domain\//.test(spec!)) continue;
      for (const name of names!.split(",").map((n) => n.trim()).filter(Boolean)) {
        if (name.startsWith("type ")) continue;
        found.add(name.split(/\s+as\s+/)[0]!);
      }
    }
  }
  const exported = /export\s+(?:async\s+)?function\s+(\w+)/g;
  for (const [, name] of (sources["positions.ts"] ?? "").matchAll(exported)) found.add(name!);
  return [...found].sort();
}

describe("the sweep door's coverage", () => {
  const scenarios = all<SweepScenario>("sweep");

  it("has a scenario showing every outcome on the list", () => {
    const claimed = new Set(scenarios.flatMap(({ scenario }) => scenario.outcomes));
    const missing = OUTCOMES.map((o) => o.name).filter((name) => !claimed.has(name));
    expect(missing, "write a scenario for each in backend/testing/scenarios/inputs/sweep.ts")
      .toEqual([]);
  });

  it("holds every claim to what the scenario actually shows", () => {
    const false_ = scenarios.flatMap(({ file, scenario }) => {
      if (scenario.outcomes.length === 0) return [`${file}: claims no outcome`];
      return scenario.outcomes.flatMap((name) => {
        const outcome = OUTCOMES.find((o) => o.name === name);
        if (!outcome) return [`${file}: "${name}" is not an outcome on the list`];
        return outcome.shows(scenario) ? [] : [`${file}: does not show "${name}"`];
      });
    });
    expect(false_).toEqual([]);
  });

  it("names every decision the engine takes in some outcome, or says why it is none", () => {
    const decisions = engineDecisions(engineSources());
    // a scan that matched nothing would find nothing missing, which is the way this could lie
    expect(decisions.length, "the import scan found no decisions — has domain/ moved?")
      .toBeGreaterThanOrEqual(10);
    const named = new Set([
      ...OUTCOMES.map((o) => o.decision), ...Object.keys(NOT_A_DECISION),
    ]);
    expect(decisions.filter((d) => !named.has(d)),
      "a decision no outcome names: add an outcome (and a scenario), or a line to NOT_A_DECISION")
      .toEqual([]);
    // and the lists name nothing the engine no longer uses, or they stop describing it
    const stale = [...named].filter((n) => n !== null && !decisions.includes(n));
    expect(stale, "named in outcomes.ts but no longer imported by the engine").toEqual([]);
  });

  it("shows every disabled_reason the engine writes", () => {
    const written = new Set(Object.values(engineSources()).flatMap((text) =>
      [...text.matchAll(/DisabledReason\s*=\s*"([^"]+)"/g)].map((m) => m[1]!)));
    expect(written.size, "the scan found no disabled_reason written — has the engine changed?")
      .toBeGreaterThanOrEqual(4);
    const shown = new Set(scenarios.flatMap(({ scenario }) =>
      (scenario.expect.rows.monitors?.changed ?? []).map((c) => c.to.disabled_reason)));
    expect([...written].filter((r) => !shown.has(r))).toEqual([]);
  });
});
