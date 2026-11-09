import { createServer } from "node:net";

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { type HeldPort, takePort } from "./listen.ts";

const opened: { close: () => void }[] = [];
afterEach(() => { while (opened.length) opened.pop()!.close(); });

async function held(port = 0): Promise<HeldPort> {
  const h = await takePort(port);
  opened.push(h.server);
  return h;
}

/** Another process's listener, as far as this one can tell: a bare socket on the port. */
function occupy(): Promise<number> {
  return new Promise((resolve) => {
    const other = createServer();
    opened.push(other);
    other.listen(0, "127.0.0.1", () => {
      const address = other.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("takePort", () => {
  it("answers 503 in the dashboard's error shape until the app is attached", async () => {
    const { port } = await held();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: "the service is starting" });
  });

  it("serves the app once it is attached, on the same port", async () => {
    const h = await held();
    const app = new Hono().get("/health", (c) => c.json({ ok: true }));
    h.serve(app.fetch);
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses a port another process holds, and names it", async () => {
    const port = await occupy();
    const taking = takePort(port);
    await expect(taking).rejects.toThrow(new RegExp(`port ${port} on 127\\.0\\.0\\.1 is taken`));
    await expect(taking).rejects.toHaveProperty("cause.code", "EADDRINUSE");
  });

  it("is the lock between two backends: the second taker is refused", async () => {
    const { port } = await held();
    await expect(takePort(port)).rejects.toThrow(/is taken/);
  });
});
