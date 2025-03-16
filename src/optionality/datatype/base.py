from pydantic import BaseModel, EmailStr
from typing import List, Literal

from .notification import NotificationConfig


class CodeInformation(BaseModel):
    type: str
    name: str
    market: str

class Option(BaseModel):
    type: Literal["CALL", "PUT"]
    direction: Literal["long", "short"]
    strike_price: float

class _OptionHoldingWarningThreshold(BaseModel):
    delta: float

class OptionHolding(BaseModel):
    strategy: str
    strike_date: str
    volume: int
    entry_price: float
    warning_threshold: _OptionHoldingWarningThreshold
    options: List[Option]

class ExpiryDateDistance(BaseModel):
    min: int
    max: int

class OptionFilter(BaseModel):
    delta_min: float
    delta_max: float

class OptionStrategyOption(BaseModel):
    option_type: Literal["CALL", "PUT"]
    filter: OptionFilter
    stride: int

class OptionStrategy(BaseModel):
    strategy: str
    expiry_date_distance: ExpiryDateDistance
    options: List[OptionStrategyOption]


class OptionHoldingsConfig(BaseModel):
    notification: NotificationConfig
    code_information: CodeInformation
    option_holdings: List[OptionHolding]

class OptionStrategiesConfig(BaseModel):
    notification: NotificationConfig
    code_information: CodeInformation
    option_strategy: OptionStrategy
###
