import type { Entry } from "./shared/api";
import { sentence, shortSentence } from "./needs";

/** A rule drawn in its short form (#388), with the sentence it stands for as its title and as what
 *  a reader hears — the pace gap's pattern (#379): the short text is hidden from a screen reader,
 *  which reads the sentence instead, and a pointer sees the sentence on hover. The short text keeps
 *  its spaces (`.nx-rule-short`), which separate the rule, the figure and the distance. */
export function ShortWords({ short, full }: { short: string; full: string }) {
  // where the short form IS the sentence (a draft's, typed as it is drawn) it is written once: a copy
  // for a reader beside it was the same words twice to anything reading the page's text (2026-11-16)
  if (short === full) return <span className="nx-rule-short">{short}</span>;
  return (
    <>
      <span className="sr-only">{full}</span>
      <span className="nx-rule-short" title={full} aria-hidden="true">{short}</span>
    </>
  );
}

/** A served rule's line: `shortSentence`, said as `sentence`. */
export function RuleWords({ entry }: { entry: Entry }) {
  return <ShortWords short={shortSentence(entry)} full={sentence(entry)} />;
}
