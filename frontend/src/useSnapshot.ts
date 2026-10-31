/** Saving the page as a PNG, for pasting into a chat.
 *
 *  The picture is NOT this screen rasterized. `useTableFit` drops columns against the viewport
 *  (ADR 0008), so a capture of the live page carries whatever subset your width allows — on a
 *  phone, a fraction of the figures. The caller mounts a second tree at a fixed width with every
 *  ticked column while `shooting` is true (SnapshotView), and that off-screen tree is what gets
 *  painted. This hook never names it: it is handed `stageRef` and photographs what is there,
 *  which is what keeps the picture free to differ from the screen.
 *
 *  Holdings are fetched HERE, by the press. They used to be a clone of the live panel's node,
 *  which meant the picture carried them only while that panel happened to be open: the same
 *  button produced two different images depending on a disclosure triangle, and the one you get
 *  without touching anything was the one missing the money. They are rendered from the same
 *  readout the panel uses now (Holdings.HoldingReadout), so the two still cannot disagree.
 *
 *  The press therefore costs one bounded `/positions/values` call, which is the reason it was
 *  not done this way at first. It buys more than the open-panel case: the figures in the picture
 *  are then as old as its freshness line says, where a panel opened ten minutes ago was not.
 *
 *  Three steps are ORDER rather than arithmetic, and each was a bug: the holdings are awaited
 *  before the stage is laid out, the stage gets two frames before it is painted, and the node
 *  captured is the INNER one. `__tests__/UseSnapshot.test.tsx` asserts the sequence, because the
 *  symptom of getting any of it wrong is a PNG — the one artefact a test cannot read.
 */
import { useCallback, useRef, useState } from "react";
import { toBlob } from "html-to-image";

import { toast } from "@/components/ui/toast";
import { captureBox, deliver, snapshotName } from "./snapshot";

export function useSnapshot(loadHoldings: () => Promise<void>): {
  /** true while the off-screen tree must be mounted — the caller renders it on this */
  shooting: boolean;
  stageRef: React.RefObject<HTMLDivElement | null>;
  saveImage: () => Promise<void>;
} {
  const [shooting, setShooting] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  const saveImage = useCallback(async () => {
    setShooting(true);
    try {
      // before the frames, so the stage is laid out WITH them: this is the one figure in the
      // picture that is not already on screen, and awaiting it here is what lets the rest of the
      // image be a single consistent instant
      await loadHoldings();
      // two frames: mounted is not laid out, and an unlaid-out tree paints as nothing
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      // the INNER node, not the stage. html-to-image copies the captured node's own computed
      // style into the SVG it paints, so capturing the stage carried `position: fixed` and
      // `left: -10000px` with it and the content landed outside the frame — a blank PNG of
      // exactly the right size, which is the one failure shape that looks like success.
      const stage = stageRef.current?.querySelector<HTMLElement>(".snapshot");
      // said rather than returned: this read `if (!stage) return`, which is the silence the rest
      // of this function exists to avoid, on the one path where nothing was even attempted
      if (!stage) throw new Error("the page for the picture did not come up");
      // the SCROLL size, and a resolution that keeps the canvas inside what a device will paint.
      // Both halves of a bug that took figures out of the picture three different ways — see
      // captureBox, and `.snapshot .table-scroll` in app.css, which is what makes the scroll size
      // mean the extent of the figures rather than the extent of the window onto them.
      const blob = await toBlob(stage, captureBox(stage.scrollWidth, stage.scrollHeight));
      if (!blob) throw new Error("the image came back empty");
      const how = await deliver(blob, snapshotName());
      // the device's share sheet is its own confirmation; a toast on top of it is noise
      if (how === "downloaded") toast.add({ title: "saved as an image", type: "success" });
    } catch (e: unknown) {
      // never silence: a press that produces neither a picture nor a word is indistinguishable
      // from a broken button
      toast.add({ title: e instanceof Error ? e.message : String(e), type: "error" });
    } finally {
      setShooting(false);
    }
  }, [loadHoldings]);

  return { shooting, stageRef, saveImage };
}
