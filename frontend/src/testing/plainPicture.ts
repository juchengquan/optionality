/** What the saved picture's suites measure of it since #394 — one plain table, the same from the
 *  desk and the phone — shared by `NextSnapshot.test.tsx` and its iPhone twin, so the two measure
 *  one picture one way. Browser helpers, beside the reader they share with the jsdom suite. */
import { plainView } from "../snapshot/plain";
import { HOLDINGS, MONITORS, QUOTES } from "./ownerBook";
import type { ReadView } from "./plainRead";

/** The picture's ground in the decoded PNG: white, opaque. */
export const PLAIN_GROUND = "255,255,255,255";

/** The smallest type the picture may set, in CSS pixels: legible at its width. */
const SMALLEST_PX = 12;

/** Everything the screen draws and the picture must not: a chip, a fill or progress bar, a condor's
 *  bracket, a leg drawn in its type's colour (#391), an outcome colour, a glyph or any graphic. */
const DRAWINGS = ".nx-chip, .nxd-bracket, .nx-leg, [data-type], [data-outcome], "
  + "svg, img, canvas, [role=meter], [role=progressbar]";

const describe = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").slice(0, 40)}"`;
/** whether an element draws text of its own, rather than only holding elements that do */
const hasText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== "");

/** The picture as laid out on the stage, measured: each list names what breaks the rule, so an
 *  empty one is a pass and a failure says where. */
export function measurePlain(root: HTMLElement) {
  const all = [root, ...root.querySelectorAll<HTMLElement>("*")];
  const ground = getComputedStyle(root).backgroundColor;
  const ink = getComputedStyle(root).color;
  const box = root.getBoundingClientRect();
  return {
    // one ground: the picture's own, white, and nothing painted over it
    grounds: [
      ...(ground === "rgb(255, 255, 255)" ? [] : [`the picture's ground is ${ground}`]),
      ...all.slice(1).filter((el) => {
        const bg = getComputedStyle(el).backgroundColor;
        return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && bg !== ground;
      }).map((el) => `${describe(el)}: ${getComputedStyle(el).backgroundColor}`),
    ],
    // one ink, near black: nothing said by colour
    inks: [
      ...(ink === "rgb(17, 17, 17)" ? [] : [`the picture's ink is ${ink}`]),
      ...all.filter(hasText).filter((el) => getComputedStyle(el).color !== ink)
        .map((el) => `${describe(el)}: ${getComputedStyle(el).color}`),
    ],
    drawn: [...root.querySelectorAll(DRAWINGS)].map(describe),
    // nothing made faint or invisible: a table of words nobody can see measures as well as any other
    hidden: all.filter((el) => {
      const cs = getComputedStyle(el);
      return cs.opacity !== "1" || cs.visibility !== "visible" || cs.display === "none";
    }).map(describe),
    small: all.filter(hasText).filter((el) => parseFloat(getComputedStyle(el).fontSize) < SMALLEST_PX)
      .map((el) => `${describe(el)}: ${getComputedStyle(el).fontSize}`),
    // nothing cut short in its box, and nothing past the picture's edge
    clipped: all.filter(hasText).filter((el) => {
      const r = el.getBoundingClientRect();
      return el.scrollWidth > el.clientWidth + 1 || r.right > box.right + 0.5 || r.left < box.left - 0.5;
    }).map(describe),
  };
}

/** A decoded image, as `__browser__/picture.ts`'s `decode` gives it: "r,g,b,a" at a pixel. */
interface Pixels { w: number; h: number; at: (x: number, y: number) => string }

/** Whether the image has ink inside an element's box: some pixel there that is dark — the words, as
 *  painted. The tree's measurements say what was laid out; only the pixels say it reached the file. */
export function inkIn(png: Pixels, root: HTMLElement, el: Element): boolean {
  const ratio = png.w / root.scrollWidth;
  const box = root.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  for (let y = r.top + 1; y < r.bottom - 1; y += 1) {
    for (let x = r.left + 1; x < r.right - 1; x += 1) {
      const [red, green, blue, alpha] = png.at((x - box.left) * ratio, (y - box.top) * ratio).split(",").map(Number);
      if (alpha! > 200 && red! < 96 && green! < 96 && blue! < 96) return true;
    }
  }
  return false;
}

/** The table the owner's book makes in session with every column ticked, read as `readPicture`
 *  reads the picture: what the picture must draw from the desk AND from the phone. */
export function bookTable(): ReadView["sections"] {
  const view = plainView({
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null, session: true,
    privacy: false, needs: [], health: null, polledAt: null, error: null, references: [], hidden: new Set(),
    takenAt: new Date(),
  });
  return view.sections.map((s) => ({
    title: s.title, notes: s.notes,
    rows: s.groups.length === 0 ? [] : [s.columns, ...s.groups.flatMap((g) => [
      ...(g.heading === null ? [] : [[g.heading, ...s.columns.slice(1).map(() => "")]]), ...g.rows,
    ])],
  }));
}
