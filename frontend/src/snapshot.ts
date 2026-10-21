/** Saving the page as an image, for pasting into a chat.
 *
 *  The rasterizing itself is html-to-image's `toPng`, which wraps the node in an SVG
 *  foreignObject so the REAL engine paints it. That choice is not a preference: every colour in
 *  app.css is `oklch`, the top line uses `color-mix(in oklch, ...)` and every highlighted cell is
 *  a `linear-gradient` stopped at the row's fill. html2canvas re-implements CSS painting and can
 *  paint none of it — the cells where the urgency lives would come back blank, in an image
 *  already sent to someone. `__browser__/Rasterize.test.tsx` holds the proof, and fails against a
 *  blank image of exactly the right size.
 */

/** `optionality-20261021-1330.png` — dated, and sortable in a folder of them.
 *
 *  The device's own clock, not DISPLAY_TZ: the figures in the picture are stamped by the service
 *  in its display zone, while this names the file for whoever is saving it, and they will look
 *  for it under the time their phone said. */
export function snapshotName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `optionality-${stamp}.png`;
}

/** What happened to the image: shared, saved, or neither because you closed the sheet. */
export type Delivery = "shared" | "downloaded" | "cancelled";

/** The platform bits, injected so the three paths can be tested without a device each. */
export interface Deliverer {
  canShare: (file: File) => boolean;
  share: (data: { files: File[]; title?: string }) => Promise<void>;
  download: (blob: Blob, name: string) => void;
}

export const platform: Deliverer = {
  // `canShare` with the FILE, not merely with `{files: []}`: whether a device will take an image
  // is a question about the image, and Safari answers differently for different types
  canShare: (file) => Boolean(navigator.canShare?.({ files: [file] })),
  share: (data) => navigator.share(data),
  download: (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // the browser needs the URL only until the click is handled, and a page left open all day
    // would otherwise hold every image it ever saved
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

/** Hand the image to the device: its own share sheet where there is one, a file where there is not.
 *
 *  Never nothing. A press that produces neither a result nor a word is indistinguishable from a
 *  broken button, which this dashboard has now been bitten by twice.
 */
export async function deliver(
  blob: Blob, name: string, how: Deliverer = platform,
): Promise<Delivery> {
  const file = new File([blob], name, { type: "image/png" });
  if (how.canShare(file)) {
    try {
      await how.share({ files: [file], title: "optionality" });
      return "shared";
    } catch (err) {
      // AbortError is YOU closing the sheet — a decision, not a failure, and leaving a file
      // behind for it would be the one thing you did not ask for. Anything else is the device
      // refusing after claiming it could, which Safari does, and then the file is the answer.
      if ((err as { name?: string }).name === "AbortError") return "cancelled";
    }
  }
  how.download(blob, name);
  return "downloaded";
}
