/** The saved view read back (#394): the picture's tree and the copied Markdown, each into the same
 *  shape, so a suite can hold the two to each other. Two readers written apart from the code that
 *  writes them — the picture's from the DOM as drawn, the text's from the Markdown as a reader of
 *  it would split it — so a writer that drops, adds or rewords a cell on one side is caught. */

export interface ReadView {
  title: string;
  lines: { label: string; text: string }[];
  sections: { title: string; notes: string[]; rows: string[][] }[];
}

const text = (el: Element | null | undefined) => el?.textContent ?? "";

/** The picture's tree as drawn: its heading, its header block's "label:" and words, and each
 *  section's notes and table rows — a heading row spanning the table read as its words then blanks,
 *  as the Markdown writes it. */
export function readPicture(root: Element): ReadView {
  return {
    title: text(root.querySelector("h1")),
    lines: [...root.querySelectorAll(".nx-still-lines > div")].map((d) => ({
      label: text(d.querySelector("dt")).replace(/:$/, ""), text: text(d.querySelector("dd")),
    })),
    sections: [...root.querySelectorAll("section")].map((s) => ({
      title: text(s.querySelector("h2")),
      notes: [...s.querySelectorAll(":scope > p")].map(text),
      rows: [...s.querySelectorAll("tr")].map((tr) => [...tr.children].flatMap((c) =>
        [text(c), ...Array.from({ length: ((c as HTMLTableCellElement).colSpan || 1) - 1 }, () => "")])),
    })),
  };
}

/** A Markdown table row's cells: split on every pipe that is not escaped, then unescaped. */
function cellsOf(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const body = line.trim().replace(/^\|/, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && i + 1 < body.length) { cell += body[++i]; continue; }
    if (ch === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += ch;
  }
  return cells;
}

/** Markdown's backslash escapes undone: `\|` is `|`, `\*` is `*`. */
const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

/** The copied Markdown, read as a reader of it would: "# title", "- label: words", "## section",
 *  a table's rows (its delimiter row skipped), and any other line a note of its section. */
export function readMarkdown(md: string): ReadView {
  const out: ReadView = { title: "", lines: [], sections: [] };
  for (const line of md.split("\n")) {
    const section = out.sections.at(-1);
    if (line.trim() === "") continue;
    if (line.startsWith("## ")) out.sections.push({ title: line.slice(3), notes: [], rows: [] });
    else if (line.startsWith("# ")) out.title = line.slice(2);
    else if (line.startsWith("- ") && !section) {
      const at = line.indexOf(": ");
      out.lines.push({ label: line.slice(2, at), text: unescape(line.slice(at + 2)) });
    } else if (line.startsWith("|")) {
      const cells = cellsOf(line);
      if (cells.every((c) => /^-{3,}$/.test(c))) continue;
      section!.rows.push(cells);
    } else section!.notes.push(unescape(line));
  }
  return out;
}
