/** One answer of `GET /account` drawn (#471): the PAPER banner where it is one, the totals with the
 *  account as served and when IBKR marked it, then the stocks, the options and anything else — a
 *  table per kind on the desk, a card per holding on the phone, from the same cells.
 *
 *  Money is money, to the whole unit, in the holding's own currency; a price is per share, as IBKR
 *  marks it and as the page writes every price. A figure in a currency that is not the base carries
 *  its code beside it, and nothing does where everything is in the base (the owner, 2026-11-23).
 *  Under the book's privacy setting the money and the counts are hidden as the book hides them. */
import { useId, type ReactNode } from "react";

import type { Account, AccountHolding, OtherHolding } from "../shared/api";
import { fetchedWords } from "../shared/format";
import { Leg } from "../shared/Legs";
import { points } from "../shared/numbers";
import {
  contractLeg, currencyNote, holdsNothing, moneyText, optionGroups, pnlShare, quantityText, shareText,
  stocksByValue, weight,
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
  /** what the row is: a symbol, or an option's contract */
  lead: ReactNode;
  cells: Cell[];
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
        <Section title="Stocks">
          <Rows groups={[{ key: "stocks", rows: stockRows }]} leadLabel="symbol" phone={phone} />
        </Section>
      ) : null}
      {groups.length > 0 ? (
        <Section title="Options">
          {groups.map((g) => (
            <div key={g.underlying} className="nx-acct-underlying" data-underlying={g.underlying}>
              <h3>{g.underlying}</h3>
              <Rows leadLabel="contract" phone={phone} fixed
                    groups={g.expiries.map((e) => ({
                      key: e.expiry ?? "", heading: e.expiry ?? "no expiry", rows: e.rows.map(optionRow),
                      attributes: { "data-expiry": e.expiry ?? "" },
                    }))} />
            </div>
          ))}
        </Section>
      ) : null}
      {otherRows.length > 0 ? (
        <Section title="Other">
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="nx-acct-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
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
 *  `fixed`: the columns shared out evenly, so every underlying's table lines up with the next. */
function Rows({ groups, leadLabel, phone, fixed = false }: {
  groups: Group[]; leadLabel: string; phone: boolean; fixed?: boolean;
}) {
  const holding = (r: Row) => r.id.split("#")[0];
  if (phone) {
    return (
      <>
        {groups.map((g) => (
          <div key={g.key} className="nx-acct-group" {...g.attributes}>
            {g.heading ? <h4>{g.heading}</h4> : null}
            <ul className="nx-acct-cards">
              {g.rows.map((r) => {
                const qty = r.cells.find((c) => c.key === "qty");
                return (
                  <li key={r.id} className="nx-acct-card" data-holding={holding(r)}>
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
  return (
    <table className="nx-acct-table" data-fixed={fixed ? "" : undefined}>
      <thead>
        <tr>
          <th scope="col">{leadLabel}</th>
          {labels.map((l) => <th key={l} scope="col">{l}</th>)}
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.key} {...g.attributes}>
          {g.heading ? (
            <tr className="nx-acct-group-head"><th scope="rowgroup" colSpan={labels.length + 1}>{g.heading}</th></tr>
          ) : null}
          {g.rows.map((r) => (
            <tr key={r.id} data-holding={holding(r)}>
              <th scope="row" className="nx-acct-lead">{r.lead}</th>
              {r.cells.map((c) => <td key={c.key}><Figure cell={c} /></td>)}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
