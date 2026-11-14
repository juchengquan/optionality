/** "Copy as text" (#394): the saved picture's table as Markdown, on the clipboard.
 *
 *  The text is `toMarkdown(plainView(…))`, the same view the picture draws (`Still.tsx`), so the two
 *  say the same rows in the same words. It is built and handed to the clipboard inside the press
 *  itself, with nothing awaited first: Safari grants the clipboard only to a write a user's gesture
 *  is still running.
 *
 *  Never silence, as the picture's press: a "copied" where it was copied, and the reason where the
 *  browser refused — no clipboard at all outside a secure page, or a write it turned down.
 */
import { toast } from "@/components/ui/toast";
import { plainView, toMarkdown, type PlainInput } from "./plain";

/** What the toast says when the text is on the clipboard. */
export const COPIED = "copied as text";

/** What it says when the browser would not take it, before the browser's own reason. */
export const REFUSED = "could not copy — the browser refused the clipboard";

/** The platform's clipboard, injected so the refusals can be tested. */
type Clipboard = Pick<globalThis.Clipboard, "writeText">;

export async function copyView(
  input: PlainInput, clipboard: Clipboard | undefined = navigator.clipboard,
): Promise<boolean> {
  const text = toMarkdown(plainView(input));
  try {
    if (!clipboard) throw new Error("there is no clipboard on this page");
    await clipboard.writeText(text);
  } catch (e: unknown) {
    // a refusal is a DOMException, which is not an Error everywhere: its message is read as text
    const message = (e as { message?: unknown } | null)?.message;
    const why = typeof message === "string" && message ? ` (${message})` : "";
    toast.add({ title: `${REFUSED}${why}`, type: "error" });
    return false;
  }
  toast.add({ title: COPIED, type: "success" });
  return true;
}
