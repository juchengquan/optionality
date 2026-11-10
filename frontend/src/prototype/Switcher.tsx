/** PROTOTYPE — throwaway. The floating bar that is NOT part of any design being judged:
 *  ←/→ cycle the variants (also the arrow keys, except while typing), and the evaluator's
 *  overrides — mode and the three viewer preferences — so variants compare in the same state. */
import { useEffect, useState } from "react";

import type { Prefs } from "./data";
import type { Mode } from "./types";

interface Props {
  keys: string[];
  names: Record<string, string>;
  current: string;
  go: (key: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
}

export function Switcher({ keys, names, current, go, mode, setMode, prefs, setPrefs }: Props) {
  const [open, setOpen] = useState(false);
  const i = keys.indexOf(current);
  const step = (d: number) => go(keys[(i + d + keys.length) % keys.length]!);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pill = "rounded-full px-2.5 py-1 text-[11px] font-medium";
  return (
    <div style={{ position: "fixed", left: "50%", bottom: "max(12px, env(safe-area-inset-bottom))", transform: "translateX(-50%)", zIndex: 2147483647, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
         className="flex flex-col items-center gap-1.5">
      {open && (
        <div className="flex flex-wrap justify-center gap-1 rounded-2xl bg-fuchsia-950/95 p-1.5 text-fuchsia-50 shadow-xl ring-2 ring-fuchsia-400">
          <button className={`${pill} ${mode === "live" ? "bg-fuchsia-400 text-fuchsia-950" : ""}`} onClick={() => setMode("live")}>LIVE</button>
          <button className={`${pill} ${mode === "review" ? "bg-fuchsia-400 text-fuchsia-950" : ""}`} onClick={() => setMode("review")}>REVIEW</button>
          <button className={pill} onClick={() => setPrefs({ ...prefs, upColor: prefs.upColor === "green" ? "red" : "green" })}>up={prefs.upColor}</button>
          <button className={pill} onClick={() => setPrefs({ ...prefs, entryStyle: prefs.entryStyle === "distinct" ? "same" : "distinct" })}>entry={prefs.entryStyle}</button>
          <button className={pill} onClick={() => setPrefs({ ...prefs, privacy: !prefs.privacy })}>privacy={prefs.privacy ? "on" : "off"}</button>
        </div>
      )}
      <div className="flex items-center gap-1 rounded-full bg-fuchsia-950/95 px-1.5 py-1 text-fuchsia-50 shadow-xl ring-2 ring-fuchsia-400">
        <button aria-label="previous variant" className="h-9 w-9 rounded-full text-lg hover:bg-fuchsia-800" onClick={() => step(-1)}>←</button>
        <span className="min-w-36 text-center text-xs">{current} · {names[current]}</span>
        <button aria-label="next variant" className="h-9 w-9 rounded-full text-lg hover:bg-fuchsia-800" onClick={() => step(1)}>→</button>
        <button aria-label="prototype settings" className="h-9 w-9 rounded-full hover:bg-fuchsia-800" onClick={() => setOpen(!open)}>⚙</button>
      </div>
    </div>
  );
}
