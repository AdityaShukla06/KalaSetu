import { describe, it, expect, vi, afterEach } from "vitest";
import { PricingServiceClient, PricingServiceError } from "./pricingServiceClient";

function fixtureResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: "success",
    price: { minimum: 3500, recommended: 3500, maximum: 4200, currency: "INR" },
    driver: "cost_floor",
    cost_breakdown: {
      material_cost: 480,
      crafting_hours: 24,
      hourly_wage_applied: 90,
      wage_source: "Rajasthan",
      labour: 2160,
      overhead: 264,
      production_cost: 2904,
      fair_margin_percent: 20,
      cost_floor: 3484.8,
    },
    model: {
      ran: false,
      reason: "no comparable listings",
      method: null,
      predicted_market_price: null,
      mean_similarity: null,
      weight_applied: 0,
      neighbours: [],
      comparable_range: null,
    },
    assumptions: [],
    notes: [],
    reliability: { score: 40, label: "Low", components: {} },
    channels: {},
    catalogue: { version: "sample-fixture", date_range: null, rows: 16 },
    ...overrides,
  };
}

describe("PricingServiceClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts the estimate request as JSON and returns the parsed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixtureResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PricingServiceClient("https://pricing.onrender.com/", 5000);
    const result = await client.estimate({
      category: "pottery",
      materialCost: 480,
      craftingTime: "3 days",
      state: "Rajasthan",
      hasGiTag: true,
    });

    expect(result.price.recommended).toBe(3500);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pricing.onrender.com/pricing/estimate",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      category: "pottery",
      material_cost: 480,
      crafting_time: "3 days",
      state: "Rajasthan",
      has_gi_tag: true,
    });
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixtureResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PricingServiceClient("https://pricing.onrender.com///", 5000);
    await client.estimate({ category: "pottery", materialCost: 480 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pricing.onrender.com/pricing/estimate",
      expect.anything(),
    );
  });

  it("throws a provider_error on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PricingServiceClient("https://pricing.onrender.com", 5000);
    await expect(client.estimate({ category: "pottery", materialCost: 480 })).rejects.toMatchObject({
      reason: "provider_error",
    });
  });

  it("throws a timeout error when the request is aborted", async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PricingServiceClient("https://pricing.onrender.com", 10);
    await expect(client.estimate({ category: "pottery", materialCost: 480 })).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("rejects a payload that is not a success status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "error", code: "unknown_category" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PricingServiceClient("https://pricing.onrender.com", 5000);
    await expect(client.estimate({ category: "pottery", materialCost: 480 })).rejects.toBeInstanceOf(
      PricingServiceError,
    );
  });

  it("warmUp hits the root health route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PricingServiceClient("https://pricing.onrender.com", 5000);
    await client.warmUp();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pricing.onrender.com/",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
