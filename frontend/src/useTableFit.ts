import { useCallback, useEffect, useMemo, useState } from "react";

import type { Entry } from "./api";
import {
  columnsFor, COMBO_COLUMNS, offerable, SINGLE_COLUMNS, widthsFromContent,
} from "./columns";
import { comboSubLine } from "./format";
import { cellValue } from "./WatchlistTable";

/** Measures the room a table actually has, and how wide a character actually is.
 *
 *  Both matter and only one is obvious. The container width is why columns drop at all;
 *  the character width is why they keep dropping correctly after the reader bumps their
 *  text size, which no pixel breakpoint can do — the viewport does not change when the
 *  font does. See ADR 0008.
 */
export function useTableFit(table: "single" | "combo", rows: readonly Entry[], hidden: Set<string>) {
  // a CALLBACK ref, not useRef: the table renders nothing at all until the first quotes
  // arrive, so a plain ref is still null when the effect runs and the effect never re-runs
  // once the table appears. The node tells us when it exists.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setNode(el), []);
  const [available, setAvailable] = useState(0);
  const [charWidth, setCharWidth] = useState(0);

  const measure = useCallback(() => {
    const el = node;
    if (!el) return;
    setAvailable(el.clientWidth);

    // one character, in the font and size the table is really rendering, measured against
    // the container so inherited styling applies. Ten of them, to divide away rounding.
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;font-variant-numeric:tabular-nums";
    probe.textContent = "0000000000";
    el.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 10;
    el.removeChild(probe);
    if (w > 0) setCharWidth(w);
  }, [node]);

  useEffect(() => {
    measure();
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    // the container does not resize when the text size does, so watch that separately
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, node]);

  // before the first measurement, show everything rather than nothing: a flash of too many
  // columns is recoverable, a flash of one is what a broken table looks like
  const ready = available > 0 && charWidth > 0;

  // measured once per (rows, charWidth), not once per column: the naive version walked
  // every row for every column on every render
  const widths = useMemo(
    () =>
      ready
        ? widthsFromContent(
            table === "single" ? SINGLE_COLUMNS : COMBO_COLUMNS,
            rows,
            table === "combo",
            charWidth,
            cellValue,
            comboSubLine,
          )
        : null,
    [ready, table, rows, charWidth],
  );

  const widthOf = widths ? (key: string) => widths[key] ?? 0 : undefined;
  // before the first measurement, "infinite room" means every ticked column is drawn
  const room = ready ? available : Number.POSITIVE_INFINITY;

  return {
    ref,
    columns: columnsFor(table, room, hidden, widthOf),
    offered: offerable(table, room, widthOf),
  };
}
