/** The port is the lock between two backends (ADR 0021, Decision 3).
 *
 *  Either the TypeScript or the Python backend may be the live one, and they share one database
 *  file, one Telegram bot token and one IB Gateway client id. Two running at once would write the
 *  same alarm rows, split the owner's commands between two `getUpdates` consumers, and quietly
 *  take each other's gateway connection. Nothing stopped that before: `main.ts` migrated the
 *  database, opened the vendors and armed the sweep, and only then bound the port — whose failure
 *  arrives asynchronously, after all of it had started.
 *
 *  So the port is taken FIRST, and taking it is the lock. The operating system enforces it, it is
 *  released when the process dies however it dies, and it needs no lock file to go stale and no
 *  lock row inside the very database it protects. A backend that cannot take it stops having
 *  touched nothing.
 *
 *  Holding the port before the app exists means requests can arrive while the service is still
 *  starting. They get a 503 in the dashboard's error shape (`errors.ts`) rather than a refused
 *  connection, and the app is attached once it is ready. This is `@hono/node-server`'s `serve`
 *  split in two at the point it binds: the same `createServer`, the same `getRequestListener`
 *  with the same hostname, attached later.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import { getRequestListener } from "@hono/node-server";

type Fetch = Parameters<typeof getRequestListener>[0];
type Listener = (req: IncomingMessage, res: ServerResponse) => unknown;

export interface HeldPort {
  readonly server: Server;
  /** The port actually bound, which differs from the one asked for only when that was 0. */
  readonly port: number;
  /** Start serving the app. Until this is called every request is answered 503. */
  serve(fetch: Fetch): void;
}

const STARTING = JSON.stringify({ detail: "the service is starting" });

const starting: Listener = (_req, res) => {
  res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
  res.end(STARTING);
};

/** Bind `hostname:port`, or reject naming the port when something else already holds it. */
export function takePort(port: number, hostname = "127.0.0.1"): Promise<HeldPort> {
  return new Promise((resolve, reject) => {
    let listener = starting;
    const server = createServer((req, res) => listener(req, res));
    server.once("error", (err: NodeJS.ErrnoException) => {
      const why = err.code === "EADDRINUSE"
        ? `port ${port} on ${hostname} is taken: another backend is running`
        : `could not take port ${port} on ${hostname}: ${err.message}`;
      reject(new Error(why, { cause: err }));
    });
    server.listen(port, hostname, () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === "object" && address ? address.port : port,
        serve(fetch) { listener = getRequestListener(fetch, { hostname }); },
      });
    });
  });
}
