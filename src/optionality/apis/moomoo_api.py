import time
import pandas as pd
from uuid import uuid4
from tqdm import tqdm
from moomoo import OpenQuoteContext, OptionDataFilter, OptionType

from optionality.apis.aux import build_holding_table, get_option_holdings_summary, get_warnings_table
from optionality.datatype import OptionHoldingsConfig, OptionStrategiesConfig

def get_client():
    try:
        client = OpenQuoteContext(
            host='127.0.0.1',
            port=11111
        )
        return client
    except:
        raise Exception("Client connection failed!")

def get_option_holdings_info(
        client: OpenQuoteContext,
        setting: OptionHoldingsConfig,
        columns: list = ["option_delta", "option_implied_volatility", "ask_price", "bid_price", "option_gamma", "option_vega", "option_theta", "option_rho", "code",]
    ):
    ls_summary = []
    ls_warning = []
    dt_details = {}
    
    # _holding: OptionHolding
    for _holding in tqdm(setting.option_holdings):
        strike_date = _holding.strike_date
        unique_id = uuid4().hex[:4]

        dt_details[strike_date] = dt_details.get(strike_date, {})
        _df_c = build_holding_table(holding=_holding, code_info=setting.code_information)

        _df_merge = _snapshot_api_and_merge(
            client=client,
            options_strategy_table=_df_c,
            columns=columns
        )

        summ = get_option_holdings_summary(
            _holding,
            _df_merge
        )
        ls_summary.append(summ)

        ls_warning.append(
            get_warnings_table(_df_merge, _holding)
        )
        dt_details[strike_date][unique_id] = _df_merge.drop(columns=["_mat"])

    df_warning = pd.concat(ls_warning).drop(columns=["_mat"])
    df_summary = pd.DataFrame(ls_summary)

    return df_summary, dt_details, df_warning

def get_option_strategies_info(
        client: OpenQuoteContext,
        df_strikes: pd.DataFrame,
        setting: OptionStrategiesConfig,
        columns: list = ["option_delta", "option_implied_volatility", "ask_price", "bid_price", "option_gamma", "option_vega", "option_theta", "option_rho", "code",]
    ):
    ls_summary = []
    dt_results = {}
    dt_details = {}

    code_name = setting.code_information
    if code_name.type == "index":
        code = f'{code_name.market}..{code_name.name}'
    else:
        raise NotImplementedError("Only index (SPX) is supported")

    for i, r in tqdm(df_strikes.iterrows()):
        unique_id = uuid4().hex[:4]
        
        strike_date: str = r.strike_date
        dt_details[strike_date] = dt_details.get(strike_date, {})
        
        dt_results[strike_date] = dt_results.get(strike_date, {})
        dt_results[strike_date][unique_id] = {}

        _legs_list = []

        for o in setting.option_strategy.options:
            option_type = getattr(OptionType, o.option_type)

            data_filter = OptionDataFilter()
            for k, v in o.filter.model_dump().items():
                setattr(data_filter, k, v)

            _res = client.get_option_chain(
                code=code,
                start=strike_date,
                end=strike_date,
                option_type=option_type,
                data_filter=data_filter,
            )
            time.sleep(3.0)  # API QPS limit  # TODO
            if _res[0] == 0:
                _res_snapshot = client.get_market_snapshot(_res[1].code.to_list())
                if _res_snapshot[0] == 0:
                    _df_snapshot = _res_snapshot[1][columns]
                    _df_snapshot = _df_snapshot[_df_snapshot["option_delta"].notna()]

                    _df_merge = _res[1][["name",  "option_type",  "strike_price",  "code"]] \
                        .merge(_df_snapshot, on=["code"], how="right")
                    _df_merge.insert(
                        _df_merge.columns.get_loc("ask_price"),  # type: ignore
                        "mid_price",
                        (_df_merge["ask_price"] + _df_merge["bid_price"]) / 2,
                        allow_duplicates=False
                    )
                    _df_merge = _df_merge.loc[_df_merge.option_delta.abs().sort_values(ascending=False).index]
                    _df_merge.reset_index(drop=True, inplace=True)

                    dt_results[strike_date][unique_id][o.option_type] = _df_merge

                    inner_leg = _df_merge.loc[0].to_dict()
                    offset = -o.stride if o.option_type == "CALL" else o.stride
                    outer_leg = _df_merge.loc[(_df_merge['strike_price'] - inner_leg["strike_price"] + offset).abs().argsort()[0:1]].to_dict("records")[0]  # This does not insure the stride must be equal to 25
                    inner_leg.update({"direction": "short", "_mat": -1})
                    outer_leg.update({"direction": "long", "_mat": 1})

                    _legs_list.append(inner_leg)
                    _legs_list.append(outer_leg)
            else:
                raise Exception(_res[1])

        _df_legs = pd.DataFrame(_legs_list) \
            .sort_values(by=["strike_price"]) \
            .reset_index(drop=True)

        ls_summary.append(
            get_option_holdings_summary(setting.option_strategy, _df_legs, strike_date=strike_date)
        )

        dt_details[strike_date][unique_id] = _df_legs \
            .drop(columns=["direction", "_mat"])

        del _legs_list
    
    df_summary = pd.DataFrame(ls_summary)
    
    return df_summary, dt_details, dt_results

def _snapshot_api_and_merge(
        client: OpenQuoteContext,
        options_strategy_table: pd.DataFrame,
        columns: list,
    ) -> pd.DataFrame:
    """
    This function fetches real-time market snapshot data for a given list of options and merges it with an options strategy table.

    Parameters:
    client (OpenQuoteContext): An instance of the OpenQuoteContext used to make API calls.
    options_strategy_table (pd.DataFrame): A DataFrame containing the options strategy details.
    columns (list): A list of column names to be included in the snapshot data.

    Returns:
    pd.DataFrame: A merged DataFrame containing the options strategy table and the fetched market snapshot data, including a calculated 'mid_price'.

    Raises:
    Exception: If the API call to fetch the market snapshot fails.

    Note:
    The function includes a sleep period to respect API query per second (QPS) limits. This may need adjustment based on actual API usage policies.
    """
    # call API to get snapshot
    _res_snapshot = client.get_market_snapshot(
        options_strategy_table.code.to_list()
    )
    time.sleep(3)  # API QPS limit TODO
    if _res_snapshot[0] == 0:
        # get columns
        _df_snapshot = _res_snapshot[1][columns]

        _df_merge = options_strategy_table.merge(
            _df_snapshot, on=["code"], how="inner"
        )

        _df_merge.insert(
            _df_merge.columns.get_loc("ask_price"),  # type: ignore
            "mid_price",
            (_df_merge["ask_price"] + _df_merge["bid_price"]) / 2,
            allow_duplicates=False
        )

        return _df_merge

    else:
        client.close()
        raise Exception("API calls failed")
