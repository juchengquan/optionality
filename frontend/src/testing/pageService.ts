/** The whole page's service for the suites carried over from the old page (#337, #301): the
 *  owner's book behind every route (`serveEditing`, which writes), with what those suites need to
 *  see and to steer on top of it —
 *
 *  - every read the page made, in order, so a test can count polls (`count`);
 *  - the References as a list the test changes, kept and dropped as the real routes do;
 *  - a read refused as a Provider outage refuses it (`refuse`), or held until the test lets it
 *    answer (`hold`);
 *  - a read's answer changed on its way back (`alter`), as another tab's write would change it.
 *
 *  Any write it does not serve falls through to `serveEditing`, which says which call it was.
 */
import type { Reference } from "../shared/api";
import { serveEditing, type Write } from "./editBook";

export interface PageService {
  /** every GET, by path, in the order the page asked */
  gets: string[];
  /** how many times the page has asked for this path */
  count: (path: string) => number;
  /** the References' writes, as `METHOD path` and the body sent */
  writes: Write[];
  /** the Monitors' writes, as `serveEditing` keeps them */
  edits: Write[];
  /** what `/references` answers now */
  references: Reference[];
  /** GET paths answered with a 502 in the error shape */
  refuse: Set<string>;
  /** holds every later GET of `path` until the returned function is called */
  hold: (path: string) => () => void;
  /** GET paths whose answer is passed through a function first */
  alter: Map<string, (body: unknown) => unknown>;
}

export const SPX_REFERENCE: Reference = {
  id: "r1", code: "US.SPY", label: "SPX", source: "moomoo", name: "SPDR S&P 500 ETF Trust",
  figure: 7587.3, field: "mid_price", change: 0.003982956650611325, error: null,
  delayed: null, last_known: null, delayed_by_minutes: null, fetched_at: "2026-11-10 21:04:11+08:00",
};

/** when this service says a Reference was kept */
const KEPT_AT = "2026-11-10 15:00:00.000000";

export function servePage(references: Reference[] = []): PageService {
  const edits = serveEditing();
  const inner = window.fetch;
  const gates = new Map<string, Promise<void>>();
  const svc: PageService = {
    gets: [], writes: [], edits, references: [...references], refuse: new Set(), alter: new Map(),
    count: (path) => svc.gets.filter((p) => p === path).length,
    hold: (path) => {
      let release!: () => void;
      gates.set(path, new Promise<void>((r) => { release = r; }));
      return () => { gates.delete(path); release(); };
    },
  };
  const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

  window.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    if (method === "POST" && path === "/references") {
      svc.writes.push({ what: `POST ${path}`, body });
      // as the route answers it (`routes/references.ts`): the stored row, made from the body and
      // what the service assigns — never a figure, which only a later `GET /references` reads
      const { code, label, source } = body as { code: string; label?: string; source: Reference["source"] };
      const row = { id: `kept-${svc.writes.length}`, code, label: label ?? null, source, created_at: KEPT_AT };
      svc.references = [...svc.references, {
        id: row.id, code, label: row.label, source, name: null, figure: null, field: null, change: null,
        error: null, delayed: null, last_known: null, delayed_by_minutes: null, fetched_at: "2026-11-10 21:04:11+08:00",
      }];
      return reply(201, row);
    }
    if (method === "DELETE" && path.startsWith("/references/")) {
      svc.writes.push({ what: `DELETE ${path}`, body });
      svc.references = svc.references.filter((r) => `/references/${r.id}` !== path);
      return reply(204, null);
    }
    if (method !== "GET") return inner(url, init);

    svc.gets.push(path);
    const gate = gates.get(path);
    if (gate) await gate;
    if (svc.refuse.has(path)) return reply(502, { detail: `${path} failed: moomoo call failed` });
    if (path === "/references") return reply(200, structuredClone(svc.references));
    const answer = await inner(url, init);
    const change = svc.alter.get(path);
    if (!change) return answer;
    const read: unknown = await answer.json();
    return reply(answer.status, change(read));
  }) as typeof fetch;
  return svc;
}
