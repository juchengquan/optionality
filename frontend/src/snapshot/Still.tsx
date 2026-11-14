/** The page as it goes into the saved image (#300, #394): a SECOND React tree, mounted off screen
 *  only while the picture is taken.
 *
 *  Not a copy of the screen, and that is the design. Since #394 it is ONE plain table, whichever
 *  arrangement the press came from — the desk's or the phone's — drawn from `plainView`, the same
 *  builder "Copy as text" writes its Markdown from, so the picture and the text cannot disagree.
 *  A header block says what the table is (when it was taken, the session, how fresh the figures
 *  are, the References, what needs you); under it, a table per section with every column the viewer
 *  ticked, whatever the room on screen, and a status column in words.
 *
 *  Words and numbers only, dark on a light ground in a monospace face: no chip, no fill bar, no
 *  condor bracket, no colour for a leg's type (#391) or a figure's outcome, and no symbol shorthand
 *  for a rule (#388's short form is the screen's). Nothing in it can be pressed. Privacy goes in
 *  with the figures: every cell is the text the screen draws with the same setting.
 */
import "./still.css";
import { plainView, type PlainInput, type PlainView } from "./plain";
import { STILL } from "./useSaveImage";

export type StillProps = PlainInput;

export function Still(props: StillProps) {
  return <StillView view={plainView(props)} />;
}

function StillView({ view }: { view: PlainView }) {
  const width = view.columns.length;
  return (
    <div className={STILL}>
      <h1>{view.title}</h1>
      <dl className="nx-still-lines">
        {view.lines.map((l) => (
          <div key={l.label}><dt>{`${l.label}:`}</dt><dd>{l.text}</dd></div>
        ))}
      </dl>
      {view.sections.map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          {s.notes.map((n) => <p key={n}>{n}</p>)}
          {s.groups.length > 0 ? (
            <table>
              <thead>
                <tr>{view.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
              </thead>
              <tbody>
                {s.groups.flatMap((g, gi) => [
                  ...(g.heading !== null
                    ? [<tr key={`g${gi}`} data-group=""><th colSpan={width} scope="colgroup">{g.heading}</th></tr>]
                    : []),
                  ...g.rows.map((r, ri) => (
                    <tr key={`${gi}:${ri}`}>{r.map((cell, ci) => <td key={view.columns[ci]}>{cell}</td>)}</tr>
                  )),
                ])}
              </tbody>
            </table>
          ) : null}
        </section>
      ))}
    </div>
  );
}
