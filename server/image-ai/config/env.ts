import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    BACKGROUND_REMOVAL_PROVIDER: z.string().default("none"),
    REMOVE_BG_API_KEY: z.string().optional(),
    SELF_HOSTED_BG_REMOVAL_URL: z.string().url().optional(),
    BACKGROUND_REMOVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    SELF_HOSTED_BG_REMOVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

    CRAFT_CLASSIFIER_PROVIDERS: z.string().default("groq,gemini,render"),
    CRAFT_CLASSIFIER_URL: z.string().url().default("https://kala-setu-image-classifier.onrender.com"),
    CRAFT_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
    CRAFT_CLASSIFIER_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
    GEMINI_VISION_MODEL: z.string().optional(),
    GROQ_VISION_MODEL: z.string().default("qwen/qwen3.6-27b"),
    GROQ_VISION_FALLBACK_MODEL: z.string().default("qwen/qwen3.8-27b"),
  })
  .superRefine((env, ctx) => {
    const providers = env.BACKGROUND_REMOVAL_PROVIDER.split(",").map((entry) => entry.trim());

    if (providers.includes("remove-bg") && !env.REMOVE_BG_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REMOVE_BG_API_KEY"],
        message: "REMOVE_BG_API_KEY is required when BACKGROUND_REMOVAL_PROVIDER includes remove-bg",
      });
    }
    if (providers.includes("self-hosted") && !env.SELF_HOSTED_BG_REMOVAL_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SELF_HOSTED_BG_REMOVAL_URL"],
        message: "SELF_HOSTED_BG_REMOVAL_URL is required when BACKGROUND_REMOVAL_PROVIDER includes self-hosted",
      });
    }
  });

export type ImageAiEnv = z.infer<typeof envSchema>;

let cached: ImageAiEnv | undefined;

function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

export function loadImageAiEnv(): ImageAiEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid image-ai environment configuration: ${issues}`);
  }

  cached = parsed.data;
  return cached;
}

export function resetImageAiEnvCache(): void {
  cached = undefined;
}
