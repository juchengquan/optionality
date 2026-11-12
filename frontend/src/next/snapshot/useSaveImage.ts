/** Saving the redesigned page as an image (#300): `/opt`'s press (useSnapshot.ts), for this page.
 *
 *  The caller mounts the picture's own tree off screen while `shooting` is true (Still.tsx), and
 *  this photographs what is there; it never names that tree, so the picture is free to differ
 *  from the screen. What it keeps from `/opt` is everything that was a bug once: two frames
 *  between mounting and painting, the INNER node captured rather than the stage, the scroll size
 *  at a resolution a device will paint (`captureBox`), and never silence — a press answers with a
 *  picture, a "saved", or the reason it could not.
 *
 *  What it drops is `/opt`'s fetch. That page asked for the holdings on the press because its
 *  panel might never have been opened; this one already holds every figure it draws — LIVE polls
 *  them and REVIEW read them on entering — so the picture is drawn from what the page has and the
 *  press asks the service for nothing.
 *
 *  Nothing it starts outlives the page: once the page has gone, a capture still in flight is
 *  dropped where it lands — no share sheet, no download, no toast and no state set on a tree that
 *  is not there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toBlob } from "html-to-image";

import { toast } from "@/components/ui/toast";
import { captureBox, deliver, snapshotName } from "../../snapshot";

/** The class of the node the picture is taken of, inside the stage. */
export const STILL = "nx-still";

export function useSaveImage(): {
  /** true while the picture's tree must be mounted */
  shooting: boolean;
  stageRef: React.RefObject<HTMLDivElement | null>;
  save: () => Promise<void>;
} {
  const [shooting, setShooting] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const save = useCallback(async () => {
    setShooting(true);
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
      if (alive.current) toast.add({ title: e instanceof Error ? e.message : String(e), type: "error" });
    } finally {
      if (alive.current) setShooting(false);
    }
  }, []);

  return { shooting, stageRef, save };
}
