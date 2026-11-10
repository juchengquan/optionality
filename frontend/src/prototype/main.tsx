/** PROTOTYPE — throwaway (branch prototype/ui-revamp, never merged).
 *
 *  Three structurally different directions for the redesigned dashboard, on one page:
 *  `prototype.html?variant=A|B|C&mode=live|review&up=green|red&entry=distinct|same&privacy=1`.
 *  A separate Vite entry beside the real one, so the shipped bundle (frontend/dist) never builds
 *  it, and a static book (data.ts) rather than the live poll. Start: `npm run prototype -w frontend`.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import "../app.css";
import { BOOK, DEFAULT_PREFS, type Prefs } from "./data";
import { Switcher } from "./Switcher";
import type { Mode } from "./types";
import * as A from "./variant-a";
import * as B from "./variant-b";
import * as C from "./variant-c";

const VARIANTS = { A: A.VariantA, B: B.VariantB, C: C.VariantC };
const NAMES = { A: A.name, B: B.name, C: C.name };
type Key = keyof typeof VARIANTS;

function read(): { variant: Key; mode: Mode; prefs: Prefs } {
  const p = new URLSearchParams(location.search);
  const v = (p.get("variant") ?? "A").toUpperCase();
  return {
    variant: (v in VARIANTS ? v : "A") as Key,
    mode: p.get("mode") === "review" ? "review" : "live",
    prefs: {
      upColor: p.get("up") === "red" ? "red" : DEFAULT_PREFS.upColor,
      entryStyle: p.get("entry") === "same" ? "same" : DEFAULT_PREFS.entryStyle,
      privacy: p.get("privacy") === "1",
    },
  };
}

function write(s: { variant: Key; mode: Mode; prefs: Prefs }) {
  const p = new URLSearchParams({ variant: s.variant, mode: s.mode });
  if (s.prefs.upColor === "red") p.set("up", "red");
  if (s.prefs.entryStyle === "same") p.set("entry", "same");
  if (s.prefs.privacy) p.set("privacy", "1");
  history.replaceState(null, "", `?${p}`);
}

function Prototype() {
  const [s, set] = useState(read);
  const update = (patch: Partial<typeof s>) => { const next = { ...s, ...patch }; write(next); set(next); };
  const Variant = VARIANTS[s.variant];
  return (
    <>
      {/* keyed so a switch remounts: no variant inherits another's local state */}
      <Variant key={s.variant} book={BOOK} mode={s.mode} setMode={(mode) => update({ mode })}
               prefs={s.prefs} setPrefs={(prefs) => update({ prefs })} />
      {import.meta.env.DEV && (
        <Switcher keys={Object.keys(VARIANTS)} names={NAMES} current={s.variant}
                  go={(k) => update({ variant: k as Key })} mode={s.mode} setMode={(mode) => update({ mode })}
                  prefs={s.prefs} setPrefs={(prefs) => update({ prefs })} />
      )}
    </>
  );
}

(window as unknown as { __BOOK: unknown }).__BOOK = BOOK; // for inspection from a console
createRoot(document.getElementById("root")!).render(<StrictMode><Prototype /></StrictMode>);
