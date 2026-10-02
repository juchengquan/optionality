/** Every backend module, loaded by Node itself (ADR 0009, phase 6).
 *
 *  Node runs TypeScript by ERASING types. Anything that would have to EMIT code is rejected outright:
 *  parameter properties, enums, namespaces, decorators, `import =`. tsc accepts all of them and vitest
 *  transforms them, so neither the typecheck nor the test suite can see the problem — two classes
 *  reached main with `constructor(private readonly deps: Deps) {}` and could not be loaded at all.
 *
 *  `node --check` does not help: it parses the syntax happily. The only honest check is to load the
 *  module, which is what this does — one short-lived subprocess each, because a module that binds a
 *  port would otherwise keep the checker alive.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const SRC = join(ROOT, "backend/src");

/** main.ts is the entry point: loading it starts the service on purpose. It is checked by running
 *  the service, not by importing it. */
const SKIP = new Set(["backend/src/main.ts"]);

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    if (!path.endsWith(".ts") || path.endsWith(".d.ts") || path.endsWith(".test.ts")) return [];
    return [path];
  });
}

function load(path) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(path)});`],
      { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ path, ok: true, note: "still running; not a syntax problem" }); }, 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ path, ok: true });
      const first = stderr.split("\n").find((l) => /Error|error/.test(l)) ?? `exit ${code}`;
      resolve({ path, ok: false, note: first.trim() });
    });
  });
}

const files = walk(SRC).filter((f) => !SKIP.has(relative(ROOT, f)));
const results = await Promise.all(files.map(load));
const broken = results.filter((r) => !r.ok);
for (const r of broken) console.log(`  CANNOT LOAD ${relative(ROOT, r.path)}\n    ${r.note}`);
console.log(`${broken.length} of ${results.length} modules cannot be loaded by Node`);
process.exit(broken.length === 0 ? 0 : 1);
