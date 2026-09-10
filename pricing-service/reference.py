import json
import re
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

HOURS_PER_STATUTORY_DAY = 8


@lru_cache(maxsize=1)
def wage_standards() -> dict:
    with open(DATA_DIR / "wage_standards.json", encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def material_ranges() -> dict:
    with open(DATA_DIR / "material_ranges.json", encoding="utf-8") as handle:
        return json.load(handle)


def normalise_region(region: str | None) -> str | None:
    if not region:
        return None
    cleaned = re.sub(r"[^a-z ]+", " ", region.strip().lower())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return None
    aliases = wage_standards().get("aliases", {})
    return aliases.get(cleaned, cleaned)


def hourly_wage(region: str | None) -> tuple[float, str]:
    standards = wage_standards()
    key = normalise_region(region)
    states = standards["states"]
    if key and key in states:
        daily = states[key]["daily_inr"]
        return round(daily / HOURS_PER_STATUTORY_DAY, 2), states[key]["name"]
    daily = standards["national_default"]["daily_inr"]
    return round(daily / HOURS_PER_STATUTORY_DAY, 2), standards["national_default"]["name"]


def material_range(category: str) -> dict | None:
    return material_ranges().get(category.strip().lower())


def supported_categories() -> set[str]:
    return set(material_ranges().keys())
