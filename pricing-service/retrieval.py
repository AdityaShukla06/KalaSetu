from dataclasses import dataclass

from constants import SIM_CEILING, SIM_FLOOR, W_MAX


@dataclass(frozen=True)
class Neighbour:
    id: str
    title: str
    price: float
    similarity: float
    source: str
    observed_date: str

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "price": self.price,
            "similarity": round(self.similarity, 4),
            "source": self.source,
            "observed_date": self.observed_date,
        }


def weighted_median(neighbours: list[Neighbour]) -> float:
    rows = sorted(neighbours, key=lambda n: (n.price, n.id))
    total = sum(n.similarity for n in rows)
    if total <= 0:
        return rows[len(rows) // 2].price
    accumulated = 0.0
    for row in rows:
        accumulated += row.similarity
        if accumulated >= total / 2:
            return row.price
    return rows[-1].price


def mean_similarity(neighbours: list[Neighbour]) -> float:
    if not neighbours:
        return 0.0
    return sum(n.similarity for n in neighbours) / len(neighbours)


def confidence_weight(mean_sim: float) -> float:
    span = SIM_CEILING - SIM_FLOOR
    scaled = (mean_sim - SIM_FLOOR) / span
    clipped = min(max(scaled, 0.0), 1.0)
    return clipped * W_MAX


def comparable_range(neighbours: list[Neighbour]) -> dict:
    prices = [n.price for n in neighbours]
    return {"min": min(prices), "max": max(prices)}
