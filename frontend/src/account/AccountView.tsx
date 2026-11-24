/** One answer of `GET /account` drawn (#471): the PAPER banner where it is one, the totals with the
 *  account as served and when IBKR marked it, then the stocks, the options and anything else — a
 *  table per kind on the desk, a card per holding on the phone, from the same cells.
 *
 *  Money is money, to the whole unit, in the holding's own currency; a price is per share, as IBKR
 *  marks it and as the page writes every price. A figure in a currency that is not the base carries
 *  its code beside it, and nothing does where everything is in the base (the owner, 2026-11-23).
 *  Under the book's privacy setting the money and the counts are hidden as the book hides them.
 *
 *  The owner's decisions of 2026-11-24:
 *  - **Stocks, Options and Other each fold, and so does each underlying inside Options**, as the
 *    book's expiry groups fold: a button heading saying whether it is open (`aria-expanded`) and
 *    what it folds (`aria-controls`), the folded rows kept mounted and `hidden`. Folded, a heading
 *    keeps its name and adds its count — what the arrangement draws, rows on the desk and cards on
 *    the phone, as the book's folded headings count — and its holdings' value and P&L summed in the
 *    base currency at IBKR's rates (`totalInBase`), or why they cannot be. Everything starts open;
 *    what is folded is remembered (`folds.ts`).
 *  - **Every option on one underlying and expiry is ONE row** (`optionRows`): its legs written as
 *    the book writes a structure, its units, its prices netted per share as IBKR signs them, its
 *    money summed. It starts closed, and opens — a press anywhere on it, or its button — to its legs
 *    underneath, each drawn as a contract alone is. Whether it is open is not remembered. */
import { Fragment, useCallback, useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import type { Account, AccountHolding, OtherHolding } from "../shared/api";
import { fetchedWords } from "../shared/format";
import { Leg, Legs } from "../shared/Legs";
import { points } from "../shared/numbers";
import { underlyingKey, useAccountFolds, type SectionKey } from "./folds";
import {
  contractLeg, currencyNote, holdsNothing, moneyText, optionGroups, optionRows, pnlShare, quantityText, shareText,
  stocksByValue, totalInBase, unitsText, weight, type Combo, type InBase,
} from "./model";

/** One figure of a row: what it is, as written, and the code of its currency where it is not the base. */
interface Cell {
  key: string;
  label: string;
  text: string;
  currency?: string | null;
  /** a P&L's: coloured by the viewer's up colour */
  outcome?: "gain" | "loss" | null;
}

interface Row {
  /** what the row is called on the page (`data-holding`), then `#` and its place, for its key */
  id: string;
  /** what the row is: a symbol, an option's contract, or a combined row's legs */
  lead: ReactNode;
  cells: Cell[];
  /** a combined row's: its legs, each a contract's row, drawn under it while it is open */
  legs?: Row[];
  open?: boolean;
  onToggle?: () => void;
}

const outcomeOf = (n: number | null): "gain" | "loss" | null =>
  n === null || Math.round(n) === 0 ? null : n > 0 ? "gain" : "loss";

export function AccountView({ account, phone, privacy, stale = false }: {
  account: Account; phone: boolean;
  /** the book's setting (`ui_privacy`): every amount of money and every count hidden as the book
   *  hides them; prices per share and percentages kept */
  privacy: boolean;
  /** the last good answer, kept under a refresh that has since failed: drawn dimmed */
  stale?: boolean;
}) {
  const base = account.base_currency;
  const note = (currency: string) => currencyNote(currency, base);
  const stocks = stocksByValue(account.stocks, account);
  const groups = optionGroups(account.options);
  const folds = useAccountFolds(account);
  // the combined rows opened, by underlying, expiry and currency: kept through the poll's reads,
  // never written anywhere, so every row starts closed on opening the page
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const openOrClose = useCallback((key: string) => setOpened((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  const unit = phone ? "card" : "row";
  const summary = (count: number, total: InBase, pnl = true): FoldSummary =>
    ({ count, unit, total, base: base ?? "", privacy, pnl });

  const stockRows: Row[] = stocks.map((h, i) => ({
    id: `${h.symbol}#${i}`,
    lead: h.symbol,
    cells: [
      { key: "qty", label: "qty", text: quantityText(h.position, privacy) },
      { key: "cost", label: "avg cost", text: points(h.average_cost), currency: note(h.currency) },
      { key: "mark", label: "mark", text: points(h.market_price), currency: note(h.currency) },
      { key: "value", label: "value", text: moneyText(h.market_value, h.currency, false, privacy), currency: note(h.currency) },
      { key: "pnl", label: "P&L", text: moneyText(h.unrealized_pnl, h.currency, true, privacy), currency: note(h.currency),
        outcome: outcomeOf(h.unrealized_pnl) },
      { key: "pnl-share", label: "P&L %", text: shareText(pnlShare(h), true), outcome: outcomeOf(h.unrealized_pnl) },
      { key: "weight", label: "weight", text: shareText(weight(h, account)) },
    ],
  }));
  const optionRow = (h: AccountHolding, i: number): Row => ({
    id: `${h.right}${h.strike}#${i}`,
    lead: <span data-fig="contract"><Leg leg={contractLeg(h)} form="name" /></span>,
    cells: [
      { key: "qty", label: "qty", text: quantityText(h.position, privacy) },
      { key: "cost", label: "avg cost", text: points(h.average_cost), currency: note(h.currency) },
      { key: "mark", label: "mark", text: points(h.market_price), currency: note(h.currency) },
      { key: "value", label: "value", text: moneyText(h.market_value, h.currency, false, privacy), currency: note(h.currency) },
      { key: "pnl", label: "P&L", text: moneyText(h.unrealized_pnl, h.currency, true, privacy), currency: note(h.currency),
        outcome: outcomeOf(h.unrealized_pnl) },
    ],
  });
  const comboRow = (c: Combo, key: string): Row => ({
    id: `${c.legs.map((l) => `${l.right}${l.strike}`).join("/")}#combo`,
    lead: <span data-fig="legs"><Legs legs={c.written} /></span>,
    cells: [
      { key: "qty", label: "qty", text: unitsText(c.units, privacy) },
      { key: "cost", label: "avg cost", text: points(c.average_cost), currency: note(c.currency) },
      { key: "mark", label: "mark", text: points(c.market_price), currency: note(c.currency) },
      { key: "value", label: "value", text: moneyText(c.market_value, c.currency, false, privacy), currency: note(c.currency) },
      { key: "pnl", label: "P&L", text: moneyText(c.unrealized_pnl, c.currency, true, privacy), currency: note(c.currency),
        outcome: outcomeOf(c.unrealized_pnl) },
    ],
    legs: c.legs.map(optionRow),
    open: opened.has(key),
    onToggle: () => openOrClose(key),
  });
  const underlyings = groups.map((g) => ({
    underlying: g.underlying,
    expiries: g.expiries.map((e) => ({
      key: e.expiry ?? "", heading: e.expiry ?? "no expiry",
      rows: optionRows(e).map((r, i) => (r.kind === "contract"
        ? optionRow(r.holding, i)
        : comboRow(r, `${g.underlying}:${e.expiry ?? ""}:${r.currency}`))),
      attributes: { "data-expiry": e.expiry ?? "" },
    })),
  }));
  const rowsOf = (u: (typeof underlyings)[number]) => u.expiries.reduce((n, e) => n + e.rows.length, 0);
  const otherRows: Row[] = account.other.map((h: OtherHolding, i) => ({
    id: `${h.symbol}#${i}`,
    lead: h.symbol,
    cells: [
      { key: "type", label: "type", text: h.sec_type },
      { key: "qty", label: "qty", text: quantityText(h.position, privacy) },
      { key: "value", label: "value", text: moneyText(h.market_value, h.currency, false, privacy), currency: note(h.currency) },
    ],
  }));

  return (
    <div className="nx-acct-view" data-stale={stale ? "" : undefined}>
      {account.paper ? <p className="nx-acct-paper" role="note">PAPER account</p> : null}
      <Totals account={account} privacy={privacy} />
      {holdsNothing(account) ? <p className="nx-meta nx-acct-empty">nothing held in this account</p> : null}
      {stockRows.length > 0 ? (
        <Section title="Stocks" fold="stocks" folds={folds}
                 summary={summary(stockRows.length, totalInBase(account.stocks, account))}>
          <Rows groups={[{ key: "stocks", rows: stockRows }]} leadLabel="symbol" phone={phone} />
        </Section>
      ) : null}
      {underlyings.length > 0 ? (
        <Section title="Options" fold="options" folds={folds}
                 summary={summary(underlyings.reduce((n, u) => n + rowsOf(u), 0), totalInBase(account.options, account))}>
          {underlyings.map((u) => (
            <Underlying key={u.underlying} symbol={u.underlying} folds={folds}
                        summary={summary(rowsOf(u), totalInBase(account.options.filter((o) => o.symbol === u.underlying), account))}>
              <Rows leadLabel="contract" phone={phone} fixed groups={u.expiries} />
            </Underlying>
          ))}
        </Section>
      ) : null}
      {otherRows.length > 0 ? (
        <Section title="Other" fold="other" folds={folds}
                 summary={summary(otherRows.length, totalInBase(account.other, account), false)}>
          <Rows groups={[{ key: "other", rows: otherRows }]} leadLabel="symbol" phone={phone} />
        </Section>
      ) : null}
    </div>
  );
}

/** The account's totals, in the base currency, and what the answer says of itself: the account as
 *  served (masked by the service), its base currency, when IBKR last marked it — one time for the
 *  whole account, as IBKR sends one (the owner, 2026-11-23) — and when the service read it. */
function Totals({ account, privacy }: { account: Account; privacy: boolean }) {
  const base = account.base_currency ?? "";
  const t = account.totals;
  const pairs: { label: string; text: string; outcome?: "gain" | "loss" | null }[] = [
    { label: "net liquidation", text: moneyText(t.net_liquidation, base, false, privacy) },
    { label: "cash", text: moneyText(t.total_cash, base, false, privacy) },
    { label: "unrealised P&L", text: moneyText(t.unrealized_pnl, base, true, privacy), outcome: outcomeOf(t.unrealized_pnl) },
    { label: "realised P&L", text: moneyText(t.realized_pnl, base, true, privacy), outcome: outcomeOf(t.realized_pnl) },
  ];
  return (
    <section className="nx-acct-totals" aria-label="totals">
      <dl className="nx-acct-total-figs">
        {pairs.map((p) => (
          <div key={p.label}>
            <dt>{p.label}</dt>
            <dd data-money="" data-outcome={p.outcome ?? undefined}>{p.text}</dd>
          </div>
        ))}
      </dl>
      <p className="nx-meta nx-acct-about">
        <span className="nx-acct-id">{account.account}</span>
        {account.base_currency ? <span>{`base ${account.base_currency}`}</span> : null}
        <span>{`IBKR marked at ${account.updated_at ?? "—"}`}</span>
        <span>{`read at ${fetchedWords(account.read_at)}`}</span>
      </p>
    </section>
  );
}

type Folds = ReturnType<typeof useAccountFolds>;

/** What a folded heading adds to its name. */
interface FoldSummary {
  count: number;
  /** what the arrangement draws: the desk's rows, the phone's cards */
  unit: "row" | "card";
  total: InBase;
  base: string;
  privacy: boolean;
  /** whether its holdings carry a P&L to sum: Other's do not */
  pnl: boolean;
}

/** A heading as the button that folds what is under it. Folded, it says its name, then its count,
 *  then its value and P&L in the base — `Stocks · 3 rows · value $35,760 · P&L +$1,960` — or, where
 *  they cannot be summed, why: `· no total: no rate for SEK`. Each piece whole with the dot before
 *  it, the spaces between them where a narrow screen wraps the heading. */
function FoldButton({ name, nameId, folded, controls, onToggle, summary }: {
  name: string; nameId?: string; folded: boolean; controls: string; onToggle: () => void; summary: FoldSummary;
}) {
  const { count, unit, total, base, privacy } = summary;
  return (
    <button type="button" className="nx-acct-fold" aria-expanded={!folded} aria-controls={controls} onClick={onToggle}>
      <ChevronRight aria-hidden="true" className="nx-acct-mark" />
      <span className="nx-acct-fold-words">
        <span id={nameId}>{name}</span>
        {folded ? (
          <>
            {" "}<span className="nx-acct-fold-piece">{`· ${count} ${unit}${count === 1 ? "" : "s"}`}</span>
            {total.without !== null ? (
              <>{" "}<span className="nx-acct-fold-piece">{`· no total: ${total.without}`}</span></>
            ) : (
              <>
                {" "}<span className="nx-acct-fold-piece">{"· value "}<span data-fold-fig="value">{moneyText(total.value, base, false, privacy)}</span></span>
                {summary.pnl ? (
                  <>
                    {" "}<span className="nx-acct-fold-piece">{"· P&L "}<span data-fold-fig="pnl" data-outcome={outcomeOf(total.pnl) ?? undefined}>
                      {moneyText(total.pnl, base, true, privacy)}
                    </span></span>
                  </>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </span>
    </button>
  );
}

function Section({ title, fold, folds, summary, children }: {
  title: string; fold: SectionKey; folds: Folds; summary: FoldSummary; children: ReactNode;
}) {
  const name = useId();
  const body = useId();
  const folded = folds.folded(fold);
  return (
    <section className="nx-acct-section" aria-labelledby={name} data-section={fold}>
      <h2>
        <FoldButton name={title} nameId={name} folded={folded} controls={body} summary={summary}
                    onToggle={() => folds.toggle(fold)} />
      </h2>
      <div id={body} className="nx-acct-fold-body" hidden={folded}>{children}</div>
    </section>
  );
}

/** An underlying's options inside Options, folding as a section does. */
function Underlying({ symbol, folds, summary, children }: {
  symbol: string; folds: Folds; summary: FoldSummary; children: ReactNode;
}) {
  const body = useId();
  const key = underlyingKey(symbol);
  const folded = folds.folded(key);
  return (
    <div className="nx-acct-underlying" data-underlying={symbol}>
      <h3>
        <FoldButton name={symbol} folded={folded} controls={body} summary={summary} onToggle={() => folds.toggle(key)} />
      </h3>
      <div id={body} className="nx-acct-fold-body" hidden={folded}>{children}</div>
    </div>
  );
}

/** A figure, and its currency's code where it is not the base. */
function Figure({ cell }: { cell: Cell }) {
  return (
    <>
      <span data-fig={cell.key} data-outcome={cell.outcome ?? undefined}>{cell.text}</span>
      {cell.currency ? <span className="nx-acct-ccy" data-currency="">{cell.currency}</span> : null}
    </>
  );
}

/** Rows under a heading of their own, or none: an option's expiry, or a kind's one list. */
interface Group {
  key: string;
  heading?: string;
  rows: Row[];
  attributes?: Record<`data-${string}`, string>;
}

/** Groups of rows as ONE table on the desk — a body per group, its heading a row across the table,
 *  so an underlying's expiries share their columns — and as cards under each heading on the phone.
 *  `fixed`: the columns shared out evenly, so every underlying's table lines up with the next.
 *
 *  A combined row (`legs`) is drawn with its own button before its legs, which a press anywhere on
 *  it opens or closes — the press reaches the row whichever part of it was pressed, the button's
 *  own included, so the button is how a keyboard opens it. Its legs are drawn under it, each as a
 *  contract's row, kept mounted and hidden while it is closed: on the desk the table's rows after
 *  it, on the phone cards inside its card. */
function Rows({ groups, leadLabel, phone, fixed = false }: {
  groups: Group[]; leadLabel: string; phone: boolean; fixed?: boolean;
}) {
  const ids = useId();
  const holding = (r: Row) => r.id.split("#")[0];
  if (phone) {
    const card = (r: Row) => {
      const qty = r.cells.find((c) => c.key === "qty");
      return (
        <>
          <div className="nx-acct-card-head">
            <span className="nx-acct-lead">{r.lead}</span>
            {qty ? <span className="nx-acct-qty"><Figure cell={qty} /></span> : null}
          </div>
          <dl className="nx-acct-figs">
            {r.cells.filter((c) => c !== qty).map((c) => (
              <div key={c.key}>
                <dt>{c.label}</dt>
                <dd><Figure cell={c} /></dd>
              </div>
            ))}
          </dl>
        </>
      );
    };
    return (
      <>
        {groups.map((g, gi) => (
          <div key={g.key} className="nx-acct-group" {...g.attributes}>
            {g.heading ? <h4>{g.heading}</h4> : null}
            <ul className="nx-acct-cards">
              {g.rows.map((r, ri) => {
                if (!r.legs) return <li key={r.id} className="nx-acct-card" data-holding={holding(r)}>{card(r)}</li>;
                const legsId = `${ids}-${gi}-${ri}`;
                const qty = r.cells.find((c) => c.key === "qty");
                return (
                  <li key={r.id} className="nx-acct-card nx-acct-combo" data-holding={holding(r)} data-combo=""
                      data-open={r.open ? "" : undefined}>
                    <div className="nx-acct-combo-top" onClick={r.onToggle}>
                      <div className="nx-acct-card-head">
                        <button type="button" className="nx-acct-combo-toggle" aria-expanded={!!r.open} aria-controls={legsId}>
                          <ChevronRight aria-hidden="true" className="nx-acct-mark" />
                          <span className="nx-acct-lead">{r.lead}</span>
                        </button>
                        {qty ? <span className="nx-acct-qty"><Figure cell={qty} /></span> : null}
                      </div>
                      <dl className="nx-acct-figs">
                        {r.cells.filter((c) => c !== qty).map((c) => (
                          <div key={c.key}>
                            <dt>{c.label}</dt>
                            <dd><Figure cell={c} /></dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                    <ul id={legsId} className="nx-acct-legs" hidden={!r.open}>
                      {r.legs.map((l) => (
                        <li key={l.id} className="nx-acct-leg" data-holding={holding(l)} data-leg="">{card(l)}</li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </>
    );
  }
  const labels = groups[0]?.rows[0]?.cells.map((c) => c.label) ?? [];
  const cells = (r: Row) => r.cells.map((c) => <td key={c.key}><Figure cell={c} /></td>);
  return (
    <table className="nx-acct-table" data-fixed={fixed ? "" : undefined}>
      <thead>
        <tr>
          <th scope="col">{leadLabel}</th>
          {labels.map((l) => <th key={l} scope="col">{l}</th>)}
        </tr>
      </thead>
      {groups.map((g, gi) => (
        <tbody key={g.key} {...g.attributes}>
          {g.heading ? (
            <tr className="nx-acct-group-head"><th scope="rowgroup" colSpan={labels.length + 1}>{g.heading}</th></tr>
          ) : null}
          {g.rows.map((r, ri) => {
            if (!r.legs) {
              return (
                <tr key={r.id} data-holding={holding(r)}>
                  <th scope="row" className="nx-acct-lead">{r.lead}</th>
                  {cells(r)}
                </tr>
              );
            }
            const legIds = r.legs.map((_, j) => `${ids}-${gi}-${ri}-${j}`);
            return (
              <Fragment key={r.id}>
                <tr className="nx-acct-combo" data-holding={holding(r)} data-combo="" data-open={r.open ? "" : undefined}
                    onClick={r.onToggle}>
                  <th scope="row" className="nx-acct-lead">
                    <button type="button" className="nx-acct-combo-toggle" aria-expanded={!!r.open} aria-controls={legIds.join(" ")}>
                      <ChevronRight aria-hidden="true" className="nx-acct-mark" />
                      {r.lead}
                    </button>
                  </th>
                  {cells(r)}
                </tr>
                {r.legs.map((l, j) => (
                  <tr key={l.id} id={legIds[j]} className="nx-acct-leg" data-holding={holding(l)} data-leg="" hidden={!r.open}>
                    <th scope="row" className="nx-acct-lead">{l.lead}</th>
                    {cells(l)}
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}
