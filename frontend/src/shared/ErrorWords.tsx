/** An error said in plain words, with what was actually thrown or served one tap away (the owner's
 *  standard, part N; review of #420): a "details" disclosure beside the words, which a finger, a
 *  keyboard and a screen reader reach as well as a pointer — where a `title` alone reached a pointer.
 *  Nothing is disclosed where the plain words ARE the raw text (a service's own refusal).
 *
 *  Drawn inline, so it sits in the sentence it ends; its container must therefore be a `div` or a
 *  `span` that may hold a `details`, never a `p`. */
import { plainWords } from "./errors";

export function ErrorWords({ raw, again, vendor = null }: {
  /** what was thrown or served, as it was */
  raw: string;
  /** how a retry is said where one helps (`plainWords`) */
  again?: string;
  vendor?: string | null;
}) {
  const plain = plainWords(raw, again, vendor);
  return <>{plain}<RawDetails plain={plain} raw={raw} /></>;
}

/** The raw text behind words already made plain (a served reason, `api.ts`), disclosed where it
 *  differs from them. */
export function RawDetails({ plain, raw }: { plain: string; raw: string | null | undefined }) {
  if (!raw || raw.trim() === plain.trim()) return null;
  return (
    <details className="nx-raw" data-raw="">
      <summary>details</summary>
      <code>{raw}</code>
    </details>
  );
}
