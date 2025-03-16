import yfinance as yf
import pandas as pd

from optionality.apis.aux import get_delta_days, get_expiration_cycle
from optionality.datatype import OptionStrategiesConfig
from optionality.datatype.base import OptionStrategy


def get_strike_table(setting: OptionStrategiesConfig):
    code_information = setting.code_information
    if code_information.type == "index":
        code_name = f'^{code_information.name}'
    else:
        raise NotImplementedError("Only index (SPX) is supported")
    
    ticker = yf.Ticker(code_name)
    exp_dates = ticker.options

    df = pd.DataFrame({
        "strike_date": exp_dates,
        "expiry_date_distance": [get_delta_days(e) for e in exp_dates],
        "expiration_cycle": [get_expiration_cycle(e) for e in exp_dates],
    })
    
    option_strategy: OptionStrategy = setting.option_strategy
    df = df.loc[
        (df.expiry_date_distance > option_strategy.expiry_date_distance.min) & \
            (df.expiry_date_distance <= option_strategy.expiry_date_distance.max
        ) & \
        (df.expiration_cycle.isin(["WEEK", "END_OF_MONTH"]))
    ].reset_index(drop=True)

    return df