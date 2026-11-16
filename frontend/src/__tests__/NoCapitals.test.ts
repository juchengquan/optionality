/** Sentence case, never capitals set by CSS (the owner's standard of 2026-11-16, part H; ADR 0023):
 *  a heading or a label is written as it is to be read — "Payoff at expiry", "History", "Rules" —
 *  and set apart by weight and size. Capitals set by a stylesheet read as shouting, and turn a ν
 *  into "Ν", which is the letter N.
 *
 *  Held two ways: here, over every stylesheet and component the page is built from, for a
 *  `text-transform` that makes capitals or a Tailwind class that sets one; and in the browser
 *  (`NextGreekLabels`), for what the page actually computes on every heading, label and button. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = ["src", "frontend/src"].map((d) => resolve(process.cwd(), d)).find((d) => existsSync(`${d}/shared/prefs.ts`))!;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ["__tests__", "__browser__", "testing"].includes(name) ? [] : files(path);
    return /\.(css|tsx?)$/.test(name) ? [path] : [];
  });
}

/** Every place in `text` that sets capitals. */
export function capitals(text: string): string[] {
  const css = [...text.matchAll(/text-transform\s*:\s*(uppercase|capitalize)/g)].map((m) => m[0]);
  // a Tailwind class, inside a className string
  const tw = [...text.matchAll(/className=(?:"[^"]*|\{`[^`]*|\{"[^"]*)\b(uppercase|capitalize)\b/g)].map((m) => m[1]!);
  return [...css, ...tw];
}

describe("no capitals set by CSS (part H)", () => {
  it("finds one where it is set", () => {
    expect(capitals(".h { font-weight: 600; text-transform: uppercase; }")).toHaveLength(1);
    expect(capitals('<h4 className="text-xs uppercase tracking-wide">')).toHaveLength(1);
    expect(capitals(".h { text-transform: none; }")).toEqual([]);
  });

  it("sets none anywhere the page is built from", () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(50);
    const found = all.flatMap((f) => capitals(readFileSync(f, "utf8")).map((c) => `${relative(SRC, f)}: ${c}`));
    expect(found).toEqual([]);
  });
});
