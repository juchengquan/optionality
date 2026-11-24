/** Which page the path names (#471): the account at `account` after the bundle's base, the book
 *  everywhere else (`pages.ts`). No router: two pages, reached from each other by plain links, so
 *  moving between them loads the other afresh — and whatever the one left was polling stops with
 *  it. Still one entry, `index.html`: Caddy sends every unknown path under the base there
 *  (`deploy/Caddyfile`). */
import { Account } from "./account/Account";
import { Next } from "./Next";
import { pageAt } from "./pages";

export { pageAt } from "./pages";

export function Page({ path = window.location.pathname, base = import.meta.env.BASE_URL }: {
  path?: string; base?: string;
}) {
  return pageAt(path, base) === "account" ? <Account base={base} /> : <Next base={base} />;
}
