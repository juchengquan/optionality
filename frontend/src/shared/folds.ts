/** A press on a fold, as the book's expiry groups (`../folds.ts`) and the account page's sections
 *  (`../account/folds.ts`) both apply it. Here, apart from either, because the account page took it
 *  from the book's module and with it the book's columns, needs and forms: most of the book's code
 *  was in the files the account page downloads (review of #485). */

/** The folds after `key` is pressed, from the folds as stored NOW: the key folded or opened as THIS
 *  tab wants it — the opposite of what it shows, never a flip of the cookie, which another tab may
 *  have changed under it — the other keys kept, and, given the groups the page draws, every fold the
 *  page no longer has dropped. */
export function pressed(stored: ReadonlySet<string>, key: string, fold: boolean,
                        drawn: ReadonlySet<string> | null): Set<string> {
  const next = new Set(stored);
  if (fold) next.add(key); else next.delete(key);
  return drawn === null ? next : new Set([...next].filter((k) => drawn.has(k)));
}
