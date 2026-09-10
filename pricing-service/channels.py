from blend import ceil_to_sensible
from constants import CHANNEL_FEES, CHANNEL_LABELS


def channel_prices(recommended: int) -> dict:
    result = {}
    for key, fee in CHANNEL_FEES.items():
        listing = ceil_to_sensible(recommended / (1 - fee))
        result[key] = {
            "platform": CHANNEL_LABELS[key],
            "fee_percent": round(fee * 100, 2),
            "listing_price": listing,
            "take_home": round(listing * (1 - fee), 2),
        }
    return result
