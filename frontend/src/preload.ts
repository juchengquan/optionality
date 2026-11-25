/** What `index.html` asks for before any module has arrived (#483): the code and styles of the
 *  page its path names, and nothing of the other's.
 *
 *  Each page is a chunk of its own (`Page.tsx`), and a chunk asked for by a module is asked for only
 *  once that module and the libraries under it have arrived and run — after every byte of them. On
 *  a link that adds 330 ms to each round trip that turned the cold load slower than the one bundle
 *  it replaced (measured: 1.12 s to 1.48 s at 5 Mbps). So the build writes this into the HTML as a
 *  plain script, which runs while the HTML is still being read and asks for the page's own files
 *  beside the libraries the HTML already names: one round trip, as before.
 *
 *  The page is chosen by `pageAt` itself, written in as text, so the HTML and `Page.tsx` cannot
 *  disagree about which page a path is. Scripts are asked for as `modulepreload` and styles as
 *  `preload`, both `crossorigin` as Vite asks for them, so when `Page.tsx`'s import does ask, Vite
 *  finds the script already asked for and the browser answers the stylesheet from what arrived. A
 *  style is NOT added as a stylesheet here: Vite adds it, and waits for it before the page draws,
 *  so nothing is drawn unstyled. */
import { pageAt, type PageName } from "./pages";

/** The files each page needs beyond what the HTML already names, as URLs under the base. */
export type PageFiles = Record<PageName, string[]>;

/** The script, as the text of an inline `<script>`. */
export function preloadScript(files: PageFiles, base: string): string {
  return `(${askFor.toString()})(${JSON.stringify(files)}, ${JSON.stringify(base)}, ${pageAt.toString()});`;
}

/** Runs in the browser, as text: everything it uses is an argument or the page's own globals. */
function askFor(files: PageFiles, base: string, page: typeof pageAt): void {
  for (const href of files[page(location.pathname, base)]) {
    const link = document.createElement("link");
    const style = href.endsWith(".css");
    link.rel = style ? "preload" : "modulepreload";
    if (style) link.setAttribute("as", "style");
    link.crossOrigin = "";
    link.href = href;
    document.head.appendChild(link);
  }
}
