import re
import unicodedata
from dataclasses import dataclass, field

from constants import (
    HOURS_PER_WORKING_DAY,
    WORKING_DAYS_PER_MONTH,
    WORKING_DAYS_PER_WEEK,
)

UNIT_KEYWORDS = {
    "month": [
        "months", "month", "mahine", "mahina", "maheena", "maah",
        "महीने", "महीना", "माह", "মাস", "மாதம்", "నెల", "ತಿಂಗಳು",
        "മാസം", "ਮਹੀਨਾ", "મહિનો", "ମାସ", "مہینہ", "महिना",
    ],
    "week": [
        "weeks", "week", "saptah", "hafta", "hafte",
        "सप्ताह", "हफ्ते", "हफ्ता", "সপ্তাহ", "வாரம்", "వారం", "ವಾರ",
        "ആഴ്ച", "ਹਫ਼ਤਾ", "અઠવાડિયું", "ସପ୍ତାହ", "ہفتہ", "आठवडा",
    ],
    "day": [
        "days", "day", "dins", "din", "roj",
        "दिन", "দিন", "நாள்", "நாட்கள்", "రోజు", "ದಿನ", "ദിവസം",
        "ਦਿਨ", "દિવસ", "ଦିନ", "دن",
    ],
    "hour": [
        "hours", "hour", "hrs", "hr", "ghante", "ghanta", "ghante",
        "घंटे", "घंटा", "ঘণ্টা", "மணி", "గంట", "ಗಂಟೆ", "മണിക്കൂർ",
        "ਘੰਟਾ", "કલાક", "ଘଣ୍ଟା", "گھنٹہ",
    ],
}

UNIT_TO_HOURS = {
    "hour": 1.0,
    "day": float(HOURS_PER_WORKING_DAY),
    "week": float(WORKING_DAYS_PER_WEEK * HOURS_PER_WORKING_DAY),
    "month": float(WORKING_DAYS_PER_MONTH * HOURS_PER_WORKING_DAY),
}

RANGE_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*(?:to|-|–|—|~|and)\s*(\d+(?:\.\d+)?)")
NUMBER_PATTERN = re.compile(r"\d+(?:\.\d+)?")


@dataclass
class ParsedTime:
    hours: float | None = None
    notes: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)


def _ascii_digits(text: str) -> str:
    out = []
    for char in text:
        digit = unicodedata.decimal(char, None)
        out.append(str(digit) if digit is not None else char)
    return "".join(out)


def _normalise(text: str) -> str:
    lowered = _ascii_digits(text).lower().strip()
    return re.sub(r"\s+", " ", lowered)


def _find_unit(text: str) -> str | None:
    best_unit = None
    best_position = len(text) + 1
    for unit, keywords in UNIT_KEYWORDS.items():
        for keyword in keywords:
            position = text.find(keyword)
            if position != -1 and position < best_position:
                best_position = position
                best_unit = unit
    return best_unit


def parse_crafting_time(raw: str | float | int | None) -> ParsedTime:
    result = ParsedTime()

    if raw is None or (isinstance(raw, str) and not raw.strip()):
        result.notes.append(
            "No crafting time was given, so labour is not included in this price. "
            "The figure below covers materials and overhead only."
        )
        return result

    if isinstance(raw, (int, float)):
        if raw <= 0:
            result.notes.append(
                "Crafting time was not a positive number, so labour is not included in this price."
            )
            return result
        result.hours = float(raw)
        return result

    text = _normalise(raw)
    unit = _find_unit(text)

    if unit is None:
        result.notes.append(
            f'Could not read "{raw.strip()}" as a length of time, so labour is not included '
            "in this price. Enter it as hours or days."
        )
        return result

    range_match = RANGE_PATTERN.search(text)
    if range_match:
        quantity = float(range_match.group(1))
        upper = float(range_match.group(2))
        if upper > quantity:
            result.notes.append(
                f"You gave a range, so we used the lower figure of {range_match.group(1)}."
            )
    else:
        number_match = NUMBER_PATTERN.search(text)
        if number_match is None:
            result.notes.append(
                f'Could not find a number in "{raw.strip()}", so labour is not included in this price.'
            )
            return result
        quantity = float(number_match.group(0))

    if quantity <= 0:
        result.notes.append(
            "Crafting time was not a positive number, so labour is not included in this price."
        )
        return result

    result.hours = quantity * UNIT_TO_HOURS[unit]

    if unit != "hour":
        readable = int(quantity) if quantity == int(quantity) else quantity
        result.assumptions.append(
            f'Crafting time "{raw.strip()}" was counted as {int(result.hours)} hours, '
            f"at {HOURS_PER_WORKING_DAY} hours per working day. "
            f"If {readable} {unit}s of your work means something different, correct it here."
        )

    return result
