/** Saving the page as an image: the pure half, `shared/snapshot.ts` — the file's name, the box the
 *  picture is captured in, and how it reaches the device.
 *
 *  These groups were in `Snapshot.test.tsx`, which also rendered the old page's `SnapshotView` and
 *  so went with it (#301). The module they hold is the redesign's too (`next/snapshot/useSaveImage.ts`
 *  calls all three), so they come back here importing nothing else.
 */
import { describe, expect, it, vi } from "vitest";

import { AREA_LIMIT, SIDE_LIMIT, captureBox, deliver, snapshotName } from "../shared/snapshot";

describe("the file name", () => {
  it("is dated and sortable", () => {
    // the device's zone, which the suite pins to UTC: 13:30 in +08 is 05:30 here
    expect(snapshotName(new Date("2026-10-21T13:30:00+08:00"))).toBe("optionality-20261021-0530.png");
  });
});

describe("the box the image is captured in", () => {
  // The bug these exist for: the picture was captured at the stage's offsetWidth and a flat
  // pixelRatio of 2. Both are wrong at the edges — offsetWidth excludes anything that overflows,
  // and 2 is not always reachable. Measured in a real browser: with the stage one pixel narrower
  // than its widest table, 161px of a 13-column combo table fell outside the image in Chromium
  // and 204px in WebKit, the squeezed columns pushed the page from 1535px to 4224px tall, and
  // the resulting 2000x8448 canvas crossed the area cap iOS enforces — which is how one cause
  // produced all three truncations at once: columns, cell text, and the bottom of the image.
  //
  // Reading scrollWidth/scrollHeight off the stage rather than its offset size is the CALLER's
  // (`next/snapshot/useSaveImage.ts`); `captureBox` takes those two numbers and decides only the
  // resolution, which is what is held here.
  it("keeps the doubled resolution whenever it fits", () => {
    // the common case must not get worse: a normal book is nowhere near the caps
    expect(captureBox(1328, 1536).pixelRatio).toBe(2);
    expect(captureBox(1000, 2000).pixelRatio).toBe(2);
  });

  it("gives up resolution rather than the bottom of the image, over the area cap", () => {
    // 1145 x 4224 at 2 is 19.3M pixels; iOS refuses and answers with a blank or partial canvas,
    // which in a still image is indistinguishable from a page that ended there
    const box = captureBox(1145, 4224);
    expect(box.pixelRatio).toBeLessThan(2);
    expect(box.width * box.height * box.pixelRatio ** 2).toBeLessThanOrEqual(AREA_LIMIT);
    // and still the full extent, just painted with fewer pixels
    expect(box).toMatchObject({ width: 1145, height: 4224 });
  });

  it("keeps each side under the limit too, not just the area", () => {
    // a long thin page can sit under the area cap and still exceed the longest side a canvas
    // will take, which fails the same silent way
    const box = captureBox(900, 7000);
    expect(box.height * box.pixelRatio).toBeLessThanOrEqual(SIDE_LIMIT);
    expect(box.width * box.pixelRatio).toBeLessThanOrEqual(SIDE_LIMIT);
  });

  it("never scales a picture UP", () => {
    // a short watchlist is not an excuse to ask for a 4x canvas: the ratio is a ceiling that
    // only ever comes down
    expect(captureBox(400, 300).pixelRatio).toBe(2);
  });
});

describe("delivering it", () => {
  const blob = new Blob(["x"], { type: "image/png" });

  it("uses the share sheet when the device has one", async () => {
    const share = vi.fn((_data: { files: File[] }) => Promise.resolve());
    const how = await deliver(blob, "a.png", {
      canShare: () => true, share, download: () => { throw new Error("should not download"); },
    });

    expect(how).toBe("shared");
    const file = (share.mock.calls[0]![0] as unknown as { files: File[] }).files[0]!;
    expect(file.name).toBe("a.png");
    expect(file.type).toBe("image/png");
  });

  it("falls back to a download where it does not, rather than doing nothing", async () => {
    // the whole lesson of the record button: a press that produces neither a result nor a word
    // is indistinguishable from a broken one
    const download = vi.fn();
    const share = vi.fn(() => Promise.resolve());
    const how = await deliver(blob, "a.png", { canShare: () => false, share, download });

    expect(how).toBe("downloaded");
    expect(download).toHaveBeenCalledWith(blob, "a.png");
    // asked, not attempted: a share thrown and caught would also end in a download
    expect(share).not.toHaveBeenCalled();
  });

  it("falls back when the device CLAIMS it can share and then refuses", async () => {
    // Safari answers canShare(files) true and can still throw NotAllowedError, and a cancelled
    // share sheet throws AbortError — one is a failure to deliver, the other is you changing
    // your mind, and only the first should leave a file behind
    const download = vi.fn();
    const how = await deliver(blob, "a.png", {
      canShare: () => true,
      share: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
      download,
    });

    expect(how).toBe("downloaded");
    expect(download).toHaveBeenCalled();
  });

  it("says nothing was delivered when you cancel the sheet yourself", async () => {
    const download = vi.fn();
    const how = await deliver(blob, "a.png", {
      canShare: () => true,
      share: () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })),
      download,
    });

    expect(how).toBe("cancelled");
    expect(download, "a cancelled share must not leave a file behind").not.toHaveBeenCalled();
  });
});
