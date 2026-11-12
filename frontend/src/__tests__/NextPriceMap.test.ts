/** The price map's model (#298, ADR 0023): every spread on the book — held and watched — in a lane
 *  per expiry on ONE SPX axis, SPX's derived price as the line through them, and a ±1σ band per
 *  lane from the width the service serves (`one_sigma`). Pure: what the panel draws is decided here,
 *  and the panel only places it. The drawing and its geometry are the browser suite's. */
import { describe, expect, it } from "vitest";

import type { Entry, Holding } from "../api";
import { placeBook } from "../next/placement";
import { bandWords, domainOf, priceMapOf, slotRows, spxOfBook, spxWords, ticksOf } from "../next/pricemap";
import { HOLDINGS, MONITORS, QUOTES, served } from "../testing/ownerBook";

const REASON = "the Provider gives no option premium to derive it from";
function bare<T extends Entry | Holding>(row: T): T {
  return {
    ...row, spx: null, spx_reason: REASON,
    short_strikes: row.short_strikes.map((s) => ({ ...s, points: null, sigma: null, one_sigma: null })),
  };
}

/** The watchlist's rows as one batch served at `at`: its single contracts carry the batch's stamp. */
const timed = (quotes: Entry[], spx: number, at: string): Entry[] => quotes.map((q) => ({
  ...q, spx, quote: q.legs ? q.quote : { ...(q.quote ?? {}), fetched_at: at },
}));

const mapOf = (quotes: Entry[] = QUOTES, holdings: Holding[] | null = HOLDINGS) =>
  priceMapOf(placeBook(quotes, holdings, MONITORS), spxOfBook(quotes, holdings));

describe("the lanes", () => {
  it("has a lane per expiry, the earliest first, holding every spread held and watched", () => {
    const map = mapOf();
    expect(map.lanes.map((l) => l.expiry)).toEqual(["2026-12-04", "2026-12-18", "2026-12-31"]);
    expect(map.lanes.map((l) => l.spreads.map((s) => [s.id, s.kind]))).toEqual([
      [["w-dec04", "watched"]],
      [["h-calls", "held"], ["h-puts", "held"], ["w-dec18", "watched"]],
      [["h-ic", "held"], ["w-dec31", "watched"]],
    ]);
  });

  it("leaves out a single contract — no spread — and a rule about something held, which its holding draws", () => {
    const ids = mapOf().lanes.flatMap((l) => l.spreads.map((s) => s.id));
    expect(ids).not.toContain("w-lone");
    expect(ids).not.toContain("w-dec18-delta");
    expect(ids).not.toContain("r-calls");
  });

  it("spans each spread from its lowest strike to its highest, with the short strikes as served", () => {
    const ic = mapOf().lanes[2]!.spreads.find((s) => s.id === "h-ic")!;
    expect([ic.lo, ic.hi]).toEqual([6250, 7450]);
    expect(ic.shorts.map((k) => k.strike)).toEqual([7400, 6300]);
    expect(ic.longs.map((k) => k.strike)).toEqual([7450, 6250]);
  });

  it("draws nothing while there is nothing to draw: no holdings valued and no spread watched", () => {
    expect(mapOf([], null).lanes).toEqual([]);
  });
});

describe("SPX's price", () => {
  it("is the book's derived price, as served on its rows", () => {
    expect(mapOf()).toMatchObject({ spx: 6900.5, reason: null });
  });

  it("is null with the service's reason where the batch could not give it — never zero", () => {
    const map = mapOf(QUOTES.map(bare), HOLDINGS.map(bare));
    expect(map.spx).toBeNull();
    expect(map.reason).toBe(REASON);
  });

  it("takes the holdings' figure when the watchlist's batch had none", () => {
    expect(spxOfBook(QUOTES.map(bare), HOLDINGS)).toMatchObject({ spx: 6900.5, reason: null, source: "holdings" });
    expect(spxOfBook([], null)).toEqual({
      spx: null, reason: "nothing on the book to derive it from", source: null, at: null,
    });
  });

  it("takes the figure of the batch served most recently, by its own fetched_at", () => {
    const [older, newer] = ["2026-11-10 23:14:05+08:00", "2026-11-10 23:14:35+08:00"];
    const quotes = timed(QUOTES, 6900.5, older);
    const holdings = HOLDINGS.map((h) => ({ ...h, spx: 6911.25, fetched_at: newer }));
    expect(spxOfBook(quotes, holdings)).toEqual({ spx: 6911.25, reason: null, source: "holdings", at: newer });
    expect(spxOfBook(timed(QUOTES, 6900.5, newer), holdings.map((h) => ({ ...h, fetched_at: older }))))
      .toEqual({ spx: 6900.5, reason: null, source: "watchlist", at: newer });
  });

  it("says which batch the line is, and when; in REVIEW, as last valued", () => {
    const at = "2026-11-10 23:14:35+08:00";
    const line = { spx: 6911.25, reason: null, source: "holdings" as const, at };
    expect(spxWords(line, "live")).toBe("SPX 6911.25 · from the holdings' batch, 23:14:35");
    expect(spxWords({ ...line, source: "watchlist" }, "live")).toBe("SPX 6911.25 · from the watchlist's batch, 23:14:35");
    expect(spxWords(line, "review")).toBe("SPX 6911.25 · as last valued, 23:14:35");
    expect(spxWords({ ...line, at: null }, "live")).toBe("SPX 6911.25 · from the holdings' batch");
    expect(spxWords({ spx: null, reason: REASON, source: null, at: null }, "live")).toBe(`SPX — ${REASON}`);
  });
});

describe("the ±1σ band", () => {
  it("is the served one σ of the lane's short strike nearest SPX, about SPX", () => {
    const [dec04, dec18, dec31] = mapOf().lanes;
    // the 18 Dec lane: the watched put at 7150 is 249.50 past, nearer than 7300 (399.50) or 6400
    expect(dec18!.band!.strike.code).toBe("US.SPXW261218P7150000");
    const width = dec18!.band!.strike.one_sigma!;
    expect(width).toBeGreaterThan(0);
    expect([dec18!.band!.lo, dec18!.band!.hi]).toEqual([6900.5 - width, 6900.5 + width]);
    expect(dec04!.band!.strike.strike).toBe(6900);
    expect(dec31!.band!.strike.strike).toBe(7400);
  });

  it("is never worked out in the browser: a lane whose short strikes carry no one σ has none, and says why", () => {
    const noIv = (r: Holding) => ({ ...r, short_strikes: r.short_strikes.map((s) => ({ ...s, one_sigma: null })) });
    const quotes = QUOTES.map((q) => ({ ...q, short_strikes: q.short_strikes.map((s) => ({ ...s, one_sigma: null })) }));
    const map = mapOf(quotes, HOLDINGS.map(noIv));
    for (const lane of map.lanes) {
      expect(lane.band).toBeNull();
      expect(lane.bandWhy).toBe("no ±1σ: no IV served");
    }
  });

  it("is not drawn without SPX's price, and the lane says why", () => {
    const map = mapOf(QUOTES.map(bare), HOLDINGS.map(bare));
    expect(map.lanes.every((l) => l.band === null && l.bandWhy === "no ±1σ without SPX")).toBe(true);
  });

  it("picks the short strike nearest SPX by DISTANCE, a strike already passed included", () => {
    // 7150 is 249.50 past (points −249.50); 6950 is 50 short of it (points +50): the nearest is 6950,
    // where a signed comparison would pick the strike already passed
    const near = { ...QUOTES.find((q) => q.id === "w-dec18")!, id: "w-near", code: "1218_P6950",
      legs: [{ sign: -1, option_type: "PUT", strike: 6850 }, { sign: 1, option_type: "PUT", strike: 6800 }],
      short_strikes: [served("2026-12-18", "PUT", 6850, -0.4, 38)] } as Entry;
    const lane = mapOf([...QUOTES, near]).lanes[1]!;
    expect(lane.band!.strike.strike).toBe(6850);
  });

  it("is centred on the SPX of the batch its one σ came from", () => {
    // the holdings valued at another instant than the watchlist: the 18 Dec lane's nearest short
    // strike is the held call at 7300 once the watched put is gone
    const holdings = HOLDINGS.map((h) => ({ ...h, spx: 6911.25 }));
    const quotes = QUOTES.filter((q) => q.id !== "w-dec18" && q.id !== "w-dec18-delta");
    const lane = mapOf(quotes, holdings).lanes.find((l) => l.expiry === "2026-12-18")!;
    expect(lane.band!.strike.code).toBe("US.SPXW261218C7300000");
    const w = lane.band!.strike.one_sigma!;
    expect([lane.band!.lo, lane.band!.hi]).toEqual([6911.25 - w, 6911.25 + w]);
  });

  it("has none on the expiry day, and says so rather than blaming the IV", () => {
    const today = QUOTES.map((q) => ({ ...q, dte: 0,
      short_strikes: q.short_strikes.map((s) => ({ ...s, sigma: null, one_sigma: null })) }));
    const lanes = mapOf(today, HOLDINGS.map((h) => ({ ...h, dte: 0,
      short_strikes: h.short_strikes.map((s) => ({ ...s, sigma: null, one_sigma: null })) }))).lanes;
    expect(lanes.map((l) => l.bandWhy)).toEqual(lanes.map(() => "no ±1σ: expiry day"));
  });

  it("says its width and whose IV it is", () => {
    const lane = mapOf().lanes[1]!;
    expect(bandWords(lane)).toBe(`±1σ ${lane.band!.strike.one_sigma!.toFixed(0)} pts · P7150's IV`);
  });
});

describe("the axis", () => {
  it("covers every strike, SPX and every band, padded", () => {
    const map = mapOf();
    const [lo, hi] = domainOf(map);
    const bands = map.lanes.flatMap((l) => (l.band ? [l.band.lo, l.band.hi] : []));
    expect(lo).toBeLessThan(Math.min(6250, 6900.5, ...bands));
    expect(hi).toBeGreaterThan(Math.max(7650, 6900.5, ...bands));
  });

  it("is the strikes alone without SPX", () => {
    const [lo, hi] = domainOf(mapOf(QUOTES.map(bare), HOLDINGS.map(bare)));
    expect(lo).toBeLessThan(6250);
    expect(hi).toBeGreaterThan(7650);
    expect(lo).toBeGreaterThan(6000);
  });

  it("is ticked at round strikes, inside it", () => {
    const ticks = ticksOf(6180, 7720, 6);
    expect(ticks.every((t) => t % 50 === 0 && t >= 6180 && t <= 7720)).toBe(true);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });
});

describe("slotting spreads into rows", () => {
  it("puts a spread on the first row it does not overlap, so no two marks collide", () => {
    expect(slotRows([[0, 10], [5, 15], [11, 20], [16, 30]])).toEqual([0, 1, 0, 1]);
    expect(slotRows([[0, 10], [2, 8], [4, 6]])).toEqual([0, 1, 2]);
    expect(slotRows([])).toEqual([]);
  });
});
