from collections.abc import Callable
from dataclasses import dataclass

from optionality.apis import (
    get_client,
    get_option_holdings_info,
    get_option_strategies_info,
    get_strike_table,
)
from optionality.datatype import OptionHoldingsConfig, OptionStrategiesConfig
from optionality.datatype.notification import NotificationConfig
from optionality.notification import build_html_message, notification_funcs

CONFIG_MODELS: dict[str, type] = {
    "strategy": OptionStrategiesConfig,
    "holdings": OptionHoldingsConfig,
}


@dataclass
class RunResult:
    html: str
    summary: list[dict]
    warnings: list[dict] | None
    details: list[dict] | None = None


def _records(df) -> list[dict]:
    # NaN -> None so the records survive strict JSON serialization
    return df.astype(object).where(df.notna(), None).to_dict("records")


def _flatten_details(dt_details: dict) -> list[dict]:
    records = []
    for strike_date, groups in dt_details.items():
        for group_id, df in groups.items():
            records.extend({"strike_date": strike_date, "group": group_id, **row} for row in _records(df))
    return records


def load_config(task: str, body: dict) -> OptionStrategiesConfig | OptionHoldingsConfig:
    try:
        model = CONFIG_MODELS[task]
    except KeyError:
        raise ValueError(f"task type is wrong: {task}") from None
    return model(**body)


def run_task(
    task: str,
    config: OptionStrategiesConfig | OptionHoldingsConfig,
    client_factory: Callable = get_client,
    opend_host: str = "127.0.0.1",
    opend_port: int = 11111,
) -> RunResult:
    if task not in CONFIG_MODELS:
        raise ValueError(f"task type is wrong: {task}")

    client = client_factory(host=opend_host, port=opend_port)
    try:
        if task == "strategy":
            df_strikes = get_strike_table(config)
            df_summary, dt_details, _ = get_option_strategies_info(client, df_strikes, config)
            df_warning = None
        else:
            df_summary, dt_details, df_warning = get_option_holdings_info(client, config)

        html = build_html_message(df_summary, dt_details, df_warning)
        return RunResult(
            html=html,
            summary=df_summary.to_dict("records"),
            warnings=df_warning.to_dict("records") if df_warning is not None else None,
            details=_flatten_details(dt_details),
        )
    finally:
        client.close()


def fetch_snapshot(
    codes: list[str],
    client_factory: Callable = get_client,
    opend_host: str = "127.0.0.1",
    opend_port: int = 11111,
) -> list[dict]:
    client = client_factory(host=opend_host, port=opend_port)
    try:
        ret, data = client.get_market_snapshot(codes)
        if ret != 0:
            raise RuntimeError(f"snapshot API failed: {data}")
        records = _records(data)
        for record in records:
            bid, ask = record.get("bid_price"), record.get("ask_price")
            if bid is not None and ask is not None:
                record["mid_price"] = (bid + ask) / 2
        return records
    finally:
        client.close()


def send_notifications(notification: NotificationConfig, html: str) -> None:
    for name, params in notification.model_dump().items():
        if params:
            notification_funcs[name](params, html)
