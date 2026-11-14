/** What a leg IS, written (#391, ADR 0023's fourth colour family): every place that writes a leg
 *  draws it through `shared/Legs.tsx`, which marks its type letter for the type's colour and a
 *  short leg for weight, and writes exactly the characters the place wrote before — the colour is
 *  never the only signal, so the letter and the sign stay. The colours themselves are the browser
 *  suite's (`__browser__/NextLegColours.test.tsx`): jsdom computes no custom property. */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { legText } from "../shared/format";
import { Leg, Legs, SvgLeg } from "../shared/Legs";
import { legMarks } from "../testing/legs";

const CONDOR = [
  { short: false, option_type: "PUT", strike: 6250 }, { short: true, option_type: "PUT", strike: 6300, qty: 2 },
  { short: true, option_type: "CALL", strike: 7400 }, { short: false, option_type: "CALL", strike: 7450 },
];

describe("a leg's text", () => {
  it("is the book's, in each of the four ways the page writes one", () => {
    expect(CONDOR.map((l) => legText(l, "signs"))).toEqual(["+P6250", "-2P6300", "-C7400", "+C7450"]);
    expect(CONDOR.map((l) => legText(l, "minus"))).toEqual(["+P6250", "−2P6300", "−C7400", "+C7450"]);
    expect(CONDOR.map((l) => legText(l, "words"))).toEqual(["long PUT 6250", "short 2× PUT 6300", "short CALL 7400", "long CALL 7450"]);
    expect(CONDOR.map((l) => legText(l, "name"))).toEqual(["P6250", "P6300", "C7400", "C7450"]);
  });

  it("writes a rule's lone contract, which has no side, with no sign", () => {
    expect(legText({ option_type: "PUT", strike: 7150 }, "signs")).toBe("P7150");
  });
});

describe("a leg drawn", () => {
  it("writes the same characters, its type letter marked and its side said", () => {
    const { container } = render(<p><Legs legs={CONDOR} /></p>);
    expect(container.textContent).toBe("+P6250 -2P6300 -C7400 +C7450");
    expect(legMarks(container)).toEqual(["+P6250 long PUT", "-2P6300 short PUT", "-C7400 short CALL", "+C7450 long CALL"]);
  });

  it("marks the whole type word in the inspector's words", () => {
    const { container } = render(<p><Legs legs={CONDOR.slice(1, 3)} form="words" /></p>);
    expect(container.textContent).toBe("short 2× PUT 6300 short CALL 7400");
    expect(legMarks(container)).toEqual(["short 2× PUT 6300 short PUT", "short CALL 7400 short CALL"]);
  });

  it("names a lone contract, and a short strike, with the letter marked", () => {
    const { container } = render(<p><Legs legs={[{ option_type: "CALL", strike: 7300 }]} /> <Leg leg={{ short: true, option_type: "PUT", strike: 6400, qty: 2 }} form="name" /></p>);
    expect(container.textContent).toBe("C7300 P6400");
    expect(legMarks(container)).toEqual(["C7300 - CALL", "P6400 short PUT"]);
  });

  it("draws the same inside a chart, as SVG text", () => {
    const { container } = render(<svg><SvgLeg leg={CONDOR[1]!} form="minus" x={1} y={2} /></svg>);
    const text = container.querySelector("text")!;
    expect(text.textContent).toBe("−2P6300");
    expect(legMarks(container)).toEqual(["−2P6300 short PUT"]);
  });
});
