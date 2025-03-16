import re
import pandas as pd
from typing import Union, Optional


def build_html_message(
    df_summary: pd.DataFrame,
    dt_details: dict,
    df_warning: Optional[pd.DataFrame] = None
):
    summary_html = _gen_summary_html(df_summary)
    warnings_html = _gen_warning_html(df_warning) if df_warning is not None else ""
    details_html = _gen_details_html(dt_details)

    return summary_html + warnings_html + details_html

def _gen_summary_html(summary: Union[dict, pd.DataFrame]):
    title = "<a name=\"top\"></a><h2>Summary:</h2>"

    _df = pd.DataFrame(summary)

    _df["strike_date"] = "<a href=\"#"+ _df["strike_date"] +"\">" + _df["strike_date"] + "</a>"

    table_html = _df \
        .to_html(index=False, escape=False)

    table_html = re.sub(r'\n+', '', table_html)
    table_html = re.sub(r'\s+', ' ', table_html)

    return title + f"<div>{table_html}</div>"

def _gen_details_html(dt_details):
    title = "<h2>Details:</h2>"

    details_html = ""

    for strike_date, _dfs in dt_details.items():
        details_html += f"<a name=\"{strike_date}\"></a>" + f"<h3>{strike_date}</h3> <a href=\"#top\">(Back to top)</a>"
        for _, _df in _dfs.items():
            _details = pd.DataFrame(_df) \
                .to_html(index=False, escape=False) \
                .replace("\n", "")
            _details = re.sub(r'\s+', ' ', _details)

            details_html += f"<div>{_details}<br/></div>"

    return title + f"<div>{details_html}</div>"

def _gen_warning_html(df_warning: pd.DataFrame):
    title = "<h2>Warnings:</h2>"

    _df = df_warning

    _df["strike_date"] = "<a href=\"#"+ _df["strike_date"] +"\">" + _df["strike_date"] + "</a>"

    table_html = _df \
        .to_html(index=False, escape=False)

    table_html = re.sub(r'\n+', '', table_html)
    table_html = re.sub(r'\s+', ' ', table_html)

    return title + f"<div>{table_html}</div>"