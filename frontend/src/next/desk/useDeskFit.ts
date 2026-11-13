import { useCallback, useEffect, useMemo, useState } from "react";

import { charsOf, COLUMNS, fitColumns, offerable, type DeskColumn, type DeskRow } from "./columns";

/** Measures the room the desk table has and how wide one of its characters is, and fits the
 *  columns to both (ADR 0008): the container's width is why columns drop at all, the character's is
 *  why they keep dropping correctly when the reader bumps their text size, which no breakpoint can
 *  see. Resizing the window, opening the inspector beside the table and changing the text size all
 *  re-measure. The old page's `useTableFit.ts` did the same for its two tables (#301 deleted it). */
export function useDeskFit(
  rows: readonly DeskRow[], hidden: ReadonlySet<string>, privacy: boolean, session: boolean,
) {
  // a callback ref, so the measuring starts when the node exists rather than on the first render
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setNode(el), []);
  const [available, setAvailable] = useState(0);
  const [charWidth, setCharWidth] = useState(0);

  const measure = useCallback(() => {
    if (!node) return;
    setAvailable(node.clientWidth);
    // ten characters in the font the table really renders, to divide away rounding
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.className = "nxd-probe";
    probe.textContent = "0000000000";
    node.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 10;
    node.removeChild(probe);
    if (w > 0) setCharWidth(w);
  }, [node]);

  useEffect(() => {
    measure();
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    // the container does not resize when only the text size does
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, node]);

  const ready = available > 0 && charWidth > 0;
  const widths = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of COLUMNS) out[c.key] = Math.ceil(charsOf(c, rows, privacy, session) * charWidth);
    return out;
  }, [rows, privacy, session, charWidth]);
  const widthOf = (key: string) => widths[key] ?? 0;

  // before the first measurement, every ticked column: a flash of too many is recoverable, a flash
  // of one is what a broken table looks like
  const room = ready ? available : Number.POSITIVE_INFINITY;
  const columns: DeskColumn[] = fitColumns(room, hidden, widthOf);
  const offered = offerable(room, hidden, widthOf);

  // the rule's column takes what is left over, or the name's when the rule has dropped
  const flexible = columns.some((c) => c.key === "alarm") ? "alarm" : "name";
  const template = ready
    ? columns.map((c) => c.key === flexible ? `minmax(${widthOf(c.key)}px, 1fr)` : `${widthOf(c.key)}px`).join(" ")
    : columns.map((c) => c.key === flexible ? "minmax(max-content, 1fr)" : "max-content").join(" ");

  return { ref, columns, offered, template };
}
