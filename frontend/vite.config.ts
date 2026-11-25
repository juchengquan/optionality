import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type Rollup } from "vite";

import type { PageName } from "./src/pages";
import { preloadScript, type PageFiles } from "./src/preload";

/** Each page's module, as `src/Page.tsx` imports it lazily. A module here that is no chunk of its
 *  own fails the build, so the two cannot drift apart unnoticed. */
const PAGE_MODULES: Record<PageName, string> = { account: "src/account/Account.tsx", book: "src/Next.tsx" };

/** Writes `preload.ts`' script into `index.html` (#483): the files each page needs beyond what the
 *  HTML already names — its own chunk, the chunks under it and their styles — so the page's code is
 *  asked for beside the libraries rather than after them. */
function preloadEachPage(): Plugin {
  let root = "", base = "/";
  return {
    name: "optionality:preload-each-page",
    apply: "build",
    configResolved(config) { root = config.root; base = config.base; },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle, chunk }) {
        if (!bundle || !chunk) throw new Error("preload-each-page: no bundle to read the pages' files from");
        const chunkAt = (file: string) => bundle[file] as Rollup.OutputChunk;
        const under = (c: Rollup.OutputChunk, seen = new Set<string>()): Set<string> => {
          if (seen.has(c.fileName)) return seen;
          seen.add(c.fileName);
          for (const file of c.imports) under(chunkAt(file), seen);
          return seen;
        };
        const styles = (files: Iterable<string>) => [...files].flatMap((f) => [...(chunkAt(f).viteMetadata?.importedCss ?? [])]);
        // what the HTML names already: the entry, the chunks it imports and their styles
        const named = under(chunk);
        const namedStyles = new Set(styles(named));
        const filesOf = (module: string): string[] => {
          const page = Object.values(bundle).find((c): c is Rollup.OutputChunk =>
            c.type === "chunk" && c.isDynamicEntry && c.facadeModuleId === resolve(root, module));
          if (!page) throw new Error(`preload-each-page: ${module} is no chunk of its own, but Page.tsx loads it as one`);
          const own = [...under(page)].filter((f) => !named.has(f));
          const ownStyles = [...new Set(styles(under(page)))].filter((f) => !namedStyles.has(f));
          return [...own, ...ownStyles].map((f) => `${base}${f}`);
        };
        const files = Object.fromEntries(Object.entries(PAGE_MODULES).map(([name, module]) => [name, filesOf(module)]));
        return [{ tag: "script", children: preloadScript(files as PageFiles, base), injectTo: "head" }];
      },
    },
  };
}


// `base` is absolute, not relative, and that is deliberate. `tailscale serve --set-path`
// strips the prefix before proxying and does not rewrite redirects, so the page cannot learn
// its own prefix at runtime, and a visitor who omits the trailing slash would resolve
// "./assets/main.js" against the tailnet root. UI_BASE in the Makefile is the one knob;
// api.ts locates the API from this same value.
/** Which chunk a module goes in, where Rollup is not left to decide (#483).
 *
 *  `libraries`: everything from `node_modules`, in a file of its own named by its content alone, so
 *  a deploy that changes only the page's own code leaves that name — and the phone's cached copy —
 *  as it was. Its content is the library code the pages USE, in the order they reach it, so the
 *  name also moves when the pages change how they import library code: a library export used or
 *  dropped (a new lucide-react icon), or two imports reordered so the libraries are reached in
 *  another order (Next.tsx's sheet and toast imports swapped). An edit that changes neither moves
 *  nothing (measured, review of #485). Rollup's helpers (`\0`, the dynamic-import preload among them) go with them: a
 *  library that imported one from a chunk of page code would take that chunk's hash into its own.
 *
 *  `shell`: the page's own code the entry needs before either page — `PageBoundary`, `pages.ts` and
 *  what they import — but not `main.tsx` or `Page.tsx`. Left to Rollup, it went in the entry, and
 *  both pages' chunks imported the entry for it; but the entry names each page's chunk, so its name
 *  moved with either page's, and with it every chunk importing it: a change to the account page
 *  alone renamed the book's chunks too, and the phone downloaded the unchanged book again. */
function chunkOf(id: string, { getModuleInfo }: Rollup.ManualChunkMeta): string | undefined {
  if (id.includes("/node_modules/") || id.startsWith("\0")) return "libraries";
  const entry = fileURLToPath(new URL("./src/main.tsx", import.meta.url));
  const page = fileURLToPath(new URL("./src/Page.tsx", import.meta.url));
  if (id === entry || id === page) return undefined;
  const shell = new Set<string>();
  const walk = (at: string) => {
    if (shell.has(at)) return;
    shell.add(at);
    for (const next of getModuleInfo(at)?.importedIds ?? []) walk(next);
  };
  walk(entry);
  return shell.has(id) ? "shell" : undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadEachPage()],
  // "@/..." is how shadcn's components import each other; __dirname does not exist
  // in an ESM config, so the URL form is the one that works here
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  base: process.env.VITE_BASE || "/",
  // Built assets are still COMMITTED, now to frontend/dist and served by Caddy. Keeping node
  // off the deploy path mattered when one process served both; it matters more now, because
  // a failed build would leave Caddy with nothing at all to serve.
  //
  // ONE entry, the dashboard at `/opt`. A second, `next/index.html`, sent bookmarks of `/opt/next`
  // (where the redesign was built beside the old page, ADR 0023) on to `/opt/` from the swap (#301)
  // until #364 removed it; `/opt/next` now falls through to this page like any unknown path.
  build: {
    outDir: "dist", emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
      output: { manualChunks: chunkOf },
    },
  },
});
