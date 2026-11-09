/** Every TypeScript module the service runs, loaded by Node itself (ADR 0009, phase 6).
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

/** The library, the service, and the harness the tests build it with.
 *
 *  `testing/` was inside `src/` until #221, so it was loaded along with the modules it fakes and
 *  got this check for free. Moving it out of `src/` is what makes `src/` mean "the service" — and
 *  it quietly took the harness out of the one gate that exists because two classes reached main
 *  unable to load at all. It is 222 lines that every route test depends on, so a load failure
 *  there is a whole suite that cannot start.
 *
 *  `typescript/src` is the same lesson a third time. The domain and the vendor clients left
 *  `backend/src` for the library (ADR 0021), and a walk of the backend alone would have dropped
 *  them from this gate in the same quiet way: the backend still LOADS them, but only the parts
 *  it imports, and the case generator and the fake gateway are imported by nothing it runs.
 *
 *  Which is why this lives in `tools/` and not in either package. It lived in `backend/tools/`
 *  while the one tree it walked was its own; walking the library from there would be the backend
 *  reading another package's source by path, which `check-boundaries` refuses — the reason
 *  `tools/cases.ts` sits here too.
 */
const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["typescript/src", "backend/src", "backend/testing"].map((d) => join(ROOT, d));

/** main.ts is the entry point: loading it starts the service on purpose, so it cannot be checked
 *  by importing it. It is checked by BOOTING it instead, in `src/main.test.ts`, which spawns it
 *  with a setting it must refuse and reads the message — the only thing that loads the process at
 *  all. */
const SKIP = new Set(["backend/src/main.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    if (!path.endsWith(".ts") || path.endsWith(".d.ts") || path.endsWith(".test.ts")) return [];
    return [path];
  });
}

function load(path: string): Promise<{ path: string; ok: boolean; note?: string }> {
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

const files = DIRS.flatMap(walk).filter((f) => !SKIP.has(relative(ROOT, f)));
const results = await Promise.all(files.map(load));
const broken = results.filter((r) => !r.ok);
for (const r of broken) console.log(`  CANNOT LOAD ${relative(ROOT, r.path)}\n    ${r.note}`);
console.log(`${broken.length} of ${results.length} modules cannot be loaded by Node`);
process.exit(broken.length === 0 ? 0 : 1);
