/** Whether OpenD is listening (ADR 0009, phase 5).
 *
 *  A plain TCP connect, as the Python does — it answers "is the gateway up" without asking it
 *  anything, which is what /health wants. Any failure is a no: a health endpoint that raises
 *  because the probe raised tells you less than one that says `opend: false`.
 */
import { Socket } from "node:net";

export function probeOpend(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}
