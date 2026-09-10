from constants import SIM_FLOOR


def _model_points(model_ran: bool, mean_sim: float) -> int:
    if not model_ran:
        return 0
    if mean_sim >= 0.85:
        return 40
    if mean_sim >= 0.75:
        return 30
    if mean_sim >= SIM_FLOOR:
        return 20
    return 0


def _time_points(hours: float | None, parsed_from_text: bool) -> int:
    if hours is None:
        return 0
    return 30 if parsed_from_text else 40


def _input_points(has_image: bool, has_description: bool) -> int:
    if has_image and has_description:
        return 20
    if has_image or has_description:
        return 10
    return 0


def label_for(score: int) -> str:
    if score >= 80:
        return "High"
    if score >= 60:
        return "Medium"
    if score >= 40:
        return "Low"
    return "Very Low"


def score_reliability(
    model_ran: bool,
    mean_sim: float,
    hours: float | None,
    parsed_from_text: bool,
    has_image: bool,
    has_description: bool,
) -> dict:
    components = {
        "model_confidence": _model_points(model_ran, mean_sim),
        "crafting_time": _time_points(hours, parsed_from_text),
        "model_inputs": _input_points(has_image, has_description),
    }
    total = sum(components.values())
    return {"score": total, "label": label_for(total), "components": components}
