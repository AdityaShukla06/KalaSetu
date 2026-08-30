import { Router } from "express";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET", "GEMINI_API_KEY"];
const OPTIONAL = ["RESEND_API_KEY", "SUPABASE_STORAGE_BUCKET", "DEMO_FALLBACK_OTP_ENABLED"];

const router = Router();

function isSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "";
}

router.get("/", (_req, res) => {
  const missing = REQUIRED.filter((name) => !isSet(name));

  res.json({
    status: missing.length === 0 ? "ok" : "misconfigured",
    version: "1.0.0",
    config: {
      missing,
      present: [...REQUIRED, ...OPTIONAL].filter(isSet),
    },
  });
});

export default router;
