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

/** The limits a canvas has to stay inside, and what the picture gives up to stay inside them.
 *
 *  Both are the SMALL end of what browsers allow, chosen deliberately: a canvas over the limit does
 *  not raise — it comes back blank or half-painted, and a still image cannot tell you which, so the
 *  cost of being generous here is a picture that silently ends early. iOS is the strict one and it
 *  is also where these pictures are taken.
 */
export const AREA_LIMIT = 16_000_000;
export const SIDE_LIMIT = 8_192;

/** The box to capture, and the resolution it can be painted at.
 *
 *  Two bugs live here, and both produced the same symptom — a picture with figures missing.
 *
 *  The size is the stage's SCROLL size, not its offset size. `offsetWidth` is the box, and anything
 *  overflowing it is simply absent from the image: measured in a real browser with the stage one
 *  pixel narrower than its widest table, 161px of a 13-column combo table fell outside the picture
 *  in Chromium and 204px in WebKit. `.snapshot .table-scroll` no longer clips (app.css), so the
 *  scroll size is now the true extent of the figures rather than the extent of the window onto them.
 *
 *  The resolution is a CEILING of 2 that comes down as far as the limits demand. A flat 2 is what
 *  took the bottom off: squeezed columns wrap, a wrapped page gets tall — 1535px to 4224px in the
 *  same measurement — and 2000x8448 crosses the area cap, at which point the device answers with a
 *  canvas that stops partway. Half the resolution of a complete picture beats all of it on a
 *  picture that ends mid-table.
 */
export function captureBox(width: number, height: number): {
  width: number; height: number; pixelRatio: number;
} {
  const pixelRatio = Math.min(
    2, Math.sqrt(AREA_LIMIT / (width * height)), SIDE_LIMIT / width, SIDE_LIMIT / height,
  );
  return { width, height, pixelRatio };
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
