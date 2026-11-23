/** The dashboard's two pages and where each is (#471): the book at the bundle's base (`BASE_URL`,
 *  `/opt/`), the IBKR account at `account` under it. Pure, so the book's header and the account
 *  page link to each other without either importing the other. */

export type PageName = "account" | "book";

const rooted = (base: string) => (base.endsWith("/") ? base : `${base}/`);

/** The page at `path` under `base`: `account` for `/opt/account`, with or without its slash, and
 *  the book for anything else — an unknown path falls through to the book, as it always has. */
export function pageAt(path: string, base: string): PageName {
  const root = rooted(base);
  if (!path.startsWith(root)) return "book";
  return /^account\/?$/.test(path.slice(root.length)) ? "account" : "book";
}

/** Where the account page is, under `base`. */
export const accountHref = (base: string) => `${rooted(base)}account`;
/** Where the book is, under `base`. */
export const bookHref = (base: string) => rooted(base);
