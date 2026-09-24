import type { Entry, Health } from "./api";
import { alarmText } from "./format";
import { type Book } from "./signals";

export function StatusStrip({
  health, book, closest, baselineAt, onResetBaseline,
}: {
  health: Health | null;
  book: Book;
  closest: Entry | null;
  baselineAt: string | null;
  onResetBaseline: () => void;
}) {
  if (!health) return null;
  return (
    <>
      <div className="health">
        OpenD: <span className={health.opend ? undefined : "bad"}>{health.opend ? "up" : "DOWN"}</span>
        {" · alarms: "}
        <span className={health.monitor.alarms.bad ? "bad" : undefined}>{health.monitor.alarms.label}</span>
        {` · queue: ${health.queue_depth}`}
        {book.of > 0 ? (
          <>
            {" · book P&L: "}
            {/* summed across holdings, and explicit about how much of the book it could
                price: a total that silently omits a position is worse than none */}
            <span className={book.total < 0 ? "bad" : undefined}>
              {book.total >= 0 ? "+" : ""}{book.total.toFixed(2)}
            </span>
            <span className="legs"> ({book.priced} of {book.of} positions priced)</span>
          </>
        ) : null}
      </div>

      {closest ? (
        <div className="health">
          nearest to firing: <strong>{closest.code}</strong> at {closest.fill}% of{" "}
          {alarmText(closest.field, closest.direction, closest.threshold, closest.compare)}
        </div>
      ) : null}

      {baselineAt ? (
        <div className="health">
          movement shown since {new Date(baselineAt).toLocaleTimeString()}{" "}
          <button onClick={onResetBaseline}>reset</button>
        </div>
      ) : null}
    </>
  );
}
