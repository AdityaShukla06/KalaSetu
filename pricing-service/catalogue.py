import json
import logging
import os
from pathlib import Path

import numpy as np

import encoders
from retrieval import Neighbour

logger = logging.getLogger("pricing.catalogue")

DATA_DIR = Path(__file__).parent / "data"
CATALOGUE_PATH = Path(os.environ.get("PRICING_CATALOGUE", DATA_DIR / "catalogue.json"))
EMBEDDINGS_PATH = CATALOGUE_PATH.with_suffix(".embeddings.npy")

REQUIRED_FIELDS = ("id", "price", "category", "source", "observed_date")


class Catalogue:
    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.vectors: np.ndarray | None = None
        self.version: str = "empty"
        self.date_range: dict | None = None
        self.rejected: int = 0
        self.embedding_mode: str = "text"

    def load(self) -> None:
        if not CATALOGUE_PATH.exists():
            logger.warning("no catalogue at %s, the model side will not run", CATALOGUE_PATH)
            return

        with open(CATALOGUE_PATH, encoding="utf-8") as handle:
            payload = json.load(handle)

        self.version = payload.get("version", "unversioned")
        raw_rows = payload.get("listings", [])
        self.rows, self.rejected = _validate(raw_rows)

        if not self.rows:
            logger.warning("catalogue at %s has no usable rows", CATALOGUE_PATH)
            return

        dates = sorted(row["observed_date"] for row in self.rows)
        self.date_range = {"from": dates[0], "to": dates[-1]}
        self._load_vectors()

    def _load_vectors(self) -> None:
        if EMBEDDINGS_PATH.exists():
            cached = np.load(EMBEDDINGS_PATH)
            if cached.shape[0] == len(self.rows):
                self.vectors = cached
                self.embedding_mode = _read_mode()
                logger.info(
                    "loaded %d cached catalogue embeddings in %s mode",
                    cached.shape[0],
                    self.embedding_mode,
                )
                return
            logger.warning("cached embeddings are stale, rebuilding")

        if not encoders.available():
            logger.warning("encoders unavailable, catalogue stays unembedded: %s", encoders.load_error())
            return

        self.vectors = build_embeddings(self.rows)
        self.embedding_mode = "text"
        np.save(EMBEDDINGS_PATH, self.vectors)
        _write_mode("text")
        logger.info(
            "embedded %d catalogue rows from title and description only, "
            "so queries will be matched on text",
            len(self.rows),
        )

    @property
    def ready(self) -> bool:
        return self.vectors is not None and len(self.rows) > 0

    def search(self, query: np.ndarray, category: str, k: int) -> list[Neighbour]:
        if not self.ready:
            return []

        indices = [i for i, row in enumerate(self.rows) if row["category"] == category]
        if not indices:
            return []

        subset = self.vectors[indices]
        scores = subset @ query
        order = np.argsort(-scores)[:k]

        neighbours = []
        for position in order:
            row = self.rows[indices[position]]
            neighbours.append(
                Neighbour(
                    id=row["id"],
                    title=row.get("title", ""),
                    price=float(row["price"]),
                    similarity=float(scores[position]),
                    source=row["source"],
                    observed_date=row["observed_date"],
                )
            )
        return neighbours


MODE_PATH = CATALOGUE_PATH.with_suffix(".embeddings.mode")


def _read_mode() -> str:
    if MODE_PATH.exists():
        return MODE_PATH.read_text(encoding="utf-8").strip() or "text"
    return "text"


def _write_mode(mode: str) -> None:
    MODE_PATH.write_text(mode, encoding="utf-8")


def _validate(raw_rows: list[dict]) -> tuple[list[dict], int]:
    kept: list[dict] = []
    seen: set[str] = set()
    rejected = 0

    for row in raw_rows:
        if any(row.get(field) in (None, "") for field in REQUIRED_FIELDS):
            rejected += 1
            continue
        if not row.get("image_url") and not row.get("description"):
            rejected += 1
            continue
        try:
            price = float(row["price"])
        except (TypeError, ValueError):
            rejected += 1
            continue
        if price <= 0:
            rejected += 1
            continue
        if row["id"] in seen:
            rejected += 1
            continue

        seen.add(row["id"])
        normalised = dict(row)
        normalised["price"] = price
        normalised["category"] = str(row["category"]).strip().lower()
        kept.append(normalised)

    if rejected:
        logger.warning("dropped %d catalogue rows that failed validation", rejected)

    return kept, rejected


def build_embeddings(rows: list[dict], images: dict[str, object] | None = None) -> np.ndarray:
    vectors = np.zeros((len(rows), encoders.FUSED_DIM), dtype=np.float32)
    for index, row in enumerate(rows):
        text = " ".join(part for part in [row.get("title"), row.get("description")] if part)
        image = images.get(row["id"]) if images else None
        vectors[index] = encoders.fuse(
            encoders.embed_image(image),
            encoders.embed_text(text),
        )
    return vectors


catalogue = Catalogue()
