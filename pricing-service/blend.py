import math

from constants import GI_PREMIUM, MAX_MARKUP


def round_to_sensible(value: float) -> int:
    if value < 100:
        return int(round(value))
    if value < 500:
        return int(round(value / 5) * 5)
    if value < 2000:
        return int(round(value / 10) * 10)
    return int(round(value / 50) * 50)


def ceil_to_sensible(value: float) -> int:
    if value < 100:
        return int(math.ceil(value))
    if value < 500:
        return int(math.ceil(value / 5) * 5)
    if value < 2000:
        return int(math.ceil(value / 10) * 10)
    return int(math.ceil(value / 50) * 50)


def apply_gi_premium(market_price: float, has_gi_tag: bool) -> float:
    return market_price * (1 + GI_PREMIUM * (1 if has_gi_tag else 0))


def blend(floor: float, market_price: float | None, weight: float) -> float:
    if market_price is None or weight <= 0:
        return floor
    return max(floor, (1 - weight) * floor + weight * market_price)


def price_band(floor: float, recommended_raw: float) -> dict:
    minimum = ceil_to_sensible(floor)
    recommended = max(minimum, round_to_sensible(recommended_raw))
    maximum = max(recommended, round_to_sensible(recommended_raw * (1 + MAX_MARKUP)))
    return {
        "minimum": minimum,
        "recommended": recommended,
        "maximum": maximum,
        "currency": "INR",
    }


def driver_of(floor: float, recommended_raw: float) -> str:
    return "market" if recommended_raw > floor else "cost_floor"
