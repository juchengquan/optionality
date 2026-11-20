/** A row's attention as a chip, one drawing for the desk's table, its inspector and the phone's sheet
 *  (review of #420: the sheet drew a Level's chip and no Manage-by, the inspector both). A rule's state
 *  is the attention family's chip (Book.tsx's `Chip`); a holding's Level and its Manage-by are drawn as
 *  the needs-you line draws them, with their kinds' glyphs — in the words `chipWords` gives the row,
 *  which outside the session say which valuation they are from (#354). */
import { Chip } from "./Book";
import { Glyph } from "./NeedsLine";
import { ATTENTION_WORDS, type attentionOf } from "./desk/columns";

export function AttentionChip({ kind, words }: {
  kind: NonNullable<ReturnType<typeof attentionOf>>; words?: string | null;
}) {
  if (kind === "fault" || kind === "entry" || kind === "alarm") return <Chip state={kind} words={words ?? undefined} />;
  return (
    <span className="nx-chip" data-kind={kind}>
      <Glyph kind={kind} />{words ?? ATTENTION_WORDS[kind]}
    </span>
  );
}
