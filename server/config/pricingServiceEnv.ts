import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PRICING_SERVICE_URL: z.string().url().optional(),
  PRICING_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
});

export type PricingServiceEnv = z.infer<typeof envSchema>;

let cached: PricingServiceEnv | undefined;

function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

export function loadPricingServiceEnv(): PricingServiceEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid pricing service environment configuration: ${issues}`);
  }

  cached = parsed.data;
  return cached;
}

export function resetPricingServiceEnvCache(): void {
  cached = undefined;
}
