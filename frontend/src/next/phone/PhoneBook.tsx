import { Book, type BookProps } from "../Book";

/** The phone's book, arrangement B: cards, the detail sheet and REVIEW's one holding per screen
 *  (#290). A stub until then — the plain list — so the two arrangements can be built side by side,
 *  each in its own directory. */
export function PhoneBook(props: BookProps) {
  return <Book {...props} />;
}
