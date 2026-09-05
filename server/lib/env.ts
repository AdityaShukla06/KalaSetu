import { z } from "zod";

const envSchema = z
  .object({
  SUPABASE_URL: z.string().url("SUPABASE_URL must be your project URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_STORAGE_BUCKET: z.string().default("product-images"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  VOICE_AI_PROVIDER: z.enum(["groq", "gemini"]).default("groq"),
  GROQ_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  OTP_FROM_EMAIL: z.string().default("KalaSetu <onboarding@resend.dev>"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),

  DEMO_FALLBACK_OTP: z.string().default("5741"),
  DEMO_FALLBACK_OTP_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  })
  .superRefine((env, ctx) => {
    const provider = env.VOICE_AI_PROVIDER;
    if (provider === "groq" && !env.GROQ_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GROQ_API_KEY"],
        message: "GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq",
      });
    }
    if (provider === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GEMINI_API_KEY"],
        message: "GEMINI_API_KEY is required when VOICE_AI_PROVIDER is gemini",
      });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

/**
 * A key left blank in a .env file arrives as an empty string, which would
 * satisfy z.string() and defeat every .default(). Dropping blanks makes an
 * unset key and a blank key behave the same way.
 */
export function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

export function loadEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment configuration: ${issues}`);
  }

  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
