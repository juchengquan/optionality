import { Book, type BookProps } from "../Book";

/** The desk's book, arrangement A: the terminal table, its inspector and REVIEW's columns (#289).
 *  A stub until then — the plain list — so the two arrangements can be built side by side, each in
 *  its own directory. */
export function DeskBook(props: BookProps) {
  return <Book {...props} />;
}
