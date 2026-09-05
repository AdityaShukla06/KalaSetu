import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    VOICE_AI_PROVIDER: z.enum(["groq", "gemini"]).default("groq"),

    GROQ_API_KEY: z.string().optional(),
    GROQ_FALLBACK_API_KEYS: z.string().optional(),
    GROQ_STT_MODEL: z.string().default("whisper-large-v3"),
    GROQ_LLM_MODEL: z.string().default("openai/gpt-oss-120b"),
    GROQ_LLM_FALLBACK_MODEL: z.string().default("openai/gpt-oss-20b"),

    GEMINI_API_KEY: z.string().optional(),
    GEMINI_TRANSCRIBE_MODEL: z.string().default("gemini-3.6-flash"),
    GEMINI_FLASH_MODEL: z.string().default("gemini-3.6-flash"),
  })
  .superRefine((env, ctx) => {
    if (env.VOICE_AI_PROVIDER === "groq" && !env.GROQ_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GROQ_API_KEY"],
        message: "GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq",
      });
    }
    if (env.VOICE_AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GEMINI_API_KEY"],
        message: "GEMINI_API_KEY is required when VOICE_AI_PROVIDER is gemini",
      });
    }
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

export function resetVoiceAiEnvCache(): void {
  cached = undefined;
}
