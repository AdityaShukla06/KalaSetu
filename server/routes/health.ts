import { Router } from "express";
import { loadEnv } from "../lib/env";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET", "GEMINI_API_KEY"];
const OPTIONAL = ["RESEND_API_KEY", "SUPABASE_STORAGE_BUCKET", "DEMO_FALLBACK_OTP_ENABLED"];

const router = Router();

function isSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "";
}

router.get("/", (_req, res) => {
  const missing = REQUIRED.filter((name) => !isSet(name));

  let configValid = true;
  let configError: string | undefined;

  try {
    loadEnv();
  } catch (err) {
    configValid = false;
    configError = (err as Error).message;
  }

  res.json({
    status: missing.length === 0 && configValid ? "ok" : "misconfigured",
    version: "1.0.0",
    config: {
      missing,
      present: [...REQUIRED, ...OPTIONAL].filter(isSet),
      valid: configValid,
      ...(configError ? { error: configError } : {}),
    },
  });
});

export default router;
