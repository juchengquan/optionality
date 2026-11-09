/** A seam's interior is private: only its entry file may be imported from outside it.
 *
 *  `check-boundaries.mjs` states the rule BETWEEN packages — no package reaches into another's
 *  source tree, only into what it publishes. This states the same rule INSIDE one, for the few
 *  directories where the whole point is that callers go through one door.
 *
 *  The one that provoked it is the vendors' seam. ADR 0015 and 0019 both rest on every
 *  market-data vendor being reached through one seam — `openVendors` opens each vendor ONCE and
 *  hands the Provider back among the sources, which is what makes "one client either way"
 *  structural rather than remembered. IB Gateway allows one connection per client id and the
 *  SECOND DISPLACES THE FIRST IN SILENCE, so a second client is not an inefficiency, it is a
 *  provider that stops answering for reasons nobody can see.
 *
 *  Nothing enforced it. `vendors.ts` was the only importer of `opend/`, `ibkr/` and `yahoo/` —
 *  measured, three lines in one file, not even the suites reached past it — but that was a fact
 *  about today rather than a rule, and the cheapest way to fix a dashed row is to import the
 *  client that has the figure. A convention nothing checks is a convention, and conventions are
 *  what a deadline spends (the sentence `check-test-support.mjs` was written under).
 *
 *  A script rather than an ESLint rule, for the reason that file gives: the repo has no ESLint and
 *  two rules do not justify a toolchain. It reads specifiers with the same pattern — `from "x"`,
 *  `import("x")`, bare `import "x"` — and is checked against a FIXTURE TREE rather than against
 *  this repository, which is what a sweep of `check-boundaries` taught: three ways to gut it left
 *  every suite green.
 *
 *  ADR 0021 split that seam across two packages. The clients went to the library, `typescript/`,
 *  because they run with no service; the door and the descriptors stayed in `backend/`, because
 *  they read Settings. So the backend now reaches a client by NAME, `optionality/vendors/...`,
 *  where it used to reach one by a relative path, and a guard that read relative paths alone would
 *  have stopped seeing the very imports it exists for. A seam may therefore declare the package
 *  it lives in, and that package's names are resolved through its `exports` to the file they land
 *  on: a reach is a reach whichever way it is spelled.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", ".out"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Each directory whose interior is private, and the files that are not.
 *
 *  `why` is printed when the rule is broken, because a guard that only says "refused" teaches the
 *  next person to delete it.
 *
 *  Every door is listed HERE rather than inferred, and each one that is not the obvious `index.ts`
 *  carries its own reason. A door with a reason is a door; a blanket exemption — "anything under
 *  `tools/` may reach in" — is a hole with a comment, and that distinction is the whole difference
 *  between this file and no file.
 */
export const SEAMS = [
  {
    dir: "backend/src/vendors",
    /** The door, and since ADR 0021 the only one: the fake gateway and the field mappings were
     *  doors here too, and moved to the library with the clients they sit beside. */
    doors: ["index.ts"],
    /** What may NEVER become a door, whatever the pressure.
     *
     *  Found by a mutation sweep: adding `"ibkr/client.ts"` to the list above passed every test
     *  this file had, because the fixture tests declare their own seam and the one test about the
     *  real `SEAMS` only asked that a door and a reason exist. A guard whose exemption list can be
     *  opened from the inside is not a guard — and the pressure is concrete: the cheapest way to
     *  fix a dashed row is to import the client that has the figure.
     *
     *  A client is the connection itself, and a `vendor.ts` is the descriptor `VENDORS` is built
     *  from — naming either as a door is naming the thing the seam exists for. No client lives
     *  here since ADR 0021; the pattern keeps one from coming back as a door if one does. */
    never: /\/(client|vendor)\.ts$/,
    why: "a vendor is reached through `openVendors` (ADR 0015, 0019) — IB Gateway allows one "
      + "connection per client id and the second displaces the first in silence",
  },
  {
    /** The same seam's other half (ADR 0021): the clients themselves, in the library.
     *
     *  They moved because they run with no service; what OPENS them did not, because it reads
     *  Settings. So the rule is that only the backend's vendor door reaches past these doors —
     *  `insiders` — and the door is in turn reached by `openVendors` alone, which is the seam
     *  above. Two seams, one rule: a client is opened in one place.
     */
    dir: "typescript/src/vendors",
    /** Reached by name from the backend, never by path: `check-boundaries` refuses a path out of
     *  a package. So without this the guard would see none of the imports it exists for. */
    package: "typescript",
    doors: [
      // the fake IB GATEWAY, not a client: recorded replies plus the socket that serves them, and
      // the one definition `make ibkr-fake-gateway` and the suite share so the two cannot drift
      // (CLAUDE.md). It lives beside `wire.ts` and `messages.ts` because it speaks that protocol —
      // moving it out would reach INTO the seam instead, which is the same hole reversed.
      "ibkr/fake.ts",
      // every vendor's PURE field mapping, so `testdata/vendors/` can record one truth for two
      // languages. A door rather than a re-export from the backend's `vendors/index.ts`, measured
      // before ADR 0021 put the two in different packages: that route typechecks the whole
      // vendor graph — and therefore the moomoo SDK's declarations — into the case generator,
      // which calls neither. `never` below still forbids a client.
      "fields.ts",
    ],
    /** The descriptors, which build the clients from Settings. They must be a seam THEMSELVES —
     *  `breaches` refuses an insider that is not — so naming `backend/src` here to make a dashed
     *  row go away fails rather than opening every client to every route. */
    insiders: ["backend/src/vendors"],
    /** Whatever opens a connection: a client, the socket under IB Gateway's, and OpenD's probe. */
    never: /\/(client|socket|probe)\.ts$/,
    why: "the library's vendor clients are opened by the backend's descriptors alone, which "
      + "`openVendors` reaches (ADR 0015, 0019, 0021) — IB Gateway allows one connection per "
      + "client id and the second displaces the first in silence",
  },
  {
    dir: "backend/src/engine",
    doors: ["index.ts"],
    /** Nothing but the door, and `sweeper.ts` least of all: a route or a bot command that could
     *  import `MonitorSweeper` could start a sweep from inside a request. They get the
     *  `SweeperPort` in `deps` instead, which is `health.ts`'s and read-only.
     *
     *  `health.ts` is named here for a second reason, which is the reason this seam exists at
     *  all. `index.ts` deliberately does not export `SweepHealth`, so a second health account
     *  cannot be constructed from outside the engine — see that file. Naming `health.ts` as a
     *  door would hand the class back and reopen #230's mutation M7. */
    never: /\/(sweeper|health|scheduler)\.ts$/,
    importableBy: [
      "backend/src/main.ts",
      // this guard's own test, which imports the door to assert it still withholds `SweepHealth`
      // — the omission that makes #230's mutation M7 fail to compile. Declared rather than
      // exempted as a class: "any test may reach in" is how the engine stops being main-only.
      "tools/check-seams.test.mjs",
      // the door scenarios (ADR 0021): a sweep scenario is one tick of the REAL engine on a
      // stated world, so the file that runs it must build a `MonitorSweeper` as `main.ts` does.
      // It gets the door's exports and nothing more — `SweepHealth` stays withheld.
      "backend/testing/scenarios/doors.ts",
    ],
    why: "the engine is reached by `main.ts` alone; a request must not be able to start a sweep, "
      + "and `index.ts` withholds SweepHealth so a second health account cannot be built",
  },
  {
    dir: "backend/src/entrypoints",
    doors: ["http/index.ts", "bot/bot.ts"],
    /** Who may use a door AT ALL (ADR 0020).
     *
     *  The rule here is not WHICH file is importable but which direction the dependency may run:
     *  delivery depends on the library and never the reverse. `main.ts` is the one place that
     *  wires the two halves, and `testing/harness.ts` builds the app for a test — declared, with
     *  its reason, rather than exempted as a class. A blanket "anything under testing/ may reach
     *  in" would be a hole with a comment.
     *
     *  Declared on `entrypoints/` rather than on `http/` and `bot/` separately, because a rule per
     *  surface would leave a THIRD entrypoint unguarded until somebody remembered to add a line.
     *  That is `hc.types.ts`'s "complete by diligence" failure, and the test that every directory
     *  in here has a declared door closes it in advance.
     *
     *  The frontend reaches `AppType` through this seam too, but by the PACKAGE specifier
     *  `backend` rather than a relative path — so `check-boundaries` owns that crossing and this
     *  guard never sees it. Which is also right under ADR 0020: the dashboard is an HTTP client
     *  and should depend on the HTTP entrypoint.
     */
    importableBy: [
      "backend/src/main.ts", "backend/testing/harness.ts",
      // the door scenarios (ADR 0021) open both surfaces on a stated world — the bot through
      // `handleUpdate`, the routes through `createApp` — beside the real engine `harness.ts`
      // never builds. Test support, as the harness is; `check-test-support` keeps it out of `src/`.
      "backend/testing/scenarios/doors.ts",
    ],
    /** `app.ts` and a route may never be doors: a route mounted from anywhere but `app.ts`, or
     *  mounted twice, is the one thing in this layer that would be hard to see. */
    never: /\/(app\.ts|routes\/.*)$/,
    why: "delivery depends on the library and never the reverse (ADR 0020); `main.ts` is the only "
      + "wiring, and a request must not reach another surface's routes",
  },
];

/** Exported so the test can ask what a seam actually contains. */
export function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return SOURCE.test(path) ? [path] : [];
  });
}

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

/** Where a name the package publishes lands, as a file — or null for a subpath the package does
 *  not export, which Node refuses before any guard could matter, and undefined for a name that is
 *  not this package's at all.
 *
 *  The exports map is read rather than assumed, patterns included: a wildcard export added to the
 *  library would otherwise be a way past the door that this guard could not see. */
function publishedBy(repo, pkg) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repo, pkg, "package.json"), "utf8"));
  } catch {
    return () => undefined;                       // no manifest, so no name to be reached by
  }
  const { name, exports = {} } = manifest;
  const map = typeof exports === "string" ? { ".": exports } : exports;
  return (spec) => {
    if (spec !== name && !spec.startsWith(`${name}/`)) return undefined;
    const sub = `.${spec.slice(name.length)}`;
    for (const [key, value] of Object.entries(map)) {
      const to = typeof value === "string" ? value : value?.import ?? value?.default;
      if (typeof to !== "string") continue;
      if (key === sub) return resolve(repo, pkg, to);
      const star = key.indexOf("*");
      if (star < 0) continue;
      const [head, tail] = [key.slice(0, star), key.slice(star + 1)];
      if (sub.length < key.length - 1 || !sub.startsWith(head) || !sub.endsWith(tail)) continue;
      return resolve(repo, pkg, to.replace("*", sub.slice(head.length, sub.length - tail.length)));
    }
    return null;
  };
}

/** Every import that reaches past a seam, as `{ seam, line }`.
 *
 *  The seam comes back with the line so the runner can print the reason for the seam that was
 *  BROKEN and not for every seam declared. A mutation sweep caught that: reaching into the engine
 *  printed the vendors' sentence about IB Gateway's client ids underneath it, which is the kind of
 *  irrelevant paragraph that teaches somebody the output is noise.
 *
 *  Takes a root and the seams so the guard can be tested against a fixture tree, which is the
 *  arrangement `check-boundaries.mjs` and `check-test-support.mjs` both arrived at.
 */
export function breaches(repo = ROOT, seams = SEAMS) {
  const found = [];
  for (const seam of seams) {
    const dir = join(repo, seam.dir);
    // a door the seam itself forbids is a breach of the seam, reported before any import is read:
    // this is the rule that cannot be relaxed by relaxing the rule
    for (const door of seam.doors) {
      if (seam.never?.test(`/${door}`)) {
        found.push({
          seam,
          line: `${seam.dir}/: "${door}" is named as a door, and ${seam.never} may never be one`,
        });
      }
    }
    // and an insider that is not itself a seam, for the same reason: an insider reaches the whole
    // interior, so naming a bare directory would hand every client to everything in it
    for (const insider of seam.insiders ?? []) {
      if (seams.some((s) => s.dir === insider)) continue;
      found.push({
        seam,
        line: `${seam.dir}/: "${insider}" is named as an insider and is not itself a seam, `
          + `so what it reaches would have no door`,
      });
    }
    const doors = new Set(seam.doors.map((d) => join(repo, seam.dir, d)));
    const insiders = (seam.insiders ?? []).map((d) => join(repo, d));
    const published = seam.package === undefined
      ? () => undefined
      : publishedBy(repo, seam.package);
    let files;
    try {
      files = walk(repo);
    } catch {
      continue;                                   // no such tree; nothing to say about it
    }
    for (const file of files) {
      if (inside(file, dir)) continue;            // the interior may import itself
      if (insiders.some((d) => inside(file, d))) continue;
      const text = readFileSync(file, "utf8");
      for (const [, spec] of text.matchAll(SPECIFIER)) {
        // a name is resolved only for a seam that declares its package; for the others a name is
        // check-boundaries' business, as the entrypoints seam says of the frontend's `AppType`
        const target = spec.startsWith(".") ? resolve(dirname(file), spec) : published(spec);
        if (!target || !inside(target, dir)) continue;
        const from = relative(repo, file);
        if (doors.has(target)) {
          // the door is the right file; the question `importableBy` asks is whether THIS caller
          // may knock at all. Unset means anyone may.
          if (seam.importableBy === undefined || seam.importableBy.includes(from)) continue;
          found.push({
            seam,
            line: `${from}: imports "${spec}" — ${seam.dir}/ is reached only by `
              + `${seam.importableBy.join(", ")}`,
          });
          continue;
        }
        found.push({
          seam,
          line: `${from}: imports "${spec}" — ${relative(repo, target)} is inside `
            + `${seam.dir}/, whose doors are ${seam.doors.join(", ")}`,
        });
      }
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = breaches();
  if (found.length > 0) {
    console.error(`${found.length} import(s) reach past a seam:`);
    for (const { line } of found) console.error(`  ${line}`);
    for (const seam of new Set(found.map((f) => f.seam))) {
      console.error(`${seam.dir}/: ${seam.why}`);
    }
    process.exit(1);
  }
  console.log(`no import reaches past a seam (${SEAMS.length} checked)`);
}
