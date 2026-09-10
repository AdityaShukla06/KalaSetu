import { loadPricingServiceEnv } from "../config/pricingServiceEnv";
import { PricingServiceClient } from "./pricingServiceClient";

let cachedClient: PricingServiceClient | null | undefined;

function buildPricingServiceClient(): PricingServiceClient | null {
  const env = loadPricingServiceEnv();
  if (!env.PRICING_SERVICE_URL) return null;
  return new PricingServiceClient(env.PRICING_SERVICE_URL, env.PRICING_SERVICE_TIMEOUT_MS);
}

export function getPricingServiceClient(): PricingServiceClient | null {
  if (cachedClient === undefined) cachedClient = buildPricingServiceClient();
  return cachedClient;
}

export function resetPricingServiceCache(): void {
  cachedClient = undefined;
}
