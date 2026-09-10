import pytest

from blend import apply_gi_premium, blend, ceil_to_sensible, driver_of, price_band, round_to_sensible
from channels import channel_prices
from constants import MAX_CRAFTING_HOURS, SIM_CEILING, SIM_FLOOR, W_MAX
from cost import compute_floor
from crafting_time import parse_crafting_time
from guards import PricingError, clamp_hours, clamp_material_cost, require_known_category, require_material_cost
from reference import hourly_wage
from reliability import label_for, score_reliability
from retrieval import Neighbour, comparable_range, confidence_weight, mean_similarity, weighted_median

POTTERY_NEIGHBOURS = [
    Neighbour("sample-pot-1", "Jaipur blue pottery vase, GI", 2800, 0.91, "sample", "2026-08-30"),
    Neighbour("sample-pot-2", "Blue pottery flower vase", 2450, 0.88, "sample", "2026-08-28"),
    Neighbour("sample-pot-3", "Blue pottery vase, large", 3200, 0.86, "sample", "2026-08-22"),
    Neighbour("sample-pot-4", "Hand painted ceramic vase", 2100, 0.81, "sample", "2026-08-19"),
    Neighbour("sample-pot-5", "Blue pottery jar", 1950, 0.79, "sample", "2026-08-15"),
    Neighbour("sample-pot-6", "Ceramic decorative vase", 2600, 0.77, "sample", "2026-08-11"),
    Neighbour("sample-pot-7", "Terracotta vase", 1400, 0.72, "sample", "2026-07-30"),
    Neighbour("sample-pot-8", "Painted pot", 1250, 0.68, "sample", "2026-07-14"),
]

TEXTILE_NEIGHBOURS = [
    Neighbour("sample-tex-1", "Kantha hand embroidered silk saree", 5800, 0.90, "sample", "2026-08-29"),
    Neighbour("sample-tex-2", "Bengal kantha cotton saree", 4200, 0.88, "sample", "2026-08-25"),
    Neighbour("sample-tex-3", "Hand embroidered kantha saree", 5100, 0.87, "sample", "2026-08-21"),
    Neighbour("sample-tex-4", "Kantha stitch tussar saree", 6500, 0.85, "sample", "2026-08-18"),
    Neighbour("sample-tex-5", "Handloom cotton saree, Bengal", 3600, 0.83, "sample", "2026-08-12"),
    Neighbour("sample-tex-6", "Bengal handloom saree", 3900, 0.81, "sample", "2026-08-05"),
    Neighbour("sample-tex-7", "Embroidered silk saree", 7200, 0.78, "sample", "2026-07-28"),
    Neighbour("sample-tex-8", "Cotton handloom saree", 3200, 0.68, "sample", "2026-07-20"),
]


class TestWorkedExampleOne:
    def test_cost_floor(self):
        wage, source = hourly_wage("Rajasthan")
        assert wage == 90.0
        assert source == "Rajasthan"

        breakdown = compute_floor(480.0, 24.0, wage, source)
        assert breakdown.labour == 2160.0
        assert breakdown.overhead == 264.0
        assert breakdown.production_cost == 2904.0
        assert breakdown.cost_floor == pytest.approx(3484.80)

    def test_market_side(self):
        assert weighted_median(POTTERY_NEIGHBOURS) == 2450
        assert mean_similarity(POTTERY_NEIGHBOURS) == pytest.approx(0.8025)
        assert confidence_weight(0.8025) == pytest.approx(0.27)
        assert apply_gi_premium(2450, True) == pytest.approx(2695.0)

    def test_floor_wins_and_rounds(self):
        floor = 3484.80
        raw = blend(floor, apply_gi_premium(2450, True), 0.27)
        assert raw == pytest.approx(3484.80)
        assert driver_of(floor, raw) == "cost_floor"

        band = price_band(floor, raw)
        assert band["minimum"] == 3500
        assert band["recommended"] == 3500
        assert band["maximum"] == 4200

    def test_channels(self):
        channels = channel_prices(3500)
        assert channels["direct"]["listing_price"] == 3500
        assert channels["gem"]["listing_price"] == 3550
        assert channels["ondc"]["listing_price"] == 3650
        assert channels["commercial"]["listing_price"] == 4300


class TestWorkedExampleTwo:
    def test_cost_floor(self):
        wage, source = hourly_wage("West Bengal")
        assert wage == 80.0

        breakdown = compute_floor(800.0, 24.0, wage, source)
        assert breakdown.labour == 1920.0
        assert breakdown.overhead == 272.0
        assert breakdown.production_cost == 2992.0
        assert breakdown.cost_floor == pytest.approx(3590.40)

    def test_market_pulls_up(self):
        assert weighted_median(TEXTILE_NEIGHBOURS) == 5100
        assert mean_similarity(TEXTILE_NEIGHBOURS) == pytest.approx(0.825)
        assert confidence_weight(0.825) == pytest.approx(0.30)

        floor = 3590.40
        raw = blend(floor, 5100.0, 0.30)
        assert raw == pytest.approx(4043.28)
        assert driver_of(floor, raw) == "market"

        band = price_band(floor, raw)
        assert band["minimum"] == 3600
        assert band["recommended"] == 4050
        assert band["maximum"] == 4850

    def test_channels(self):
        channels = channel_prices(4050)
        assert channels["gem"]["listing_price"] == 4100
        assert channels["ondc"]["listing_price"] == 4250
        assert channels["commercial"]["listing_price"] == 4950


class TestWeightedMedian:
    def test_single_neighbour(self):
        only = [Neighbour("a", "x", 999, 0.7, "s", "2026-01-01")]
        assert weighted_median(only) == 999

    def test_equal_similarity_reduces_to_median(self):
        rows = [
            Neighbour("a", "x", 100, 0.8, "s", "2026-01-01"),
            Neighbour("b", "x", 200, 0.8, "s", "2026-01-01"),
            Neighbour("c", "x", 300, 0.8, "s", "2026-01-01"),
        ]
        assert weighted_median(rows) == 200

    def test_outlier_does_not_drag_the_estimate(self):
        with_outlier = POTTERY_NEIGHBOURS + [
            Neighbour("outlier", "gold vase", 200000, 0.61, "sample", "2026-01-01")
        ]
        assert weighted_median(with_outlier) == 2450

    def test_ties_are_deterministic(self):
        rows = [
            Neighbour("b", "x", 500, 0.5, "s", "2026-01-01"),
            Neighbour("a", "x", 500, 0.5, "s", "2026-01-01"),
        ]
        assert weighted_median(rows) == weighted_median(list(reversed(rows)))

    def test_comparable_range(self):
        assert comparable_range(POTTERY_NEIGHBOURS) == {"min": 1250, "max": 3200}


class TestConfidenceWeight:
    def test_zero_at_floor(self):
        assert confidence_weight(SIM_FLOOR) == 0.0

    def test_zero_below_floor(self):
        assert confidence_weight(0.4) == 0.0

    def test_max_at_ceiling(self):
        assert confidence_weight(SIM_CEILING) == pytest.approx(W_MAX)

    def test_saturates_above_ceiling(self):
        assert confidence_weight(0.99) == pytest.approx(W_MAX)


class TestFloorInvariant:
    @pytest.mark.parametrize("weight", [0.0, 0.05, 0.1, 0.2, 0.27, 0.3, 0.4])
    @pytest.mark.parametrize("market", [0.0, 1.0, 500.0, 5000.0, 100000.0])
    def test_recommended_never_below_floor(self, weight, market):
        floor = 3484.80
        raw = blend(floor, market, weight)
        assert raw >= floor
        band = price_band(floor, raw)
        assert band["minimum"] >= floor
        assert band["recommended"] >= band["minimum"]
        assert band["maximum"] >= band["recommended"]

    @pytest.mark.parametrize("floor", [17.0, 63.0, 101.0, 499.0, 1999.0, 2001.0, 47311.0])
    def test_minimum_never_rounds_below_floor(self, floor):
        band = price_band(floor, floor)
        assert band["minimum"] >= floor


class TestChannelInvariant:
    @pytest.mark.parametrize("recommended", [40, 99, 250, 499, 1500, 1999, 3500, 4050, 99000])
    def test_take_home_covers_recommendation(self, recommended):
        for channel in channel_prices(recommended).values():
            assert channel["take_home"] >= recommended


class TestRounding:
    def test_tiers(self):
        assert round_to_sensible(47.4) == 47
        assert round_to_sensible(312.0) == 310
        assert round_to_sensible(1497.0) == 1500
        assert round_to_sensible(3194.0) == 3200

    def test_ceil_tiers(self):
        assert ceil_to_sensible(47.1) == 48
        assert ceil_to_sensible(311.0) == 315
        assert ceil_to_sensible(1491.0) == 1500
        assert ceil_to_sensible(3151.0) == 3200


class TestCraftingTime:
    @pytest.mark.parametrize(
        "text,hours",
        [
            ("3 days", 24.0),
            ("3 Days", 24.0),
            ("72 hours", 72.0),
            ("2 weeks", 96.0),
            ("1 month", 192.0),
            ("5 din", 40.0),
            ("2 hafte", 96.0),
            ("१२ दिन", 96.0),
            ("4 घंटे", 4.0),
        ],
    )
    def test_parses(self, text, hours):
        assert parse_crafting_time(text).hours == hours

    def test_range_takes_lower_bound(self):
        parsed = parse_crafting_time("3 to 4 days")
        assert parsed.hours == 24.0
        assert any("lower" in note for note in parsed.notes)

    def test_hyphen_range(self):
        assert parse_crafting_time("3-4 days").hours == 24.0

    def test_numeric_input_is_hours(self):
        assert parse_crafting_time(18).hours == 18.0

    def test_no_number_does_not_guess(self):
        parsed = parse_crafting_time("a few days")
        assert parsed.hours is None
        assert parsed.notes

    def test_no_unit_does_not_guess(self):
        parsed = parse_crafting_time("quite a while")
        assert parsed.hours is None
        assert parsed.notes

    def test_empty_does_not_guess(self):
        assert parse_crafting_time(None).hours is None
        assert parse_crafting_time("").hours is None

    def test_day_conversion_is_disclosed(self):
        parsed = parse_crafting_time("3 days")
        assert parsed.assumptions
        assert "24 hours" in parsed.assumptions[0]

    def test_hours_need_no_assumption(self):
        assert parse_crafting_time("24 hours").assumptions == []


class TestGuards:
    def test_rejects_zero_material_cost(self):
        with pytest.raises(PricingError) as caught:
            require_material_cost(0)
        assert caught.value.code == "material_cost_required"

    def test_rejects_negative_material_cost(self):
        with pytest.raises(PricingError):
            require_material_cost(-50)

    def test_rejects_missing_material_cost(self):
        with pytest.raises(PricingError):
            require_material_cost(None)

    def test_rejects_unknown_category(self):
        with pytest.raises(PricingError) as caught:
            require_known_category("spacecraft")
        assert caught.value.code == "unknown_category"

    def test_accepts_known_category_case_insensitively(self):
        assert require_known_category("Pottery") == "pottery"

    def test_caps_absurd_material_cost(self):
        value, notes = clamp_material_cost(1_000_000, "pottery")
        assert value == 2700
        assert notes and "capped" in notes[0]

    def test_warns_without_clamping_inside_the_cap(self):
        value, notes = clamp_material_cost(2000, "pottery")
        assert value == 2000
        assert notes

    def test_quiet_inside_typical_range(self):
        value, notes = clamp_material_cost(400, "pottery")
        assert value == 400
        assert notes == []

    def test_caps_absurd_hours(self):
        hours, notes = clamp_hours(50_000)
        assert hours == MAX_CRAFTING_HOURS
        assert notes

    def test_leaves_reasonable_hours(self):
        assert clamp_hours(24.0) == (24.0, [])


class TestWages:
    def test_known_state(self):
        assert hourly_wage("Rajasthan")[0] == 90.0

    def test_alias(self):
        assert hourly_wage("WB")[0] == 80.0

    def test_kashmir_alias_resolves(self):
        wage, name = hourly_wage("kashmir")
        assert wage == 110.0
        assert name == "Jammu and Kashmir"

    def test_unknown_falls_back_to_national(self):
        wage, name = hourly_wage("Atlantis")
        assert wage == 85.0
        assert name == "National default"

    def test_missing_falls_back_to_national(self):
        assert hourly_wage(None)[0] == 85.0


class TestReliability:
    def test_full_marks(self):
        result = score_reliability(True, 0.9, 24.0, False, True, True)
        assert result["score"] == 100
        assert result["label"] == "High"

    def test_no_model_no_time(self):
        result = score_reliability(False, 0.0, None, False, False, False)
        assert result["score"] == 0
        assert result["label"] == "Very Low"

    def test_worked_example_one(self):
        result = score_reliability(True, 0.8025, 24.0, True, True, True)
        assert result["score"] == 80

    def test_labels(self):
        assert label_for(80) == "High"
        assert label_for(60) == "Medium"
        assert label_for(40) == "Low"
        assert label_for(39) == "Very Low"


class TestCostWithoutHours:
    def test_labour_is_zero_not_guessed(self):
        breakdown = compute_floor(500.0, None, 85.0, "National default")
        assert breakdown.labour == 0.0
        assert breakdown.crafting_hours is None
        assert breakdown.production_cost == pytest.approx(550.0)
        assert breakdown.cost_floor == pytest.approx(660.0)
