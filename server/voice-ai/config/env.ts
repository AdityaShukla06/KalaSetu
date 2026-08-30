import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_TRANSCRIBE_MODEL: z.string().default("gemini-3.6-flash"),
  GEMINI_FLASH_MODEL: z.string().default("gemini-3.6-flash"),
});

export type VoiceAiEnv = z.infer<typeof envSchema>;

let cached: VoiceAiEnv | undefined;

function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

export function loadEnv(): VoiceAiEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid voice-ai environment configuration: ${issues}`);
  }

  cached = parsed.data;
  return cached;
}
