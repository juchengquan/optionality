/** What the redesigned page's "save as image" suites share (#300): the share sheet stood in for,
 *  the PNG decoded back into pixels, and the off-screen tree read while it is up.
 *
 *  Not test support for the service: plain browser helpers, like `nextBook.ts` beside it. */

/** Take the share sheet's place, so the File the device would have received is the File asserted
 *  on. The sheet stays "open" until `release` — the stage is up exactly that long, so everything
 *  measured about the tree that was painted is measured while it is still there, not raced. */
export function catchShare(): { file: () => File | null; release: () => void; shares: () => number } {
  let caught: File | null = null;
  let count = 0;
  let open: (() => void) | null = null;
  let released = false;
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  Object.defineProperty(navigator, "share", {
    value: (data: { files: File[] }) => {
      caught = data.files[0]!;
      count += 1;
      return released ? Promise.resolve() : new Promise<void>((done) => { open = done; });
    },
    configurable: true,
  });
  return {
    file: () => caught,
    shares: () => count,
    release: () => { released = true; open?.(); },
  };
}

/** The share sheet put back as the browser has it: none. */
export function forgetShare(): void {
  Reflect.deleteProperty(navigator, "canShare");
  Reflect.deleteProperty(navigator, "share");
}

export interface Pixels {
  w: number;
  h: number;
  /** "r,g,b,a" at a pixel of the image */
  at: (x: number, y: number) => string;
}

/** The PNG, decoded. A file that is merely non-empty proves nothing: a blank image of the right
 *  size is the exact failure being hunted. Every URL made here is revoked before it returns. */
export async function decode(file: File): Promise<Pixels> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((done, fail) => {
      img.onload = done;
      img.onerror = () => fail(new Error("the PNG did not decode"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return {
      w: img.naturalWidth,
      h: img.naturalHeight,
      at: (x, y) => {
        const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return `${d[0]},${d[1]},${d[2]},${d[3]}`;
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The tree being photographed, while it is up. */
export const still = () => document.querySelector<HTMLElement>(".nx-still-stage .nx-still");

/** Where an element of the picture lands in the image: its centre, or a point `dx` in from its
 *  left edge, in the image's own pixels. Read from the tree as it is laid out on the stage. */
export function placeIn(root: HTMLElement, el: Element, ratio: number, dx?: number): [number, number] {
  const box = root.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const x = dx === undefined ? r.left + r.width / 2 : r.left + dx;
  return [(x - box.left) * ratio, (r.top + r.height / 2 - box.top) * ratio];
}

/** Every control a picture must not carry: nothing in a still image can be pressed. */
export const CONTROLS = "button, input, select, textarea, a[href], summary, details, [role=button], "
  + "[role=dialog], [tabindex], .nxd-inspector, [data-slot=sheet-content]";
