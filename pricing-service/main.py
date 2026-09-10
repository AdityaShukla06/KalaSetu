import base64
import binascii
import io
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

import encoders
from blend import apply_gi_premium, blend, driver_of, price_band
from catalogue import catalogue
from channels import channel_prices
from constants import K_NEIGHBOURS
from cost import compute_floor
from crafting_time import parse_crafting_time
from guards import (
    PricingError,
    clamp_hours,
    clamp_material_cost,
    require_known_category,
    require_material_cost,
)
from reference import hourly_wage
from reliability import score_reliability
from retrieval import comparable_range, confidence_weight, mean_similarity, weighted_median

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pricing")

for _noisy in ("httpx", "httpcore", "huggingface_hub", "transformers", "sentence_transformers"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    catalogue.load()
    yield


app = FastAPI(title="KalaSetu Pricing Service", lifespan=lifespan)


class EstimateRequest(BaseModel):
    category: str
    material_cost: float | None = None
    crafting_time: str | float | None = None
    description: str | None = None
    image_base64: str | None = None
    state: str | None = None
    has_gi_tag: bool = False
    model_config = {"protected_namespaces": ()}


class NoModel:
    def __init__(self, reason: str) -> None:
        self.reason = reason
        self.price = None
        self.neighbours = []
        self.mean_sim = 0.0

    def as_dict(self) -> dict:
        return {
            "ran": False,
            "reason": self.reason,
            "method": None,
            "predicted_market_price": None,
            "mean_similarity": None,
            "weight_applied": 0.0,
            "neighbours": [],
            "comparable_range": None,
        }


@app.exception_handler(PricingError)
async def pricing_error_handler(request: Request, error: PricingError) -> JSONResponse:
    payload = {"status": "error", "code": error.code, "message": error.message}
    if error.field:
        payload["field"] = error.field
    return JSONResponse(status_code=error.status, content=payload)


@app.get("/")
def root() -> dict:
    return {"service": "kalasetu-pricing", "status": "ok"}


@app.get("/health")
def health() -> JSONResponse:
    ready = catalogue.ready
    body = {
        "status": "ready" if ready else "degraded",
        "catalogue_version": catalogue.version,
        "catalogue_rows": len(catalogue.rows),
        "catalogue_rejected_rows": catalogue.rejected,
        "embedding_mode": catalogue.embedding_mode,
        "encoders_available": encoders.available(),
        "encoder_error": encoders.load_error(),
    }
    if ready:
        return JSONResponse(status_code=200, content=body)
    body["detail"] = (
        "The cost floor is available but the market model is not. "
        "Estimates will be priced from cost alone."
    )
    return JSONResponse(status_code=503, content=body)


def _decode_base64_image(payload: str | None):
    if not payload:
        return None
    cleaned = payload.split(",", 1)[-1]
    try:
        raw = base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError):
        raise PricingError("image_unreadable", "The image could not be read.", "image_base64") from None
    return _open_image(raw)


def _open_image(raw: bytes):
    if len(raw) > MAX_UPLOAD_BYTES:
        raise PricingError(
            "image_too_large",
            "That image is larger than 10 MB. Try a smaller photo.",
            "image",
            status=413,
        )
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
        return image.convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise PricingError("image_unreadable", "The image could not be read.", "image") from None


def estimate(
    category: str,
    material_cost: float | None,
    crafting_time: str | float | None,
    description: str | None,
    image,
    state: str | None,
    has_gi_tag: bool,
) -> dict:
    resolved_category = require_known_category(category)
    validated_cost = require_material_cost(material_cost)
    cost_used, cost_notes = clamp_material_cost(validated_cost, resolved_category)

    parsed = parse_crafting_time(crafting_time)
    hours, hour_notes = clamp_hours(parsed.hours)

    wage, wage_source = hourly_wage(state)
    breakdown = compute_floor(cost_used, hours, wage, wage_source)
    floor = breakdown.cost_floor

    has_image = image is not None
    has_description = bool(description and description.strip())

    if not has_image and not has_description:
        model = NoModel("No photo or description was given, so no comparable listings were searched.")
        weight = 0.0
    elif not catalogue.ready:
        model = NoModel("The market comparison is unavailable, so this price covers your costs only.")
        weight = 0.0
    else:
        query = encoders.embed_query(image, description, mode=catalogue.embedding_mode)
        neighbours = catalogue.search(query, resolved_category, K_NEIGHBOURS)
        if not neighbours:
            model = NoModel("No comparable listings were found for this category.")
            weight = 0.0
        else:
            mean_sim = mean_similarity(neighbours)
            weight = confidence_weight(mean_sim)
            if weight <= 0:
                model = NoModel(
                    "Nothing in the catalogue was close enough to compare against, "
                    "so this price covers your costs only."
                )
            else:
                model = _model_result(neighbours, mean_sim, weight, has_gi_tag)

    market_price = apply_gi_premium(model.price, has_gi_tag) if model.price is not None else None
    recommended_raw = blend(floor, market_price, weight)

    band = price_band(floor, recommended_raw)
    driver = driver_of(floor, recommended_raw)

    notes = cost_notes + hour_notes + parsed.notes
    if isinstance(model, NoModel):
        notes.append(model.reason)
    elif driver == "cost_floor":
        notes.append(
            "Comparable items sell for less than this piece costs to make at a fair wage. "
            "Priced at your floor."
        )

    reliability = score_reliability(
        model_ran=not isinstance(model, NoModel),
        mean_sim=model.mean_sim,
        hours=hours,
        parsed_from_text=isinstance(crafting_time, str),
        has_image=has_image,
        has_description=has_description,
    )

    return {
        "status": "success",
        "price": band,
        "driver": driver,
        "cost_breakdown": breakdown.as_dict(),
        "model": model.as_dict(),
        "assumptions": parsed.assumptions,
        "notes": notes,
        "reliability": reliability,
        "channels": channel_prices(band["recommended"]),
        "catalogue": {
            "version": catalogue.version,
            "date_range": catalogue.date_range,
            "rows": len(catalogue.rows),
        },
    }


class ModelResult:
    def __init__(self, neighbours, mean_sim, weight, price, gi_applied) -> None:
        self.neighbours = neighbours
        self.mean_sim = mean_sim
        self.weight = weight
        self.price = price
        self.gi_applied = gi_applied

    def as_dict(self) -> dict:
        return {
            "ran": True,
            "reason": None,
            "method": "embedding_retrieval",
            "predicted_market_price": round(self.price, 2),
            "with_gi_prior": round(apply_gi_premium(self.price, self.gi_applied), 2),
            "gi_handling": "prior_constant" if self.gi_applied else "not_applicable",
            "mean_similarity": round(self.mean_sim, 4),
            "weight_applied": round(self.weight, 4),
            "neighbours": [n.as_dict() for n in self.neighbours],
            "comparable_range": comparable_range(self.neighbours),
        }


def _model_result(neighbours, mean_sim, weight, has_gi_tag) -> ModelResult:
    return ModelResult(neighbours, mean_sim, weight, weighted_median(neighbours), has_gi_tag)


@app.post("/pricing/estimate")
def estimate_json(payload: EstimateRequest) -> dict:
    image = _decode_base64_image(payload.image_base64)
    return estimate(
        category=payload.category,
        material_cost=payload.material_cost,
        crafting_time=payload.crafting_time,
        description=payload.description,
        image=image,
        state=payload.state,
        has_gi_tag=payload.has_gi_tag,
    )


@app.post("/pricing/estimate-upload")
async def estimate_upload(
    category: str = Form(...),
    material_cost: float = Form(...),
    crafting_time: str | None = Form(None),
    description: str | None = Form(None),
    state: str | None = Form(None),
    has_gi_tag: bool = Form(False),
    file: UploadFile | None = File(None),
) -> dict:
    image = None
    if file is not None:
        image = _open_image(await file.read())
    return estimate(
        category=category,
        material_cost=material_cost,
        crafting_time=crafting_time,
        description=description,
        image=image,
        state=state,
        has_gi_tag=has_gi_tag,
    )
