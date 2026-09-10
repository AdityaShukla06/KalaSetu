import base64
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import catalogue as catalogue_module
import main
from catalogue import Catalogue, _validate
from encoders import FUSED_DIM

client = TestClient(main.app)

BASE_REQUEST = {
    "category": "pottery",
    "material_cost": 480.0,
    "crafting_time": "3 days",
    "description": "hand painted blue pottery flower vase",
    "state": "Rajasthan",
    "has_gi_tag": True,
}


def _png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (30, 60, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


class TestHealth:
    def test_root_is_always_up(self):
        response = client.get("/")
        assert response.status_code == 200
        assert response.json()["service"] == "kalasetu-pricing"

    def test_health_reports_readiness_honestly(self):
        response = client.get("/health")
        assert response.status_code in (200, 503)
        body = response.json()
        assert "embedding_mode" in body
        assert "encoders_available" in body
        if response.status_code == 503:
            assert "cost floor is available" in body["detail"]


class TestEstimateContract:
    def test_returns_a_priced_band(self):
        response = client.post("/pricing/estimate", json=BASE_REQUEST)
        assert response.status_code == 200
        body = response.json()

        price = body["price"]
        assert price["minimum"] <= price["recommended"] <= price["maximum"]
        assert price["currency"] == "INR"
        assert body["driver"] in ("cost_floor", "market")

    def test_cost_breakdown_is_traceable(self):
        body = client.post("/pricing/estimate", json=BASE_REQUEST).json()
        breakdown = body["cost_breakdown"]

        assert breakdown["material_cost"] == 480.0
        assert breakdown["crafting_hours"] == 24.0
        assert breakdown["hourly_wage_applied"] == 90.0
        assert breakdown["wage_source"] == "Rajasthan"
        assert breakdown["labour"] == 2160.0
        assert breakdown["overhead"] == 264.0
        assert breakdown["production_cost"] == 2904.0
        assert breakdown["cost_floor"] == 3484.8

    def test_day_assumption_is_disclosed(self):
        body = client.post("/pricing/estimate", json=BASE_REQUEST).json()
        assert body["assumptions"]
        assert "24 hours" in body["assumptions"][0]

    def test_channels_never_shortchange_the_artisan(self):
        body = client.post("/pricing/estimate", json=BASE_REQUEST).json()
        recommended = body["price"]["recommended"]
        for channel in body["channels"].values():
            assert channel["take_home"] >= recommended

    def test_reliability_is_reported(self):
        body = client.post("/pricing/estimate", json=BASE_REQUEST).json()
        assert 0 <= body["reliability"]["score"] <= 100
        assert body["reliability"]["label"] in ("High", "Medium", "Low", "Very Low")

    def test_model_block_always_states_whether_it_ran(self):
        body = client.post("/pricing/estimate", json=BASE_REQUEST).json()
        assert "ran" in body["model"]
        if not body["model"]["ran"]:
            assert body["model"]["reason"]
            assert body["model"]["weight_applied"] == 0.0


class TestRefusals:
    def test_zero_material_cost(self):
        response = client.post("/pricing/estimate", json={**BASE_REQUEST, "material_cost": 0})
        assert response.status_code == 400
        assert response.json()["code"] == "material_cost_required"

    def test_negative_material_cost(self):
        response = client.post("/pricing/estimate", json={**BASE_REQUEST, "material_cost": -50})
        assert response.status_code == 400

    def test_missing_material_cost(self):
        payload = {k: v for k, v in BASE_REQUEST.items() if k != "material_cost"}
        response = client.post("/pricing/estimate", json=payload)
        assert response.status_code == 400
        assert response.json()["code"] == "material_cost_required"

    def test_unknown_category(self):
        response = client.post("/pricing/estimate", json={**BASE_REQUEST, "category": "spacecraft"})
        assert response.status_code == 400
        assert response.json()["code"] == "unknown_category"

    def test_unreadable_image(self):
        response = client.post(
            "/pricing/estimate",
            json={**BASE_REQUEST, "image_base64": "not-base64-at-all!!"},
        )
        assert response.status_code == 400
        assert response.json()["code"] == "image_unreadable"

    def test_non_image_bytes(self):
        payload = base64.b64encode(b"this is plainly not an image").decode()
        response = client.post("/pricing/estimate", json={**BASE_REQUEST, "image_base64": payload})
        assert response.status_code == 400
        assert response.json()["code"] == "image_unreadable"


class TestNoGuessing:
    def test_unparseable_time_prices_without_labour(self):
        body = client.post(
            "/pricing/estimate",
            json={**BASE_REQUEST, "crafting_time": "quite a while"},
        ).json()

        assert body["cost_breakdown"]["crafting_hours"] is None
        assert body["cost_breakdown"]["labour"] == 0.0
        assert any("labour is not included" in note for note in body["notes"])

    def test_missing_time_prices_without_labour(self):
        payload = {k: v for k, v in BASE_REQUEST.items() if k != "crafting_time"}
        body = client.post("/pricing/estimate", json=payload).json()
        assert body["cost_breakdown"]["labour"] == 0.0

    def test_no_image_and_no_description_skips_the_model(self):
        payload = {k: v for k, v in BASE_REQUEST.items() if k != "description"}
        body = client.post("/pricing/estimate", json=payload).json()
        assert body["model"]["ran"] is False
        assert body["driver"] == "cost_floor"

    def test_material_cap_is_disclosed(self):
        body = client.post(
            "/pricing/estimate",
            json={**BASE_REQUEST, "material_cost": 1_000_000},
        ).json()
        assert body["cost_breakdown"]["material_cost"] == 2700
        assert any("capped" in note for note in body["notes"])


class TestUploadEndpoint:
    def test_accepts_multipart_with_an_image(self):
        response = client.post(
            "/pricing/estimate-upload",
            data={
                "category": "pottery",
                "material_cost": "480",
                "crafting_time": "3 days",
                "description": "blue pottery vase",
                "state": "Rajasthan",
                "has_gi_tag": "true",
            },
            files={"file": ("vase.png", _png_bytes(), "image/png")},
        )
        assert response.status_code == 200
        assert response.json()["cost_breakdown"]["labour"] == 2160.0

    def test_works_without_a_file(self):
        response = client.post(
            "/pricing/estimate-upload",
            data={
                "category": "pottery",
                "material_cost": "480",
                "crafting_time": "3 days",
                "description": "blue pottery vase",
            },
        )
        assert response.status_code == 200


class TestCatalogueValidation:
    def test_drops_rows_that_cannot_be_trusted(self):
        rows = [
            {"id": "ok", "price": 100, "category": "pottery", "source": "s",
             "observed_date": "2026-01-01", "description": "a pot"},
            {"id": "no-price", "price": None, "category": "pottery", "source": "s",
             "observed_date": "2026-01-01", "description": "a pot"},
            {"id": "zero-price", "price": 0, "category": "pottery", "source": "s",
             "observed_date": "2026-01-01", "description": "a pot"},
            {"id": "negative", "price": -5, "category": "pottery", "source": "s",
             "observed_date": "2026-01-01", "description": "a pot"},
            {"id": "ok", "price": 200, "category": "pottery", "source": "s",
             "observed_date": "2026-01-01", "description": "duplicate id"},
            {"id": "no-content", "price": 100, "category": "pottery", "source": "s",
             "observed_date": "2026-01-01"},
        ]
        kept, rejected = _validate(rows)
        assert [row["id"] for row in kept] == ["ok"]
        assert rejected == 5

    def test_normalises_category_case(self):
        kept, _ = _validate([
            {"id": "a", "price": 100, "category": "Pottery", "source": "s",
             "observed_date": "2026-01-01", "description": "a pot"}
        ])
        assert kept[0]["category"] == "pottery"


class TestRetrievalPlumbing:
    def _catalogue_with_vectors(self) -> Catalogue:
        instance = Catalogue()
        instance.rows = [
            {"id": "p1", "title": "blue vase", "price": 2450, "category": "pottery",
             "source": "s", "observed_date": "2026-01-01"},
            {"id": "p2", "title": "large vase", "price": 3200, "category": "pottery",
             "source": "s", "observed_date": "2026-01-02"},
            {"id": "t1", "title": "kantha saree", "price": 5100, "category": "textiles",
             "source": "s", "observed_date": "2026-01-03"},
        ]
        vectors = np.zeros((3, FUSED_DIM), dtype=np.float32)
        vectors[0][0] = 1.0
        vectors[1][1] = 1.0
        vectors[2][2] = 1.0
        instance.vectors = vectors
        return instance

    def test_search_respects_the_category_filter(self):
        instance = self._catalogue_with_vectors()
        query = np.zeros(FUSED_DIM, dtype=np.float32)
        query[2] = 1.0

        results = instance.search(query, "pottery", 8)
        assert [n.id for n in results] == ["p1", "p2"]
        assert all(n.price in (2450, 3200) for n in results)

    def test_search_ranks_by_similarity(self):
        instance = self._catalogue_with_vectors()
        query = np.zeros(FUSED_DIM, dtype=np.float32)
        query[1] = 1.0

        results = instance.search(query, "pottery", 8)
        assert results[0].id == "p2"
        assert results[0].similarity == pytest.approx(1.0)

    def test_empty_category_returns_nothing(self):
        instance = self._catalogue_with_vectors()
        query = np.zeros(FUSED_DIM, dtype=np.float32)
        assert instance.search(query, "jewelry", 8) == []

    def test_unready_catalogue_returns_nothing(self):
        instance = Catalogue()
        query = np.zeros(FUSED_DIM, dtype=np.float32)
        assert instance.search(query, "pottery", 8) == []


class TestSampleCatalogueFixture:
    def test_is_marked_synthetic(self):
        import json

        path = catalogue_module.DATA_DIR / "catalogue.sample.json"
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)

        assert payload["synthetic"] is True
        assert "not market data" in payload["warning"]

    def test_every_row_passes_validation(self):
        import json

        path = catalogue_module.DATA_DIR / "catalogue.sample.json"
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)

        kept, rejected = _validate(payload["listings"])
        assert rejected == 0
        assert len(kept) == len(payload["listings"])
