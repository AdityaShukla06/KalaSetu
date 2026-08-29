import "dotenv/config";
import { z } from "zod";

/**
 * All environment variables this module needs. BHASHINI variables are
 * OPTIONAL at the schema level: when they're absent, callers should wire up
 * MockTranslationService instead of BhashiniTranslationService (see
 * pipeline/factory.ts). This lets the module run end-to-end (Phase 1) before
 * BHASHINI credentials exist, without the schema itself lying about what's
 * "required".
 */
const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),

  // BHASHINI / ULCA — optional until Phase 2. See translation/bhashini.service.ts
  // for exactly which of these are verified-real vs. still placeholders.
  BHASHINI_ULCA_USER_ID: z.string().optional(),
  BHASHINI_ULCA_API_KEY: z.string().optional(),
  BHASHINI_PIPELINE_ID: z.string().optional(),

  // Optional model overrides, so a model can be pinned or upgraded without a
  // code change. Defaults are GA models that support audio input, text
  // generation, and structured JSON output. See "Model IDs" in
  // `remaining tasks.md` before changing these.
  GEMINI_TRANSCRIBE_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_FLASH_MODEL: z.string().default("gemini-2.5-flash"),
});

export type VoiceAiEnv = z.infer<typeof envSchema>;

let cached: VoiceAiEnv | undefined;

/**
 * Lazily parses and caches process.env against the schema. Throws a clear
 * error listing every missing/invalid variable rather than failing deep
 * inside a provider call.
 */
export function loadEnv(): VoiceAiEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid voice-ai environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function hasBhashiniCredentials(env: VoiceAiEnv = loadEnv()): boolean {
  return Boolean(env.BHASHINI_ULCA_USER_ID && env.BHASHINI_ULCA_API_KEY && env.BHASHINI_PIPELINE_ID);
}
