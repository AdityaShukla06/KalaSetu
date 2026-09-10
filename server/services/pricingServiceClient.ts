export type PricingServiceFailureReason = "not_configured" | "timeout" | "provider_error";

export class PricingServiceError extends Error {
  public readonly reason: PricingServiceFailureReason;
  public readonly cause?: unknown;

  constructor(reason: PricingServiceFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = "PricingServiceError";
    this.reason = reason;
    this.cause = cause;
  }
}

export interface PricingServiceRequest {
  category: string;
  materialCost: number;
  craftingTime?: string | number;
  description?: string;
  imageBase64?: string;
  state?: string;
  hasGiTag?: boolean;
}

export interface PricingServiceNeighbour {
  id: string;
  title: string;
  price: number;
  similarity: number;
  source: string;
  observed_date: string;
}

export interface PricingServiceResponse {
  status: "success";
  price: { minimum: number; recommended: number; maximum: number; currency: string };
  driver: "cost_floor" | "market";
  cost_breakdown: {
    material_cost: number;
    crafting_hours: number | null;
    hourly_wage_applied: number;
    wage_source: string;
    labour: number;
    overhead: number;
    production_cost: number;
    fair_margin_percent: number;
    cost_floor: number;
  };
  model: {
    ran: boolean;
    reason: string | null;
    method: string | null;
    predicted_market_price: number | null;
    with_gi_prior?: number | null;
    mean_similarity: number | null;
    weight_applied: number;
    neighbours: PricingServiceNeighbour[];
    comparable_range?: { min: number; max: number } | null;
  };
  assumptions: string[];
  notes: string[];
  reliability: { score: number; label: "High" | "Medium" | "Low" | "Very Low"; components: Record<string, number> };
  channels: Record<
    string,
    { platform: string; fee_percent: number; listing_price: number; take_home: number }
  >;
  catalogue: { version: string; date_range: { from: string; to: string } | null; rows: number };
}

export class PricingServiceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async warmUp(): Promise<void> {
    await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async estimate(input: PricingServiceRequest): Promise<PricingServiceResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/pricing/estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: input.category,
          material_cost: input.materialCost,
          crafting_time: input.craftingTime,
          description: input.description,
          image_base64: input.imageBase64,
          state: input.state,
          has_gi_tag: input.hasGiTag ?? false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new PricingServiceError(
          "provider_error",
          `Pricing service returned ${response.status}`,
          detail.slice(0, 500),
        );
      }

      const payload = (await response.json()) as PricingServiceResponse;
      if (payload.status !== "success") {
        throw new PricingServiceError("provider_error", "Pricing service returned an unexpected payload");
      }
      return payload;
    } catch (err) {
      if (err instanceof PricingServiceError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new PricingServiceError(
          "timeout",
          `Pricing service did not respond within ${this.timeoutMs}ms`,
          err,
        );
      }
      throw new PricingServiceError("provider_error", "Pricing service request failed", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
