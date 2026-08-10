from datetime import UTC, date, datetime, timedelta

import pandas as pd

# typing
from optionality.datatype.base import CodeInformation, OptionHolding, OptionStrategy


def get_delta_days(dt_str: str):
    today = datetime.now(UTC).astimezone().date()
    td = date.fromisoformat(dt_str) - today
    return td.days


def get_expiration_cycle(e):
    if _if_end_of_month(e):
        return "END_OF_MONTH"
    if date.fromisoformat(e).weekday() == 4:
        return "WEEK"
    return "NORMAL"


def _if_end_of_month(dt_str):
    _t = date.fromisoformat(dt_str)
    todays_month = _t.month
    tomorrows_month = (_t + timedelta(days=1)).month
    return tomorrows_month != todays_month


def build_spx_code(strike_date: str, option_type: str, strike: float) -> str:
    d = date.fromisoformat(strike_date)
    letter = "C" if option_type.upper() == "CALL" else "P"
    return f"US.SPXW{d.strftime('%y%m%d')}{letter}{int(strike)}000"


def _get_code_name(r, code_name: CodeInformation):
    option_type = "C" if r.type.upper() == "CALL" else "P"

    if code_name.type == "index":
        code_prefix = f"{code_name.market}.{code_name.name}W"

    code = (
        code_prefix
        + pd.to_datetime(r.strike_date, format="%Y-%m-%d").strftime("%y%m%d")
        + option_type
        + str(int(r.strike_price))
        + "000"
    )
    return code


def build_holding_table(holding: OptionHolding, code_info: CodeInformation):
    # get options table
    _df_c = pd.DataFrame([e.model_dump() for e in holding.options])
    _df_c.insert(0, "strategy", holding.strategy, allow_duplicates=False)
    _df_c.insert(0, "strike_date", holding.strike_date, allow_duplicates=False)

    _df_c["_mat"] = 1
    _df_c._mat = _df_c._mat.where(_df_c.direction == "long", -1)

    _df_c["code"] = _df_c.apply(lambda r: _get_code_name(r, code_info), axis=1)

    return _df_c


def get_option_holdings_summary(
    holding: OptionHolding | OptionStrategy,
    df_table: pd.DataFrame,
    strike_date: str | None = None,
    columns: list | None = None,
):
    if columns is None:
        columns = ["mid_price", "option_delta", "option_theta"]

    dt = {}
    if isinstance(holding, OptionHolding):
        dt.update(
            {
                "strike_date": holding.strike_date,
                "volume": holding.volume,
                "entry_price": holding.entry_price,
            }
        )
    elif strike_date:
        dt.update({"strike_date": strike_date})
    else:
        raise ValueError(f"strike_date {strike_date} has not source!")
    ##
    dt.update(
        {
            "strategy": holding.strategy,
        }
    )

    p = df_table[columns].mul(df_table._mat, axis="index").sum(axis=0).round(4).to_dict()

    dt.update(p)
    return dt


# def get_summary(
#         options_strategy: dict,
#         df_table: pd.DataFrame,
#         columns: list=["mid_price", "option_delta", "option_theta"]
#     ):
#     dt = dict(strike_date=options_strategy.get("strike_date")) if "strike_date" in options_strategy.keys() else {}
#     dt.update(dict(
#         strategy=options_strategy.get("strategy"),
#         volume=options_strategy.get("volume"),
#         entry_price=options_strategy.get("entry_price"),
#     ))

#     p = df_table[columns] \
#         .mul(df_table._mat, axis="index") \
#         .sum(axis=0).round(4).to_dict()

#     dt.update(p)
#     return dt


def get_warnings_table(df, holding: OptionHolding):
    thresholds = holding.warning_threshold

    if hasattr(thresholds, "delta"):
        cond_delta = df.option_delta.abs() > thresholds.delta

    return df.loc[cond_delta]
