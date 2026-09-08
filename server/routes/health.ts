import { Router } from "express";
import { loadEnv } from "../lib/env";
import { collectGroqApiKeys } from "../voice-ai/groq/keyPool";
import { loadImageAiEnv } from "../image-ai";

const BASE_REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"];
const OPTIONAL_EXTRA = [
  "VOICE_AI_PROVIDER",
  "GROQ_API_KEY",
  "GROQ_API_KEY_2",
  "GROQ_API_KEY_3",
  "GROQ_FALLBACK_API_KEYS",
  "GEMINI_API_KEY",
];
const OPTIONAL = [
  "RESEND_API_KEY",
  "SUPABASE_STORAGE_BUCKET",
  "DEMO_FALLBACK_OTP_ENABLED",
  "PUBLIC_APP_URL",
  ...OPTIONAL_EXTRA,
];

const router = Router();

function isSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "";
}

router.get("/", (_req, res) => {
  const provider = (process.env.VOICE_AI_PROVIDER || "groq").toLowerCase();
  const required = [...BASE_REQUIRED, provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY"];
  const missing = required.filter((name) => !isSet(name));

  let configValid = true;
  let configError: string | undefined;

  try {
    loadEnv();
  } catch (err) {
    configValid = false;
    configError = (err as Error).message;
  }

  let backgroundRemovalValid = true;
  let backgroundRemovalError: string | undefined;
  let backgroundRemovalProvider = "none";
  let selfHostedBgRemovalUrl: string | undefined;

  try {
    const imageAiEnv = loadImageAiEnv();
    backgroundRemovalProvider = imageAiEnv.BACKGROUND_REMOVAL_PROVIDER;
    selfHostedBgRemovalUrl = imageAiEnv.SELF_HOSTED_BG_REMOVAL_URL;
  } catch (err) {
    backgroundRemovalValid = false;
    backgroundRemovalError = (err as Error).message;
  }

  res.json({
    status: missing.length === 0 && configValid ? "ok" : "misconfigured",
    version: "1.0.0",
    config: {
      missing,
      provider,
      present: [...new Set([...required, ...OPTIONAL])].filter(isSet),
      groqKeys: collectGroqApiKeys(process.env).length,
      valid: configValid,
      ...(configError ? { error: configError } : {}),
    },
    backgroundRemoval: {
      provider: backgroundRemovalProvider,
      selfHostedUrl: selfHostedBgRemovalUrl,
      valid: backgroundRemovalValid,
      ...(backgroundRemovalError ? { error: backgroundRemovalError } : {}),
    },
  });
});

export default router;
