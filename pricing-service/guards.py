from constants import MATERIAL_CAP_MULTIPLIER, MAX_CRAFTING_HOURS
from reference import material_range, supported_categories


class PricingError(Exception):
    def __init__(self, code: str, message: str, field: str | None = None, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field
        self.status = status


def require_known_category(category: str | None) -> str:
    key = (category or "").strip().lower()
    if key not in supported_categories():
        raise PricingError(
            "unknown_category",
            f"We do not have pricing reference data for the category \"{category}\".",
            "category",
        )
    return key


def require_material_cost(material_cost: float | None) -> float:
    if material_cost is None:
        raise PricingError(
            "material_cost_required",
            "Enter what you spent on raw materials.",
            "material_cost",
        )
    try:
        value = float(material_cost)
    except (TypeError, ValueError):
        raise PricingError(
            "material_cost_required",
            "Enter what you spent on raw materials, in rupees.",
            "material_cost",
        ) from None
    if value <= 0:
        raise PricingError(
            "material_cost_required",
            "Material cost must be greater than zero.",
            "material_cost",
        )
    return value


def clamp_material_cost(material_cost: float, category: str) -> tuple[float, list[str]]:
    notes: list[str] = []
    limits = material_range(category)
    if limits is None:
        return material_cost, notes

    cap = limits["typical_max"] * MATERIAL_CAP_MULTIPLIER
    warn_high = limits["typical_max"] * 2
    warn_low = limits["typical_min"] / 2

    if material_cost > cap:
        notes.append(
            f"Material cost of {round(material_cost)} is far above the usual range for "
            f"{category}, so we capped it at {round(cap)} for this estimate. "
            "You can still set any price you like."
        )
        return float(cap), notes

    if material_cost > warn_high:
        notes.append(
            f"Material cost of {round(material_cost)} is higher than usual for {category}. "
            "Check the figure if that looks wrong."
        )
    elif material_cost < warn_low:
        notes.append(
            f"Material cost of {round(material_cost)} is lower than usual for {category}. "
            "Check the figure if that looks wrong."
        )

    return material_cost, notes


def clamp_hours(hours: float | None) -> tuple[float | None, list[str]]:
    if hours is None:
        return None, []
    if hours > MAX_CRAFTING_HOURS:
        return float(MAX_CRAFTING_HOURS), [
            f"Crafting time was capped at {MAX_CRAFTING_HOURS} hours for this estimate. "
            "Check the figure if that looks wrong."
        ]
    return hours, []
