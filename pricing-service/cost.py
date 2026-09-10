from dataclasses import dataclass

from constants import FAIR_MARGIN, OVERHEAD_RATE


@dataclass(frozen=True)
class CostBreakdown:
    material_cost: float
    crafting_hours: float | None
    hourly_wage_applied: float
    wage_source: str
    labour: float
    overhead: float
    production_cost: float
    fair_margin_percent: float
    cost_floor: float

    def as_dict(self) -> dict:
        return {
            "material_cost": round(self.material_cost, 2),
            "crafting_hours": self.crafting_hours,
            "hourly_wage_applied": self.hourly_wage_applied,
            "wage_source": self.wage_source,
            "labour": round(self.labour, 2),
            "overhead": round(self.overhead, 2),
            "production_cost": round(self.production_cost, 2),
            "fair_margin_percent": self.fair_margin_percent,
            "cost_floor": round(self.cost_floor, 2),
        }


def compute_floor(
    material_cost: float,
    crafting_hours: float | None,
    hourly_wage: float,
    wage_source: str,
) -> CostBreakdown:
    labour = (crafting_hours or 0.0) * hourly_wage
    overhead = (material_cost + labour) * OVERHEAD_RATE
    production = material_cost + labour + overhead
    floor = production * (1 + FAIR_MARGIN)

    return CostBreakdown(
        material_cost=material_cost,
        crafting_hours=crafting_hours,
        hourly_wage_applied=hourly_wage,
        wage_source=wage_source,
        labour=labour,
        overhead=overhead,
        production_cost=production,
        fair_margin_percent=FAIR_MARGIN * 100,
        cost_floor=floor,
    )
