/** Saving the page as an image (#300): the old page's press (its useSnapshot.ts), for this page.
 *
 *  The caller mounts the picture's own tree off screen while `shooting` is true (Still.tsx), and
 *  this photographs what is there; it never names that tree, so the picture is free to differ
 *  from the screen. What it kept from that page is everything that was a bug once: two frames
 *  between mounting and painting, the INNER node captured rather than the stage, the scroll size
 *  at a resolution a device will paint (`captureBox`), and never silence — a press answers with a
 *  picture, a "saved", or the reason it could not.
 *
 *  What it dropped is that page's fetch. It asked for the holdings on the press because its
 *  panel might never have been opened; this one already holds every figure it draws — LIVE polls
 *  them and REVIEW read them on entering — so the picture is drawn from what the page has and the
 *  press asks the service for nothing.
 *
 *  The page's figures are HELD from the press (`frame`), and the picture is drawn from that copy:
 *  a poll that lands mid-capture would otherwise re-render the tree being photographed, and one
 *  picture could carry two moments. One press at a time, for the same reason.
 *
 *  Nothing it starts outlives the page: once the page has gone, a capture still in flight is
 *  dropped where it lands — no share sheet, no download, no toast and no state set on a tree that
 *  is not there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toBlob } from "html-to-image";

import { toast } from "@/components/ui/toast";
import { captureBox, deliver, snapshotName } from "../../shared/snapshot";

/** The class of the node the picture is taken of, inside the stage. */
export const STILL = "nx-still";

/** What a capture that failed says, when what it threw is not an Error: html-to-image rejects
 *  with the DOM Event of an image that would not decode, which reads "[object Event]". */
export const NOT_DRAWN = "the image could not be drawn";

export function useSaveImage<T>(): {
  /** the page's figures as they were at the press, while the picture's tree must be mounted;
   *  null otherwise */
  frame: T | null;
  stageRef: React.RefObject<HTMLDivElement | null>;
  save: (frame: T) => Promise<void>;
} {
  const [frame, setFrame] = useState<T | null>(null);
  const busy = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const save = useCallback(async (figures: T) => {
    if (busy.current) return;
    busy.current = true;
    setFrame(figures);
    try {
      // two frames: mounted is not laid out, and an unlaid-out tree paints as nothing
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      if (!alive.current) return;
      // the INNER node: html-to-image copies the captured node's own computed style, and the
      // stage's `position: fixed; left: -10000px` would carry the content out of the frame
      const node = stageRef.current?.querySelector<HTMLElement>(`.${STILL}`);
      if (!node) throw new Error("the page for the picture did not come up");
      const blob = await toBlob(node, captureBox(node.scrollWidth, node.scrollHeight));
      if (!alive.current) return;
      if (!blob) throw new Error("the image came back empty");
      const how = await deliver(blob, snapshotName());
      // the device's share sheet is its own confirmation; a toast on top of it is noise
      if (how === "downloaded" && alive.current) toast.add({ title: "saved as an image", type: "success" });
    } catch (e: unknown) {
      if (alive.current) toast.add({ title: e instanceof Error ? e.message : NOT_DRAWN, type: "error" });
    } finally {
      busy.current = false;
      if (alive.current) setFrame(null);
    }
  }, []);

  return { frame, stageRef, save };
}
