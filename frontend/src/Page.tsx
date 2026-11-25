/** Which page the path names (#471): the account at `account` after the bundle's base, the book
 *  everywhere else (`pages.ts`). No router: two pages, reached from each other by plain links, so
 *  moving between them loads the other afresh — and whatever the one left was polling stops with
 *  it. Still one entry, `index.html`: Caddy sends every unknown path under the base there
 *  (`deploy/Caddyfile`).
 *
 *  Each page is its own code, loaded only when the path names it (#483): the book never downloads
 *  the account page's and the account page never the book's. While it arrives nothing is drawn — on
 *  a fast link a word there would only flash. A page whose code cannot be fetched (a deploy replaced
 *  it mid-visit) is thrown here, so `PageBoundary` says so and offers the reload that fetches the new
 *  HTML, rather than leaving a blank screen. `index.html` asks for the page's files before this runs
 *  (`preload.ts`), so by the time this asks they are usually there.
 *
 *  Loaded by hand rather than by `React.lazy`: a page `lazy` suspends is revealed no sooner than
 *  300 ms after its Suspense fallback, React's own throttle, and that alone put 0.3 s between the
 *  last byte and the first draw on every load (measured). */
import { useEffect, useState, type ComponentType } from "react";

import { pageAt, type PageName } from "./pages";

export { pageAt } from "./pages";

type PageComponent = ComponentType<{ base: string }>;

/** Each page's code, as a chunk of its own. `vite.config.ts` names these same modules. */
const LOADERS: Record<PageName, () => Promise<PageComponent>> = {
  account: () => import("./account/Account").then((m) => m.Account),
  book: () => import("./Next").then((m) => m.Next),
};

/** Each page asked for once, however often it is drawn: StrictMode runs the effect below twice. */
const loading = new Map<PageName, Promise<PageComponent>>();
const load = (name: PageName) => {
  if (!loading.has(name)) loading.set(name, LOADERS[name]());
  return loading.get(name)!;
};

type Loaded = { name: PageName; Shown: PageComponent } | { name: PageName; error: unknown };

export function Page({ path = window.location.pathname, base = import.meta.env.BASE_URL }: {
  path?: string; base?: string;
}) {
  const name = pageAt(path, base);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    load(name).then(
      (Shown) => { if (live) setLoaded({ name, Shown }); },
      (error: unknown) => { if (live) setLoaded({ name, error }); },
    );
    return () => { live = false; };
  }, [name]);
  if (loaded === null || loaded.name !== name) return null;
  if ("error" in loaded) throw loaded.error;
  return <loaded.Shown base={base} />;
}
