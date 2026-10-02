/** Calling the Python run pipeline (ADR 0009, phase 6c).
 *
 *  The strategy and holdings scans stay in Python: porting them means replacing pandas, the option
 *  chain scan and yfinance, for a feature that has run twice and has no schedule. The owner's
 *  decision, recorded in the plan. This is the boundary, and the whole of it.
 *
 *  Files rather than pipes, because the moomoo SDK writes its own lines to the subprocess's stdout and
 *  a JSON document sharing a pipe with them is one that sometimes does not parse.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunRequest {
  task: string;
  config: unknown;
  notify: boolean;
  opendHost: string;
  opendPort: number;
}

export interface RunOutcome {
  html: string;
  summary: unknown;
  warnings: unknown;
  details: unknown;
  /** the run succeeded and the report could not be sent; the two are different failures */
  notifyError: string | null;
}

export interface AlertRequest {
  task: string;
  config: unknown;
  subject: string;
  message: string;
}

/** What the bridge needs to know about where Python lives. */
export interface RunnerConfig {
  /** the repository root, which `uv run` has to be invoked from */
  cwd: string;
  /** The whole invocation, bar the two file paths which are appended. Defaults to
   *  `uv run python -m optionality.runner`; a test supplies a stand-in process. */
  command?: string[];
  timeoutMs?: number;
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
  type?: string;
  html?: string;
  summary?: unknown;
  warnings?: unknown;
  details?: unknown;
  notify_error?: string | null;
  sent?: boolean;
  reason?: string;
}

/** Thrown when the TASK failed. Distinct from a bridge that could not run at all: only this one
 *  carries an error the owner should see on the run. */
export class TaskFailed extends Error {
  readonly kind = "task";
}

export class PythonRunner {
  private readonly config: RunnerConfig;

  constructor(config: RunnerConfig) {
    this.config = config;
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    const response = await this.call({
      mode: "run",
      task: request.task,
      config: request.config,
      notify: request.notify,
      opend_host: request.opendHost,
      opend_port: request.opendPort,
    });
    return {
      html: String(response.html ?? ""),
      summary: response.summary ?? null,
      warnings: response.warnings ?? null,
      details: response.details ?? null,
      notifyError: response.notify_error ?? null,
    };
  }

  /** The failure email. Returns whether one was actually sent — a config with no gmail block is not
   *  a failure, it is a config that does not want email. */
  async alert(request: AlertRequest): Promise<{ sent: boolean; reason?: string }> {
    const response = await this.call({
      mode: "alert",
      task: request.task,
      config: request.config,
      subject: request.subject,
      message: request.message,
    });
    return { sent: response.sent === true, ...(response.reason ? { reason: response.reason } : {}) };
  }

  private async call(request: Record<string, unknown>): Promise<BridgeResponse> {
    const dir = await mkdtemp(join(tmpdir(), "optionality-run-"));
    const input = join(dir, "request.json");
    const output = join(dir, "response.json");
    try {
      await writeFile(input, JSON.stringify(request));
      await this.spawn(input, output);
      const response = JSON.parse(await readFile(output, "utf8")) as BridgeResponse;
      if (!response.ok) {
        throw new TaskFailed(response.error ?? "the run failed without saying why");
      }
      return response;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private spawn(input: string, output: string): Promise<void> {
    const [command, ...rest] = this.config.command
      ?? ["uv", "run", "python", "-m", "optionality.runner"];
    const args = [...rest, input, output];
    const timeoutMs = this.config.timeoutMs ?? 30 * 60_000;
    return new Promise((resolve, reject) => {
      const child = spawn(command!, args, { cwd: this.config.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      // the SDK's own chatter: kept for the log, never parsed
      child.stdout.on("data", (chunk) => { process.stdout.write(String(chunk)); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the run pipeline did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`could not start the run pipeline: ${err.message}`));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        // a non-zero exit is the bridge itself failing, which is a different thing from a failed run
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        reject(new Error(`the run pipeline exited ${code ?? signal}: ${tail || "no output"}`));
      });
    });
  }
}
