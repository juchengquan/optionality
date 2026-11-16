"""DTE, counted from New York's calendar day. Mirrors typescript/src/domain/expiry.ts."""

import re
from datetime import UTC, date, datetime, timedelta
from typing import Literal, TypedDict
from zoneinfo import ZoneInfo

from optionality.contract import normalize_strike_date

MARKET_TZ = "America/New_York"


def _aware(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(UTC)
    # a naive datetime is read as UTC, the way a JavaScript Date is always an instant
    return now if now.tzinfo else now.replace(tzinfo=UTC)


def market_date(now: datetime | None = None) -> str:
    """The calendar day in New York at `now`, which is the day an option's life is counted from."""
    return _aware(now).astimezone(ZoneInfo(MARKET_TZ)).date().isoformat()


# 09:30 and 16:15 in New York, as milliseconds since its midnight
_SAMPLE_FROM = (9 * 60 + 30) * 60_000
_SAMPLE_UNTIL = (16 * 60 + 15) * 60_000


def in_sample_hours(now: datetime | None = None) -> bool:
    """Whether `now` is inside the sample hours: 09:30 to 16:15 in New York, both ends included, on
    EVERY calendar day.

    The sample is the day's CLOSE, and 16:15 is the OPTIONS' close, a quarter hour after the stocks'.
    Inside the hours the day's row is written freely; outside them `takes_sample` decides. Every day,
    weekends included, because `vol_attribution` chains samples exactly one calendar day apart — a
    Saturday's row is the Friday close carried forward, a holiday's the previous close, a half-day's
    its own close. Mirrors `expiry.ts`.
    """
    return _SAMPLE_FROM <= _since_new_york_midnight(now) <= _SAMPLE_UNTIL


def in_session(now: datetime | None = None) -> bool:
    """Whether New York's SESSION is open at `now`: 09:30:00 to 16:15:00 there, both ends included,
    Monday to Friday. Holidays are not detected (#380, F7), as the page's own `inSession` does not.

    The same edges as `in_sample_hours`, and a different question: the daily sample is written on EVERY
    calendar day, while the session is when the market is open to be priced. Outside it a holding is
    valued from its latest close (`values_from_close`). Mirrors `expiry.ts`.
    """
    if _aware(now).astimezone(ZoneInfo(MARKET_TZ)).weekday() >= 5:
        return False
    return in_sample_hours(now)


#: which of SPX options' sessions New York's clock is in (#416)
type MarketPhase = Literal["regular", "curb", "overnight", "closed"]

# 09:25, 17:00 and 20:15 in New York, as milliseconds since its midnight
_GTH_UNTIL = (9 * 60 + 25) * 60_000
_CURB_UNTIL = 17 * 60 * 60_000
_GTH_FROM = (20 * 60 + 15) * 60_000


def market_phase(now: datetime | None = None) -> MarketPhase:
    """Which of SPX options' sessions New York's clock is in at `now` (#416), from Cboe's hours.

    - regular: 09:30:00 to 16:15:00, both ends included, Monday to Friday — `in_session`, exactly.
    - curb: after 16:15:00 and before 17:00:00, Monday to Friday.
    - overnight: Global Trading Hours, GTH — 20:15:00 to before 09:25:00 the next morning, for a trade
      date of Monday to Friday, so Sunday 20:15 starts Monday's and Friday 20:15 starts nothing.
    - closed: every other instant.

    Holidays are not detected, as `in_session` does not detect them. Mirrors `expiry.ts`.
    """
    weekday = _aware(now).astimezone(ZoneInfo(MARKET_TZ)).weekday()  # Monday 0 .. Sunday 6
    t = _since_new_york_midnight(now)
    if weekday < 5:
        if _SAMPLE_FROM <= t <= _SAMPLE_UNTIL:
            return "regular"
        if _SAMPLE_UNTIL < t < _CURB_UNTIL:
            return "curb"
        # the morning's end of the GTH that began the evening before (Monday's began on Sunday)
        if t < _GTH_UNTIL:
            return "overnight"
    # an evening's GTH is the NEXT weekday's: Sunday's to Thursday's evenings have one
    if t >= _GTH_FROM and weekday not in (4, 5):
        return "overnight"
    return "closed"


def sampled_price(now: datetime, price: float | None) -> float | None:
    """The price a day's sample may store, observed at `now` (#416): a regular session's, and nothing
    else — a GTH, Curb or weekend reading keeps its vol with the price left empty. Mirrors `expiry.ts`."""
    return price if market_phase(now) == "regular" else None


def _since_new_york_midnight(now: datetime | None) -> int:
    """Milliseconds since midnight in New York at `now`."""
    ny = _aware(now).astimezone(ZoneInfo(MARKET_TZ))
    # milliseconds, truncated, because a JavaScript Date carries no finer clock than that and the
    # boundaries are compared to the millisecond on both sides
    return ((ny.hour * 60 + ny.minute) * 60 + ny.second) * 1000 + ny.microsecond // 1000


class SampleReadings(TypedDict):
    """What a day's row reads, as stored: the two vol readings as JSON text, or None where the feed
    withheld one, and the Cost to close, or None where no leg had a two-sided quote to price it (#380)."""

    legs_iv: str | None
    legs_vega: str | None
    cost_to_close: float | None


class StoredSample(SampleReadings):
    """The day's row as stored, as far as `takes_sample` reads it. `observed_at` is UTC as the database
    spells it; None on rows written before migration 0009, which are taken as settled."""

    observed_at: str | None


#: what the sweep does with the day's row: leave it, write it only if its figures moved, or write it
#: regardless — the last so a provisional row is restamped even when nothing moved
type SampleWrite = Literal["no", "if-changed", "yes"]


def takes_sample(now: datetime, stored: StoredSample | None, observed: SampleReadings) -> SampleWrite:
    """What the sweep at `now` does with the day's row, given the row stored for that market day (None
    if none) and the two vol readings this sweep took.

    A stored row is PROVISIONAL when observed before its own day's 09:30 open, SETTLED once observed in
    the hours or after the close; a row without `observed_at` is settled. No row: written, whatever the
    hour. Before the open: only that fill. In the hours: written when the figures moved, and a
    provisional row regardless (a weekend's, restamped). After the close: a provisional row replaced (a
    missed session's evening) — a complete one only by complete readings — a settled row missing its IV or vega completed by a sweep with BOTH, a
    complete settled row never changed. An empty Cost to close never replaces a stored one at any hour
    (#380). Outside the regular session no reading has a cost (`sampled_price`, #416), so after the close
    a row is complete, and a reading whole, by its IV and vega alone: a costless row is completed by the
    vol, and a priced row is never changed. Mirrors `expiry.ts`.
    """
    if stored is None:
        return "yes"
    # an empty cost never replaces a stored one, at any hour (#380)
    if stored["cost_to_close"] is not None and observed["cost_to_close"] is None:
        return "no"
    observed_at = stored["observed_at"]
    provisional = (
        observed_at is not None
        and _since_new_york_midnight(datetime.fromisoformat(observed_at).replace(tzinfo=UTC)) < _SAMPLE_FROM
    )
    t = _since_new_york_midnight(now)
    if t < _SAMPLE_FROM:
        return "no"
    if t <= _SAMPLE_UNTIL:
        return "yes" if provisional else "if-changed"
    # after the close no reading has a price (#416): complete by the IV and vega alone
    incomplete = stored["legs_iv"] is None or stored["legs_vega"] is None
    complete = observed["legs_iv"] is not None and observed["legs_vega"] is not None
    if provisional:
        # a complete provisional row only by complete readings, or the day could lose its Vol for good
        return "yes" if incomplete or complete else "no"
    return "yes" if incomplete and complete else "no"


_STORED = re.compile(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?", re.ASCII)


def _stored_instant(text: str) -> datetime | None:
    """UTC as the database spells it, the fraction optional and any length, to the millisecond — or None
    for any other spelling (a "T", a zone) and for a day or a time that does not exist. Read strictly, as
    `expiry.ts`' `storedInstant` reads it: `fromisoformat` would take a "T" and a "Z", and a year below 100
    is refused because `Date.UTC` reads one as the 1900s."""
    m = _STORED.fullmatch(text)
    if m is None:
        return None
    y, mo, d, h, mi, s = (int(g) for g in m.groups()[:6])
    ms = int((m.group(7) or "")[:3].ljust(3, "0"))
    if y < 100:
        return None
    try:
        return datetime(y, mo, d, h, mi, s, ms * 1000, tzinfo=UTC)
    except ValueError:
        return None


#: when a stored row was observed, against its day's close: what a chart of the samples marks
type SampleTiming = Literal["close", "before-open", "after-close", "unrecorded"]


def sample_timing(observed_at: str | None) -> SampleTiming:
    """When a stored row was observed, against its day's close. `close` inside 09:30-16:15 New York (the
    last sweep by the options' close, or a weekend's carried forward); `before-open` a fill from overnight
    marks that nothing replaced; `after-close` a reading taken that evening (an opening day recorded then,
    a missed session filled, a row completed); `unrecorded` a row from before `observed_at` existed, of
    which nothing is claimed. By the hour alone, as `takes_sample`'s provisional check is. Mirrors
    `expiry.ts`.
    """
    when = None if observed_at is None else _stored_instant(observed_at)
    if when is None:
        return "unrecorded"
    t = _since_new_york_midnight(when)
    if t < _SAMPLE_FROM:
        return "before-open"
    return "close" if t <= _SAMPLE_UNTIL else "after-close"


class CloseCandidate(TypedDict):
    """A stored day's row as far as choosing the one to value a holding from reads it."""

    observed_on: str
    observed_at: str | None
    cost_to_close: float | None


def taken_in_session(observed_at: str | None) -> bool:
    """Whether a stored row was observed IN New York's regular session — a weekday's 09:30-16:15 — and so
    its price is a session's: what every reader of a stored price asks (#416). `sample_timing` says
    "close" by the hour alone, which a weekend row in those hours also is; a row with no stamp, or one
    that will not read, is not. Mirrors `expiry.ts`."""
    if observed_at is None or sample_timing(observed_at) != "close":
        return False
    when = _stored_instant(observed_at)
    return when is not None and in_session(when)


type ValuedTiming = Literal["close", "before-open", "after-close", "unrecorded", "weekend"]


def valued_timing(observed_at: str | None) -> ValuedTiming:
    """What the row a holding is valued from is (`close_sample`): `sample_timing`, except that a row observed
    on a day with no session — a weekend's, by New York's date, at ANY hour — is "weekend": never "close",
    and never "before the open" or "after the close" of a session that day did not have (#387). The same
    weekday test as `close_sample`'s, so the label and the choice cannot disagree. Mirrors `expiry.ts`."""
    timing = sample_timing(observed_at)
    when = None if observed_at is None else _stored_instant(observed_at)
    if timing == "unrecorded" or when is None:
        return "unrecorded"
    return "weekend" if when.astimezone(ZoneInfo(MARKET_TZ)).weekday() >= 5 else timing


def session_closed_since(day: str, now: datetime, recorded_at: datetime | None = None) -> bool:
    """Whether a WHOLE session — a weekday's 09:30 to 16:15 New York — has run and closed on or after the
    market day `day`, by `now`, and, given `recorded_at`, opened no earlier than that instant: what bounds
    the manage-by notice's wait for a Cost to close (#380 review). A session that had opened before the
    holding was recorded cannot have priced it. Holidays are not detected. Mirrors `expiry.ts`."""
    today = date.fromisoformat(market_date(now))
    d = date.fromisoformat(normalize_strike_date(day))
    if recorded_at is not None:
        # the first session that opened at or after it: its own day's, before the open; else the next
        recorded = date.fromisoformat(market_date(recorded_at))
        opens = recorded if _since_new_york_midnight(recorded_at) <= _SAMPLE_FROM else recorded + timedelta(days=1)
        d = max(d, opens)
    while d <= today:
        if d.weekday() < 5 and (d < today or _since_new_york_midnight(now) > _SAMPLE_UNTIL):
            return True
        d = d.fromordinal(d.toordinal() + 1)
    return False


def close_sample[R: CloseCandidate](samples: list[R]) -> R | None:
    """Which of a holding's stored rows it is valued from where it is not valued live (#380, F6), or None.

    The LATEST row with a Cost to close observed in a REGULAR session (`taken_in_session`) and nothing
    else (#416): an overnight, Curb, after-close, before-open, weekend or unstamped row is no close. A
    row without a cost values nothing. Latest by its market day, whatever order the rows come in.
    Mirrors `expiry.ts`.
    """
    close: R | None = None
    for s in samples:
        if s["cost_to_close"] is None or not taken_in_session(s["observed_at"]):
            continue
        if close is None or s["observed_on"] > close["observed_on"]:
            close = s
    return close


def values_from_close[R: CloseCandidate](now: datetime, quoted: bool, samples: list[R]) -> R | None:
    """The row a holding is valued from at `now`, or None to value it LIVE (#380, #416): always live in
    the regular session; in the Curb and overnight (GTH) live where `quoted` — every leg two-sided in
    this batch — and the latest close (`close_sample`) where not; closed, the latest close, quoted or
    not; and live where no row has a cost. Mirrors `expiry.ts`."""
    phase = market_phase(now)
    if phase == "regular":
        return None
    if quoted and phase in ("overnight", "curb"):
        return None
    return close_sample(samples)


def days_to_expiry(strike_date: str, now: datetime | None = None) -> int:
    """DTE: expiry day less New York's today. Zero on the day, negative after."""
    expiry = date.fromisoformat(normalize_strike_date(strike_date))
    return (expiry - date.fromisoformat(market_date(now))).days
