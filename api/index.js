// server/app.ts
import express from "express";
import cors from "cors";

// server/routes/health.ts
import { Router } from "express";

// server/lib/env.ts
import { z } from "zod";
var envSchema = z.object({
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
  DEMO_FALLBACK_OTP_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() !== "false")
}).superRefine((env, ctx) => {
  const provider = env.VOICE_AI_PROVIDER;
  if (provider === "groq" && !env.GROQ_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GROQ_API_KEY"],
      message: "GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq"
    });
  }
  if (provider === "gemini" && !env.GEMINI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GEMINI_API_KEY"],
      message: "GEMINI_API_KEY is required when VOICE_AI_PROVIDER is gemini"
    });
  }
});
var cached;
function withoutBlanks(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}
function loadEnv() {
  if (cached) return cached;
  const parsed = envSchema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

// server/voice-ai/groq/keyPool.ts
var DAILY_COOLDOWN_MS = 15 * 60 * 1e3;
var SHORT_COOLDOWN_MS = 60 * 1e3;
var MAX_COOLDOWN_MS = 60 * 60 * 1e3;
function parseGroqApiKeys(primary, fallbacks) {
  const raw = [primary ?? "", ...(fallbacks ?? "").split(",")];
  const seen = /* @__PURE__ */ new Set();
  const keys = [];
  for (const entry of raw) {
    const key = entry.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
function isDailyQuotaMessage(detail) {
  return /tokens per day|TPD|requests per day|RPD/i.test(detail);
}
function retryAfterMsFromDetail(detail) {
  const match = /try again in ([0-9.]+)(ms|s|m|h)?/i.exec(detail);
  if (!match) return void 0;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return void 0;
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 1e3;
  return Math.min(MAX_COOLDOWN_MS, Math.ceil(value * multiplier) + 1500);
}
function cooldownForDetail(detail) {
  return retryAfterMsFromDetail(detail) ?? (isDailyQuotaMessage(detail) ? DAILY_COOLDOWN_MS : SHORT_COOLDOWN_MS);
}
function maskKey(key) {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}...${key.slice(-4)}`;
}
var GroqKeyPool = class {
  keys;
  restingUntil = /* @__PURE__ */ new Map();
  constructor(keys) {
    this.keys = keys;
  }
  get size() {
    return this.keys.length;
  }
  /**
   * Keys that are not currently resting, in configured order, falling back to
   * every key when they are all resting. Never returning an empty list matters:
   * an expired cooldown we mis-timed should cost a failed attempt, not turn a
   * recoverable request into an instant failure.
   */
  usableKeys(now = Date.now()) {
    const usable = this.keys.filter((key) => (this.restingUntil.get(key) ?? 0) <= now);
    return usable.length > 0 ? usable : this.keys;
  }
  rest(key, detail, now = Date.now()) {
    const cooldown = cooldownForDetail(detail);
    this.restingUntil.set(key, now + cooldown);
    console.warn("[voice-ai] Groq key rate limited, resting it", {
      key: maskKey(key),
      forSeconds: Math.round(cooldown / 1e3),
      dailyQuota: isDailyQuotaMessage(detail),
      remainingKeys: this.usableKeys(now).length
    });
  }
};

// server/routes/health.ts
var BASE_REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"];
var OPTIONAL_EXTRA = ["VOICE_AI_PROVIDER", "GROQ_API_KEY", "GROQ_FALLBACK_API_KEYS", "GEMINI_API_KEY"];
var OPTIONAL = ["RESEND_API_KEY", "SUPABASE_STORAGE_BUCKET", "DEMO_FALLBACK_OTP_ENABLED", ...OPTIONAL_EXTRA];
var router = Router();
function isSet(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "";
}
router.get("/", (_req, res) => {
  const provider = (process.env.VOICE_AI_PROVIDER || "groq").toLowerCase();
  const required = [...BASE_REQUIRED, provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY"];
  const missing = required.filter((name) => !isSet(name));
  let configValid = true;
  let configError;
  try {
    loadEnv();
  } catch (err) {
    configValid = false;
    configError = err.message;
  }
  res.json({
    status: missing.length === 0 && configValid ? "ok" : "misconfigured",
    version: "1.0.0",
    config: {
      missing,
      provider,
      present: [.../* @__PURE__ */ new Set([...required, ...OPTIONAL])].filter(isSet),
      groqKeys: parseGroqApiKeys(process.env.GROQ_API_KEY, process.env.GROQ_FALLBACK_API_KEYS).length,
      valid: configValid,
      ...configError ? { error: configError } : {}
    }
  });
});
var health_default = router;

// server/routes/auth.ts
import { Router as Router2 } from "express";
import { z as z2 } from "zod";

// server/middleware/asyncRoute.ts
function asyncRoute(handler2) {
  return (req, res, next) => {
    handler2(req, res, next).catch(next);
  };
}

// server/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
var cached2;
function getSupabase() {
  if (cached2) return cached2;
  const env = loadEnv();
  cached2 = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return cached2;
}
function getStorageBucket() {
  return loadEnv().SUPABASE_STORAGE_BUCKET;
}

// server/lib/jwt.ts
import jwt from "jsonwebtoken";
function signSessionToken(claims) {
  const env = loadEnv();
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN
  });
}
function verifySessionToken(token) {
  const env = loadEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded === "string" || !decoded.sub || typeof decoded.sub !== "string") {
    throw new Error("Session token is missing a subject");
  }
  const email = decoded.email;
  if (typeof email !== "string") {
    throw new Error("Session token is missing an email");
  }
  return { sub: decoded.sub, email };
}

// server/lib/otp.ts
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
var OTP_LENGTH = 4;
var OTP_TTL_MINUTES = 10;
var OTP_MAX_ATTEMPTS = 5;
function generateOtp() {
  return randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
}
function hashOtp(code) {
  return createHash("sha256").update(code).digest("hex");
}
function otpMatches(candidate, expectedHash) {
  const a = Buffer.from(hashOtp(candidate), "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function normaliseEmail(email) {
  return email.trim().toLowerCase();
}

// server/lib/mailer.ts
async function sendOtpEmail(email, code) {
  const env = loadEnv();
  if (!env.RESEND_API_KEY) {
    console.warn("[auth] RESEND_API_KEY is not set, OTP email was not sent", { email });
    return { delivered: false, reason: "email_not_configured" };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.OTP_FROM_EMAIL,
        to: [email],
        subject: `${code} is your KalaSetu code`,
        text: buildPlainTextBody(code),
        html: buildHtmlBody(code)
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("[auth] OTP email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500)
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.error("[auth] OTP email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}
function buildPlainTextBody(code) {
  return [
    `Your KalaSetu verification code is ${code}.`,
    ``,
    `It expires in ${OTP_TTL_MINUTES} minutes.`,
    `If you did not ask to sign in, you can ignore this email.`
  ].join("\n");
}
function buildHtmlBody(code) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#2b2b2b">
  <h1 style="font-size:20px;margin:0 0 16px">Your KalaSetu code</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 20px">Enter this code to sign in.</p>
  <p style="font-size:34px;font-weight:700;letter-spacing:10px;margin:0 0 20px;color:#C1502E">${code}</p>
  <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0">It expires in ${OTP_TTL_MINUTES} minutes. If you did not ask to sign in, you can ignore this email.</p>
</div>`;
}
var CONTACT_PREFERENCE_LABEL = {
  email: "Email",
  phone: "A phone call",
  whatsapp: "WhatsApp"
};
async function sendInquiryEmail(input) {
  const env = loadEnv();
  if (!env.RESEND_API_KEY) {
    console.warn("[inquiries] RESEND_API_KEY is not set, inquiry email was not sent", {
      artisanEmail: input.artisanEmail
    });
    return { delivered: false, reason: "email_not_configured" };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.OTP_FROM_EMAIL,
        to: [input.artisanEmail],
        subject: `New inquiry on KalaSetu: ${input.productTitle}`,
        text: buildInquiryPlainTextBody(input),
        html: buildInquiryHtmlBody(input)
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("[inquiries] inquiry email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500)
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.error("[inquiries] inquiry email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}
function contactLine(input) {
  const label = CONTACT_PREFERENCE_LABEL[input.contactPreference];
  if (input.contactPreference === "email") return `${label}: ${input.buyerEmail}`;
  return `${label}: ${input.contactValue ?? input.buyerEmail}`;
}
function buildInquiryPlainTextBody(input) {
  const lines = [
    `You have a new inquiry on KalaSetu.`,
    ``,
    `Product: ${input.productTitle} (${input.passportId})`
  ];
  if (input.quantity) lines.push(`Quantity interested in: ${input.quantity}`);
  lines.push(``, `Message:`, `"${input.buyerMessage}"`, ``, `Preferred contact: ${contactLine(input)}`, ``);
  lines.push(`View and respond in KalaSetu: ${input.inboxUrl}`);
  return lines.join("\n");
}
function buildInquiryHtmlBody(input) {
  const quantityRow = input.quantity ? `<p style="font-size:14px;line-height:1.5;margin:0 0 12px"><strong>Quantity interested in:</strong> ${input.quantity}</p>` : "";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2b2b2b">
  <h1 style="font-size:20px;margin:0 0 16px">You have a new inquiry</h1>
  <img src="${input.productImageUrl}" alt="" style="width:100%;max-width:280px;border-radius:8px;margin:0 0 16px;display:block" />
  <p style="font-size:15px;line-height:1.5;margin:0 0 4px"><strong>${input.productTitle}</strong></p>
  <p style="font-size:13px;color:#6b6b6b;margin:0 0 16px">${input.passportId}</p>
  ${quantityRow}
  <p style="font-size:14px;line-height:1.5;margin:0 0 4px"><strong>Message</strong></p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 16px;padding:12px;background:#FBF4EA;border-radius:8px">${input.buyerMessage}</p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px"><strong>Preferred contact:</strong> ${contactLine(input)}</p>
  <a href="${input.inboxUrl}" style="display:inline-block;padding:12px 20px;background:#C1502E;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">View and respond in KalaSetu</a>
</div>`;
}

// server/routes/auth.ts
var router2 = Router2();
var RequestOtpSchema = z2.object({
  email: z2.string().email("Enter a valid email address")
});
var SELF_SERVE_ROLES = ["artisan", "buyer"];
var VerifyOtpSchema = z2.object({
  email: z2.string().email(),
  otp: z2.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `OTP must be ${OTP_LENGTH} digits`),
  intendedRole: z2.enum(SELF_SERVE_ROLES).optional().default("artisan")
});
router2.post(
  "/request-otp",
  asyncRoute(async (req, res) => {
    const parsed = RequestOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const email = normaliseEmail(parsed.data.email);
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 6e4).toISOString();
    const supabase = getSupabase();
    const { error } = await supabase.from("otp_codes").insert({
      email,
      code_hash: hashOtp(code),
      expires_at: expiresAt
    });
    if (error) {
      throw new Error(`Could not store the OTP: ${error.message}`);
    }
    const mail = await sendOtpEmail(email, code);
    res.json({
      success: true,
      emailDelivered: mail.delivered,
      expiresInMinutes: OTP_TTL_MINUTES
    });
  })
);
router2.post(
  "/verify-otp",
  asyncRoute(async (req, res) => {
    const parsed = VerifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const env = loadEnv();
    const email = normaliseEmail(parsed.data.email);
    const supabase = getSupabase();
    const usedFallback = env.DEMO_FALLBACK_OTP_ENABLED && parsed.data.otp === env.DEMO_FALLBACK_OTP;
    if (usedFallback) {
      console.warn(
        "[auth] SECURITY: demo fallback OTP accepted. Set DEMO_FALLBACK_OTP_ENABLED=false to disable.",
        { email }
      );
    } else {
      const { data: rows, error } = await supabase.from("otp_codes").select("id, code_hash, expires_at, attempts, consumed_at").eq("email", email).is("consumed_at", null).order("created_at", { ascending: false }).limit(1);
      if (error) {
        throw new Error(`Could not read the OTP: ${error.message}`);
      }
      const record = rows?.[0];
      if (!record) {
        res.status(400).json({ error: "otp_not_found" });
        return;
      }
      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        res.status(429).json({ error: "too_many_attempts" });
        return;
      }
      if (new Date(record.expires_at).getTime() < Date.now()) {
        res.status(400).json({ error: "otp_expired" });
        return;
      }
      if (!otpMatches(parsed.data.otp, record.code_hash)) {
        await supabase.from("otp_codes").update({ attempts: record.attempts + 1 }).eq("id", record.id);
        res.status(400).json({ error: "otp_incorrect" });
        return;
      }
      await supabase.from("otp_codes").update({ consumed_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", record.id);
    }
    const { userId, role, isActive } = await findOrCreateUser(email, parsed.data.intendedRole);
    if (!isActive) {
      res.status(403).json({ error: "account_deactivated" });
      return;
    }
    const token = signSessionToken({ sub: userId, email });
    res.json({ token, userId, email, role });
  })
);
async function findOrCreateUser(email, intendedRole) {
  const supabase = getSupabase();
  const { data: existing, error: readError } = await supabase.from("users").select("id, role, is_active").eq("email", email).maybeSingle();
  if (readError) {
    throw new Error(`Could not look up the user: ${readError.message}`);
  }
  if (existing) return { userId: existing.id, role: existing.role, isActive: existing.is_active };
  const { data: created, error: writeError } = await supabase.from("users").insert({ email, role: intendedRole }).select("id, role, is_active").single();
  if (writeError) {
    if (writeError.code === "23505") {
      const { data: raced } = await supabase.from("users").select("id, role, is_active").eq("email", email).single();
      if (raced) return { userId: raced.id, role: raced.role, isActive: raced.is_active };
    }
    throw new Error(`Could not create the user: ${writeError.message}`);
  }
  return { userId: created.id, role: created.role, isActive: created.is_active };
}
var auth_default = router2;

// server/routes/users.ts
import { Router as Router3 } from "express";
import { z as z3 } from "zod";

// server/middleware/auth.ts
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  try {
    const claims = verifySessionToken(token);
    req.uid = claims.sub;
    req.email = claims.email;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// shared/languages.ts
var APP_LANGUAGES = [
  { code: "en", englishName: "English", nativeName: "English", script: "Latin", speechSupported: true },
  { code: "hi", englishName: "Hindi", nativeName: "\u0939\u093F\u0902\u0926\u0940", script: "Devanagari", speechSupported: true },
  { code: "bn", englishName: "Bengali", nativeName: "\u09AC\u09BE\u0982\u09B2\u09BE", script: "Bengali", speechSupported: true },
  { code: "mr", englishName: "Marathi", nativeName: "\u092E\u0930\u093E\u0920\u0940", script: "Devanagari", speechSupported: true },
  { code: "te", englishName: "Telugu", nativeName: "\u0C24\u0C46\u0C32\u0C41\u0C17\u0C41", script: "Telugu", speechSupported: true },
  { code: "ta", englishName: "Tamil", nativeName: "\u0BA4\u0BAE\u0BBF\u0BB4\u0BCD", script: "Tamil", speechSupported: true },
  { code: "gu", englishName: "Gujarati", nativeName: "\u0A97\u0AC1\u0A9C\u0AB0\u0ABE\u0AA4\u0AC0", script: "Gujarati", speechSupported: true },
  { code: "ur", englishName: "Urdu", nativeName: "\u0627\u0631\u062F\u0648", script: "Arabic", speechSupported: true },
  { code: "kn", englishName: "Kannada", nativeName: "\u0C95\u0CA8\u0CCD\u0CA8\u0CA1", script: "Kannada", speechSupported: true },
  { code: "ml", englishName: "Malayalam", nativeName: "\u0D2E\u0D32\u0D2F\u0D3E\u0D33\u0D02", script: "Malayalam", speechSupported: true },
  { code: "pa", englishName: "Punjabi", nativeName: "\u0A2A\u0A70\u0A1C\u0A3E\u0A2C\u0A40", script: "Gurmukhi", speechSupported: true },
  { code: "as", englishName: "Assamese", nativeName: "\u0985\u09B8\u09AE\u09C0\u09AF\u09BC\u09BE", script: "Bengali", speechSupported: true },
  { code: "ne", englishName: "Nepali", nativeName: "\u0928\u0947\u092A\u093E\u0932\u0940", script: "Devanagari", speechSupported: true },
  { code: "sa", englishName: "Sanskrit", nativeName: "\u0938\u0902\u0938\u094D\u0915\u0943\u0924\u092E\u094D", script: "Devanagari", speechSupported: true },
  { code: "sd", englishName: "Sindhi", nativeName: "\u0633\u0646\u068C\u064A", script: "Arabic", speechSupported: true },
  { code: "or", englishName: "Odia", nativeName: "\u0B13\u0B21\u0B3C\u0B3F\u0B06", script: "Odia", speechSupported: false },
  { code: "mai", englishName: "Maithili", nativeName: "\u092E\u0948\u0925\u093F\u0932\u0940", script: "Devanagari", speechSupported: false },
  { code: "ks", englishName: "Kashmiri", nativeName: "\u06A9\u0672\u0634\u064F\u0631", script: "Arabic", speechSupported: false },
  { code: "kok", englishName: "Konkani", nativeName: "\u0915\u094B\u0902\u0915\u0923\u0940", script: "Devanagari", speechSupported: false },
  { code: "doi", englishName: "Dogri", nativeName: "\u0921\u094B\u0917\u0930\u0940", script: "Devanagari", speechSupported: false },
  { code: "mni", englishName: "Manipuri", nativeName: "\uABC3\uABE4\uABC7\uABE9\uABC2\uABE3\uABDF", script: "Meetei Mayek", speechSupported: false },
  { code: "brx", englishName: "Bodo", nativeName: "\u092C\u0921\u093C\u094B", script: "Devanagari", speechSupported: false },
  { code: "sat", englishName: "Santali", nativeName: "\u1C65\u1C5F\u1C71\u1C5B\u1C5F\u1C72\u1C64", script: "Ol Chiki", speechSupported: false }
];
var LANGUAGE_CODES = APP_LANGUAGES.map((l) => l.code);
var BY_CODE = new Map(APP_LANGUAGES.map((l) => [l.code, l]));
function isAppLanguage(value) {
  return BY_CODE.has(value);
}

// shared/regions.ts
var INDIAN_REGIONS = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry"
];
var REGION_SET = new Set(INDIAN_REGIONS);
function isIndianRegion(value) {
  return REGION_SET.has(value);
}

// shared/whatsapp.ts
function normalizeWhatsAppNumber(raw) {
  return raw.replace(/[^0-9]/g, "");
}
function isValidWhatsAppNumber(raw) {
  const digits = normalizeWhatsAppNumber(raw);
  return digits.length >= 8 && digits.length <= 15;
}

// shared/shippingEstimator.ts
function isValidIndianPincode(value) {
  return /^[1-9][0-9]{5}$/.test(value.trim());
}

// server/types/index.ts
var USER_ROLES = ["artisan", "buyer", "admin"];
function isUserRole(value) {
  return typeof value === "string" && USER_ROLES.includes(value);
}

// server/routes/users.ts
var router3 = Router3();
function toUserProfile(row) {
  return {
    userId: row.id,
    email: row.email,
    displayName: row.display_name,
    shopName: row.shop_name,
    region: row.region,
    whatsappNumber: row.whatsapp_number,
    pincode: row.pincode,
    language: isAppLanguage(row.language) ? row.language : "en",
    role: isUserRole(row.role) ? row.role : "artisan",
    totalProducts: row.total_products,
    createdAt: row.created_at
  };
}
router3.get(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const supabase = getSupabase();
    let { data, error } = await supabase.from("users").select("id, email, display_name, shop_name, region, whatsapp_number, pincode, language, role, total_products, created_at").eq("id", req.uid).maybeSingle();
    if (error?.code === "42703") {
      const fallback = await supabase.from("users").select("id, email, display_name, shop_name, region, language, role, total_products, created_at").eq("id", req.uid).maybeSingle();
      data = fallback.data ? { ...fallback.data, whatsapp_number: null, pincode: null } : null;
      error = fallback.error;
    }
    if (error) throw new Error(`Could not load the profile: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(toUserProfile(data));
  })
);
var UpdateUserSchema = z3.object({
  displayName: z3.string().max(80).optional(),
  shopName: z3.string().max(120).optional(),
  region: z3.string().refine(isIndianRegion, "Unsupported region").optional(),
  whatsappNumber: z3.string().refine((value) => value === "" || isValidWhatsAppNumber(value), "Enter a valid phone number").optional(),
  pincode: z3.string().refine((value) => value === "" || isValidIndianPincode(value), "Enter a valid 6-digit pincode").optional(),
  language: z3.string().refine(isAppLanguage, "Unsupported language").optional()
});
router3.patch(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = UpdateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const patch = {};
    if (parsed.data.displayName !== void 0) patch.display_name = parsed.data.displayName;
    if (parsed.data.shopName !== void 0) patch.shop_name = parsed.data.shopName;
    if (parsed.data.region !== void 0) patch.region = parsed.data.region;
    if (parsed.data.whatsappNumber !== void 0) {
      patch.whatsapp_number = parsed.data.whatsappNumber === "" ? null : parsed.data.whatsappNumber;
    }
    if (parsed.data.pincode !== void 0) {
      patch.pincode = parsed.data.pincode === "" ? null : parsed.data.pincode;
    }
    if (parsed.data.language !== void 0) patch.language = parsed.data.language;
    if (Object.keys(patch).length === 0) {
      res.json({ success: true });
      return;
    }
    const { error } = await getSupabase().from("users").update(patch).eq("id", req.uid);
    if (error) throw new Error(`Could not update the profile: ${error.message}`);
    res.json({ success: true });
  })
);
var users_default = router3;

// server/routes/products.ts
import { Router as Router4 } from "express";
import { z as z5 } from "zod";

// server/middleware/requireRole.ts
function requireRole(...allowed) {
  return async function(req, res, next) {
    const { data, error } = await getSupabase().from("users").select("role").eq("id", req.uid).maybeSingle();
    if (error) {
      res.status(500).json({ error: "internal_error" });
      return;
    }
    const role = isUserRole(data?.role) ? data.role : void 0;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    req.role = role;
    next();
  };
}

// server/voice-ai/types/voice-ai.types.ts
var SUPPORTED_LANGUAGES = APP_LANGUAGES;
function isSupportedLanguageCode(value) {
  return isAppLanguage(value);
}

// server/voice-ai/errors/voice-ai.errors.ts
var VoiceAiError = class extends Error {
  stage;
  /** The original error, kept for server-side logs only, never serialize this to the client. */
  cause;
  constructor(stage, message, cause) {
    super(message);
    this.name = "VoiceAiError";
    this.stage = stage;
    this.cause = cause;
  }
};
var InvalidAudioError = class extends VoiceAiError {
  constructor(message = "Audio is missing, empty, or in an unsupported format", cause) {
    super("stt", message, cause);
    this.name = "InvalidAudioError";
  }
};
var EmptyTranscriptError = class extends VoiceAiError {
  constructor(message = "Speech-to-text produced an empty transcript", cause) {
    super("stt", message, cause);
    this.name = "EmptyTranscriptError";
  }
};
var UnsupportedLanguageError = class extends VoiceAiError {
  constructor(detected, cause) {
    super("language-detection", `Detected language "${detected}" is not currently supported`, cause);
    this.name = "UnsupportedLanguageError";
  }
};
var TranslationFailedError = class extends VoiceAiError {
  constructor(message = "Translation failed", cause) {
    super("translation", message, cause);
    this.name = "TranslationFailedError";
  }
};
var DescriptionGenerationError = class extends VoiceAiError {
  constructor(message = "Description generation failed", cause) {
    super("generation", message, cause);
    this.name = "DescriptionGenerationError";
  }
};
var MalformedModelResponseError = class extends VoiceAiError {
  constructor(stage, message = "Model returned a response in an unexpected shape", cause) {
    super(stage, message, cause);
    this.name = "MalformedModelResponseError";
  }
};

// server/voice-ai/config/env.ts
import "dotenv/config";
import { z as z4 } from "zod";
var envSchema2 = z4.object({
  VOICE_AI_PROVIDER: z4.enum(["groq", "gemini"]).default("groq"),
  GROQ_API_KEY: z4.string().optional(),
  GROQ_FALLBACK_API_KEYS: z4.string().optional(),
  GROQ_STT_MODEL: z4.string().default("whisper-large-v3"),
  GROQ_LLM_MODEL: z4.string().default("openai/gpt-oss-120b"),
  GROQ_LLM_FALLBACK_MODEL: z4.string().default("openai/gpt-oss-20b"),
  GEMINI_API_KEY: z4.string().optional(),
  GEMINI_TRANSCRIBE_MODEL: z4.string().default("gemini-3.6-flash"),
  GEMINI_FLASH_MODEL: z4.string().default("gemini-3.6-flash")
}).superRefine((env, ctx) => {
  if (env.VOICE_AI_PROVIDER === "groq" && !env.GROQ_API_KEY) {
    ctx.addIssue({
      code: z4.ZodIssueCode.custom,
      path: ["GROQ_API_KEY"],
      message: "GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq"
    });
  }
  if (env.VOICE_AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    ctx.addIssue({
      code: z4.ZodIssueCode.custom,
      path: ["GEMINI_API_KEY"],
      message: "GEMINI_API_KEY is required when VOICE_AI_PROVIDER is gemini"
    });
  }
});
var cached3;
function withoutBlanks2(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}
function loadEnv2() {
  if (cached3) return cached3;
  const parsed = envSchema2.safeParse(withoutBlanks2(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid voice-ai environment configuration: ${issues}`);
  }
  cached3 = parsed.data;
  return cached3;
}

// server/voice-ai/pipeline/voice-product-pipeline.ts
var noopLogger = {
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  }
};
async function processVoiceDescription(input, deps2) {
  const logger = deps2.logger ?? noopLogger;
  logger.info("voice-ai: starting pipeline", { category: input.category, audioBytes: input.audio?.length });
  try {
    const sttResult = await deps2.sttService.transcribe(input.audio, input.mimeType);
    logger.info("voice-ai: stt complete", { detectedLanguage: sttResult.language });
    const transcript = sttResult.text;
    const detectedLanguage = sttResult.language;
    const englishTranscript = detectedLanguage === "en" ? transcript : await deps2.translationService.translate(transcript, detectedLanguage, "en");
    if (detectedLanguage !== "en") {
      logger.info("voice-ai: regional -> English translation complete");
    }
    const descriptionEn = await deps2.descriptionService.generateDescription(englishTranscript, input.category);
    logger.info("voice-ai: description generation complete");
    const localLanguage = input.targetLanguage || "en";
    const descriptionLocal = localLanguage === "en" ? descriptionEn : await deps2.translationService.translate(descriptionEn, "en", localLanguage);
    if (localLanguage !== "en") {
      logger.info("voice-ai: English -> local translation complete", { localLanguage });
    }
    return { transcript, descriptionEn, descriptionLocal, localLanguage, detectedLanguage };
  } catch (err) {
    if (err instanceof VoiceAiError) {
      logger.error(`voice-ai: pipeline failed at stage "${err.stage}"`, { message: err.message });
      throw err;
    }
    logger.error("voice-ai: pipeline failed with an unexpected error", { err });
    throw new DescriptionGenerationError("Unexpected error in voice AI pipeline", err);
  }
}

// server/voice-ai/stt/audio-mime.ts
var ALIASES = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/m4a",
  "audio/mp4": "audio/m4a",
  "audio/vorbis": "audio/ogg"
};
var EXTENSIONS = {
  "audio/wav": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/aiff": "aiff"
};
function normaliseAudioMimeType(mimeType, supported) {
  const bare = (mimeType || "").split(";")[0].trim().toLowerCase();
  const aliased = ALIASES[bare] ?? bare;
  if (supported.includes(aliased)) {
    return aliased;
  }
  throw new InvalidAudioError(
    `Audio format "${bare || "unknown"}" is not supported for transcription`
  );
}
function extensionForAudio(mimeType) {
  return EXTENSIONS[mimeType] ?? "wav";
}

// server/voice-ai/stt/groq-stt.service.ts
var GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
var GROQ_SUPPORTED_AUDIO_TYPES = [
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm"
];
var NAME_TO_CODE = (() => {
  const map = {};
  for (const language of SUPPORTED_LANGUAGES) {
    map[language.englishName.toLowerCase()] = language.code;
    map[language.code] = language.code;
  }
  map.oriya = "or";
  map.meitei = "mni";
  map.manipuri = "mni";
  return map;
})();
function toSupportedLanguage(reported) {
  const key = (reported ?? "").trim().toLowerCase();
  if (!key) return "unknown";
  return NAME_TO_CODE[key] ?? key;
}
var GroqSttService = class {
  keyPool;
  model;
  constructor(env) {
    const keys = parseGroqApiKeys(env.GROQ_API_KEY, env.GROQ_FALLBACK_API_KEYS);
    if (keys.length === 0) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.keyPool = new GroqKeyPool(keys);
    this.model = env.GROQ_STT_MODEL;
  }
  async transcribe(audio, mimeType) {
    if (!audio || audio.length === 0) {
      throw new InvalidAudioError();
    }
    const audioMimeType = normaliseAudioMimeType(mimeType, GROQ_SUPPORTED_AUDIO_TYPES);
    const buildForm = () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: audioMimeType }),
        `recording.${extensionForAudio(audioMimeType)}`
      );
      form.append("model", this.model);
      form.append("response_format", "verbose_json");
      form.append("prompt", "An Indian artisan describing a handmade product in their own language.");
      return form;
    };
    let payload;
    let lastRateLimit;
    for (const apiKey of this.keyPool.usableKeys()) {
      try {
        const response = await fetch(GROQ_TRANSCRIPTION_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: buildForm()
        });
        if (response.status === 429) {
          const detail = await response.text();
          this.keyPool.rest(apiKey, detail);
          lastRateLimit = new InvalidAudioError("Transcription provider returned 429", detail.slice(0, 500));
          continue;
        }
        if (!response.ok) {
          const detail = await response.text();
          throw new InvalidAudioError(
            `Transcription provider returned ${response.status}`,
            detail.slice(0, 500)
          );
        }
        payload = await response.json();
        break;
      } catch (err) {
        if (err instanceof InvalidAudioError) throw err;
        throw new InvalidAudioError("Speech-to-text provider rejected or failed to process the audio", err);
      }
    }
    if (!payload) {
      throw lastRateLimit ?? new InvalidAudioError("Speech-to-text provider had no usable API key");
    }
    const text = payload.text?.trim();
    if (!text) {
      throw new EmptyTranscriptError();
    }
    if (payload.language === void 0) {
      throw new MalformedModelResponseError("stt", "Transcription response had no language field");
    }
    return { text, language: toSupportedLanguage(payload.language) };
  }
};

// server/voice-ai/groq/chat.ts
var GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
var GroqRateLimitError = class extends Error {
  detail;
  constructor(model, detail) {
    super(`Groq rate limit reached for ${model}: ${detail}`);
    this.name = "GroqRateLimitError";
    this.detail = detail;
  }
};
async function callModel(options, model, apiKey) {
  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: options.prompt }],
      ...options.json ? { response_format: { type: "json_object" } } : {}
    })
  });
  if (response.status === 429) {
    throw new GroqRateLimitError(model, (await response.text()).slice(0, 300));
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Groq returned ${response.status}: ${detail.slice(0, 400)}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Groq returned an empty completion");
  }
  return content.trim();
}
async function groqChat(options) {
  const models = [options.model];
  if (options.fallbackModel && options.fallbackModel !== options.model) {
    models.push(options.fallbackModel);
  }
  const keys = options.keyPool.usableKeys();
  let lastRateLimit;
  for (const apiKey of keys) {
    for (const model of models) {
      try {
        return await callModel(options, model, apiKey);
      } catch (err) {
        if (!(err instanceof GroqRateLimitError)) throw err;
        lastRateLimit = err;
      }
    }
    if (lastRateLimit) options.keyPool.rest(apiKey, lastRateLimit.detail);
  }
  throw lastRateLimit ?? new Error("Groq had no usable API key configured");
}

// server/voice-ai/translation/groq-translation.service.ts
var GroqTranslationService = class {
  keyPool;
  model;
  fallbackModel;
  constructor(env) {
    const keys = parseGroqApiKeys(env.GROQ_API_KEY, env.GROQ_FALLBACK_API_KEYS);
    if (keys.length === 0) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.keyPool = new GroqKeyPool(keys);
    this.model = env.GROQ_LLM_MODEL;
    this.fallbackModel = env.GROQ_LLM_FALLBACK_MODEL;
  }
  async translate(text, sourceLanguage, targetLanguage) {
    if (sourceLanguage === targetLanguage || !text || text.trim().length === 0) {
      return text;
    }
    const sourceName = SUPPORTED_LANGUAGES.find((l) => l.code === sourceLanguage)?.englishName ?? sourceLanguage;
    const targetName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.englishName ?? targetLanguage;
    let raw;
    try {
      raw = await groqChat({
        keyPool: this.keyPool,
        model: this.model,
        fallbackModel: this.fallbackModel,
        json: true,
        prompt: buildPrompt(text, sourceName, targetName)
      });
    } catch (err) {
      throw new TranslationFailedError(
        `Translation failed for ${sourceLanguage} to ${targetLanguage}`,
        err
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError(
        "translation",
        "Translation response was not valid JSON",
        parseErr
      );
    }
    const translated = parsed.translation?.trim();
    if (!translated) {
      throw new TranslationFailedError(
        `Empty translation output from ${sourceName} to ${targetName}`
      );
    }
    return translated;
  }
};
function buildPrompt(text, sourceName, targetName) {
  return `Translate the following artisan product text from ${sourceName} into natural ${targetName}.

Rules:
1. Preserve the exact meaning, materials, and craft terminology.
2. Add nothing that is not in the original, and drop nothing that is.
3. Do not add commentary, notes, or markup.
4. Write ${targetName} in its own script.

Original text:
"""${text}"""

Respond with a JSON object of the form {"translation": "..."}.`;
}

// server/voice-ai/description/heritagePrompt.ts
function field(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "(not provided, omit this from the story)";
}
function buildHeritagePrompt(input) {
  return `You are writing the "Product Story" section of a Craft Heritage Passport: a public, self-declared provenance certificate for a handmade product on an Indian artisan marketplace (KalaSetu). This is NOT a marketing page. It is closer to a museum object label: warm, factual, precise.

You will be given some of the fields below. Any field marked "(not provided, omit this from the story)" was not given by the artisan, at all, in any form.

category: ${input.category}
material: ${field(input.material)}
technique: ${field(input.technique)}
timeTaken: ${field(input.timeTaken)}
giTag: ${field(input.giTag)}
description: """${input.descriptionEn}"""

Your task: write ONE short story, 100 to 150 words, about this specific product: how it was made, from what, using what technique, how long it took, and the meaning of any motif or design the artisan mentioned in the description. Cover only what is actually present below.

STRICT RULES, follow every one of these without exception:
1. Use ONLY information explicitly present in the fields and description above. Do not add, infer, or assume anything that is not there.
2. Do NOT invent regional history, cultural traditions, heritage claims, or symbolism, EVEN IF the category, material, or region name would typically be associated with a known craft tradition. If the artisan did not state it, in these fields or in the description, it does not appear in the story, no matter how likely it seems.
3. If a field above is marked "(not provided, omit this from the story)", omit that part of the story entirely. Do not write a placeholder like "using traditional methods" or "a technique passed down through generations" to paper over a missing field.
4. Do not claim, imply, or reference any government verification, official certification, or third-party authentication. This is a self-declared record made by the artisan, not a certified one.
5. No superlatives or sales language: no "finest", "exquisite", "premium", "world-renowned", "must-have". Write like a museum placard, not an advertisement.
6. Third person, plain English prose, about the product and how it was made. Do not mention the artisan speaking, a transcript, translation, or AI.
7. Target 100 to 150 words.

Respond with a JSON object of the form {"story": "..."}.`;
}

// server/voice-ai/description/groq-description.service.ts
var GroqDescriptionService = class {
  keyPool;
  model;
  fallbackModel;
  constructor(env) {
    const keys = parseGroqApiKeys(env.GROQ_API_KEY, env.GROQ_FALLBACK_API_KEYS);
    if (keys.length === 0) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.keyPool = new GroqKeyPool(keys);
    this.model = env.GROQ_LLM_MODEL;
    this.fallbackModel = env.GROQ_LLM_FALLBACK_MODEL;
  }
  async generateDescription(englishTranscript, category) {
    if (!englishTranscript || englishTranscript.trim().length === 0) {
      throw new DescriptionGenerationError("Cannot generate a description from an empty transcript");
    }
    let raw;
    try {
      raw = await groqChat({
        keyPool: this.keyPool,
        model: this.model,
        fallbackModel: this.fallbackModel,
        json: true,
        prompt: buildPrompt2(englishTranscript, category)
      });
    } catch (err) {
      throw new DescriptionGenerationError("Description generation call failed", err);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError(
        "generation",
        "Description response was not valid JSON",
        parseErr
      );
    }
    const description = parsed.descriptionEn?.trim();
    if (!description) {
      throw new MalformedModelResponseError("generation", "Response was missing descriptionEn");
    }
    return description;
  }
  async generateHeritageStory(input) {
    if (!input.descriptionEn || input.descriptionEn.trim().length === 0) {
      throw new DescriptionGenerationError("Cannot generate a heritage story from an empty description");
    }
    let raw;
    try {
      raw = await groqChat({
        keyPool: this.keyPool,
        model: this.model,
        fallbackModel: this.fallbackModel,
        json: true,
        prompt: buildHeritagePrompt(input)
      });
    } catch (err) {
      throw new DescriptionGenerationError("Heritage story generation call failed", err);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError("generation", "Heritage story response was not valid JSON", parseErr);
    }
    const story = parsed.story?.trim();
    if (!story) {
      throw new MalformedModelResponseError("generation", "Response was missing story");
    }
    return story;
  }
};
function buildPrompt2(englishTranscript, category) {
  return `You are writing a short e-commerce product description for an Indian artisan marketplace (KalaSetu).

You will be given:
- category: the product category the artisan selected
- transcript: an English translation of the artisan describing their own product in their own words

Your task: write ONE concise, natural-sounding English product description (1-3 sentences) for this listing.

STRICT RULES, follow every one of these:
1. Use ONLY information explicitly present in the transcript. Do not add anything the artisan did not say.
2. Do NOT invent or assume: materials, dimensions/size, price, location/region, certifications, historical or cultural claims (e.g. "traditional", "passed down through generations"), quality claims (e.g. "premium", "finest"), or environmental claims (e.g. "eco-friendly", "sustainable", "100% natural") unless the transcript states them directly.
3. Do NOT assume properties just because of the category (e.g. do not assume a "basket" category item is bamboo, or that a "textile" is cotton, unless the artisan said so).
4. If the transcript is vague or sparse, write a short, honest, equally sparse description rather than padding it with invented detail.
5. Preserve the specific details the artisan DID give (materials, use, technique, color, etc. if mentioned).
6. Write in natural e-commerce language, not a literal translation, not a list of keywords, not overly flowery.
7. Do not mention the artisan speaking, transcripts, translation, or the AI process. Write only the product description itself.

category: ${category}
transcript: """${englishTranscript}"""

Respond with a JSON object of the form {"descriptionEn": "..."}.`;
}

// server/voice-ai/stt/gemini-stt.service.ts
import { GoogleGenAI } from "@google/genai";
var MAX_INLINE_AUDIO_BYTES = 18 * 1024 * 1024;
var GEMINI_SUPPORTED_AUDIO_TYPES = [
  "audio/wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/m4a",
  "audio/opus"
];
var GeminiSttService = class {
  client;
  transcribeModel;
  constructor(env) {
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    this.transcribeModel = env.GEMINI_TRANSCRIBE_MODEL;
  }
  async transcribe(audio, mimeType) {
    if (!audio || audio.length === 0) {
      throw new InvalidAudioError();
    }
    if (audio.length > MAX_INLINE_AUDIO_BYTES) {
      throw new InvalidAudioError("Audio recording is too large to transcribe in a single request");
    }
    const audioMimeType = normaliseAudioMimeType(mimeType, GEMINI_SUPPORTED_AUDIO_TYPES);
    const supportedCodes = SUPPORTED_LANGUAGES.map((l) => l.code);
    let raw;
    try {
      const response = await this.client.models.generateContent({
        model: this.transcribeModel,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { data: audio.toString("base64"), mimeType: audioMimeType } },
              { text: buildTranscriptionPrompt(supportedCodes) }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              transcript: { type: "STRING" },
              languageCode: { type: "STRING", enum: supportedCodes }
            },
            required: ["transcript", "languageCode"]
          }
        }
      });
      raw = response.text;
    } catch (err) {
      throw new InvalidAudioError("Speech-to-text provider rejected or failed to process the audio", err);
    }
    if (!raw) {
      throw new MalformedModelResponseError("stt", "Transcription response had no text output");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new MalformedModelResponseError("stt", "Transcription response was not valid JSON", parseErr);
    }
    const text = parsed.transcript?.trim();
    if (!text) {
      throw new EmptyTranscriptError();
    }
    if (!parsed.languageCode || !isSupportedLanguageCode(parsed.languageCode)) {
      throw new UnsupportedLanguageError(parsed.languageCode ?? "unknown");
    }
    return { text, language: parsed.languageCode };
  }
};
function buildTranscriptionPrompt(supportedCodes) {
  return `Transcribe the attached audio recording of an Indian artisan describing a product they made.

Rules:
1. Transcribe exactly what is spoken, in the native script of the language spoken. Do not translate.
2. Do not add, summarise, correct, or embellish anything the speaker did not say.
3. If the speaker mixes languages, transcribe each part in its own script.
4. Identify the dominant spoken language and report it as one of these codes: ${supportedCodes.join(", ")}.
5. If the audio contains no intelligible speech, return an empty string for the transcript.

Respond with a JSON object of the form {"transcript": "...", "languageCode": "..."}.`;
}

// server/voice-ai/translation/gemini-translation.service.ts
import { GoogleGenAI as GoogleGenAI2 } from "@google/genai";
var GeminiTranslationService = class {
  client;
  model;
  constructor(env) {
    this.client = new GoogleGenAI2({ apiKey: env.GEMINI_API_KEY });
    this.model = env.GEMINI_FLASH_MODEL;
  }
  async translate(text, sourceLanguage, targetLanguage) {
    if (sourceLanguage === targetLanguage || !text || text.trim().length === 0) {
      return text;
    }
    const sourceName = SUPPORTED_LANGUAGES.find((l) => l.code === sourceLanguage)?.englishName || sourceLanguage;
    const targetName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.englishName || targetLanguage;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Translate the following artisan product text accurately from ${sourceName} to natural ${targetName}.
Preserve the exact meaning, materials, and artisan terminology without adding any extra commentary or markup.

Original Text:
"""${text}"""

Translated ${targetName} Text:`
              }
            ]
          }
        ]
      });
      const translated = response.text?.trim();
      if (!translated) {
        throw new TranslationFailedError(`Empty translation output from ${sourceName} to ${targetName}`);
      }
      return translated;
    } catch (err) {
      if (err instanceof TranslationFailedError) throw err;
      throw new TranslationFailedError(`Gemini translation failed for ${sourceLanguage} -> ${targetLanguage}`, err);
    }
  }
};

// server/voice-ai/description/gemini-description.service.ts
import { GoogleGenAI as GoogleGenAI3 } from "@google/genai";
var GeminiDescriptionService = class {
  client;
  model;
  constructor(env) {
    this.client = new GoogleGenAI3({ apiKey: env.GEMINI_API_KEY });
    this.model = env.GEMINI_FLASH_MODEL;
  }
  async generateDescription(englishTranscript, category) {
    if (!englishTranscript || englishTranscript.trim().length === 0) {
      throw new DescriptionGenerationError("Cannot generate a description from an empty transcript");
    }
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt3(englishTranscript, category) }]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              descriptionEn: { type: "STRING" }
            },
            required: ["descriptionEn"]
          }
        }
      });
      const raw = response.text;
      if (!raw) {
        throw new MalformedModelResponseError("generation", "Gemini returned no text output");
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        throw new MalformedModelResponseError("generation", "Gemini response was not valid JSON", parseErr);
      }
      if (!parsed.descriptionEn || parsed.descriptionEn.trim().length === 0) {
        throw new MalformedModelResponseError("generation", "Gemini response was missing descriptionEn");
      }
      return parsed.descriptionEn.trim();
    } catch (err) {
      if (err instanceof MalformedModelResponseError) throw err;
      throw new DescriptionGenerationError("Gemini description generation call failed", err);
    }
  }
  async generateHeritageStory(input) {
    if (!input.descriptionEn || input.descriptionEn.trim().length === 0) {
      throw new DescriptionGenerationError("Cannot generate a heritage story from an empty description");
    }
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [{ text: buildHeritagePrompt(input) }]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              story: { type: "STRING" }
            },
            required: ["story"]
          }
        }
      });
      const raw = response.text;
      if (!raw) {
        throw new MalformedModelResponseError("generation", "Gemini returned no text output");
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        throw new MalformedModelResponseError("generation", "Gemini heritage story response was not valid JSON", parseErr);
      }
      if (!parsed.story || parsed.story.trim().length === 0) {
        throw new MalformedModelResponseError("generation", "Gemini response was missing story");
      }
      return parsed.story.trim();
    } catch (err) {
      if (err instanceof MalformedModelResponseError) throw err;
      throw new DescriptionGenerationError("Gemini heritage story generation call failed", err);
    }
  }
};
function buildPrompt3(englishTranscript, category) {
  return `You are writing a short e-commerce product description for an Indian artisan marketplace (KalaSetu).

You will be given:
- category: the product category the artisan selected
- transcript: an English translation of the artisan describing their own product in their own words

Your task: write ONE concise, natural-sounding English product description (1-3 sentences) for this listing.

STRICT RULES, follow every one of these:
1. Use ONLY information explicitly present in the transcript. Do not add anything the artisan did not say.
2. Do NOT invent or assume: materials, dimensions/size, price, location/region, certifications, historical or cultural claims (e.g. "traditional", "passed down through generations"), quality claims (e.g. "premium", "finest"), or environmental claims (e.g. "eco-friendly", "sustainable", "100% natural") unless the transcript states them directly.
3. Do NOT assume properties just because of the category (e.g. do not assume a "basket" category item is bamboo, or that a "textile" is cotton, unless the artisan said so).
4. If the transcript is vague or sparse, write a short, honest, equally sparse description rather than padding it with invented detail.
5. Preserve the specific details the artisan DID give (materials, use, technique, color, etc. if mentioned).
6. Write in natural e-commerce language, not a literal translation, not a list of keywords, not overly flowery.
7. Do not mention the artisan speaking, transcripts, translation, or the AI process. Write only the product description itself.

category: ${category}
transcript: """${englishTranscript}"""

Respond with a JSON object of the form {"descriptionEn": "..."}.`;
}

// server/voice-ai/translation/mock-translation.service.ts
var MockTranslationService = class {
  constructor(failOnLanguagePair) {
    this.failOnLanguagePair = failOnLanguagePair;
  }
  failOnLanguagePair;
  async translate(text, sourceLanguage, targetLanguage) {
    if (sourceLanguage === targetLanguage) return text;
    if (this.failOnLanguagePair && this.failOnLanguagePair.source === sourceLanguage && this.failOnLanguagePair.target === targetLanguage) {
      throw new TranslationFailedError(`Simulated failure for ${sourceLanguage} -> ${targetLanguage}`);
    }
    return `[mock:${sourceLanguage}->${targetLanguage}] ${text}`;
  }
};

// server/voice-ai/pipeline/factory.ts
function buildVoiceAiDependencies(options = {}) {
  const env = loadEnv2();
  if (env.VOICE_AI_PROVIDER === "gemini") {
    return {
      sttService: new GeminiSttService(env),
      descriptionService: new GeminiDescriptionService(env),
      translationService: options.forceMockTranslation ? new MockTranslationService() : new GeminiTranslationService(env),
      logger: options.logger
    };
  }
  return {
    sttService: new GroqSttService(env),
    descriptionService: new GroqDescriptionService(env),
    translationService: options.forceMockTranslation ? new MockTranslationService() : new GroqTranslationService(env),
    logger: options.logger
  };
}

// server/lib/passportId.ts
async function generatePassportId(date = /* @__PURE__ */ new Date()) {
  const year = date.getFullYear();
  const { data, error } = await getSupabase().rpc("next_passport_number", { target_year: year });
  if (error) {
    throw new Error(`Could not generate a passport id: ${error.message}`);
  }
  const sequence = String(data).padStart(6, "0");
  return `ART-${year}-${sequence}`;
}

// server/services/pricingEngine.ts
var CATEGORY_DATASET = {
  textiles: { name: "Textiles" },
  pottery: { name: "Pottery" },
  jewelry: { name: "Jewelry" },
  woodwork: { name: "Woodwork" },
  "bamboo-cane": { name: "Bamboo & Cane" },
  bamboo: { name: "Bamboo & Cane" },
  other: { name: "Other Handcrafts" }
};
var COMPLEXITY_LEVELS = ["simple", "standard", "detailed", "complex", "exceptional"];
function isValidComplexity(value) {
  return typeof value === "string" && COMPLEXITY_LEVELS.includes(value);
}
var MARKET_REFERENCE = {
  textiles: {
    saree: { marketMin: 2015, marketMedian: 5499, marketMax: 16500, sampleCount: 26, sourceCount: 4 },
    shawl: { marketMin: 750, marketMedian: 1499, marketMax: 3360, sampleCount: 7, sourceCount: 2 }
  },
  pottery: {
    vase: { marketMin: 250, marketMedian: 2500, marketMax: 5500, sampleCount: 7, sourceCount: 2 },
    plate: { marketMin: 150, marketMedian: 600, marketMax: 1800, sampleCount: 6, sourceCount: 2 },
    pot: { marketMin: 120, marketMedian: 450, marketMax: 1200, sampleCount: 8, sourceCount: 2 }
  },
  jewelry: {
    necklace: { marketMin: 180, marketMedian: 750, marketMax: 1500, sampleCount: 8, sourceCount: 2 },
    earrings: { marketMin: 199, marketMedian: 355, marketMax: 999, sampleCount: 8, sourceCount: 2 },
    bangle: { marketMin: 150, marketMedian: 500, marketMax: 1200, sampleCount: 5, sourceCount: 2 }
  },
  woodwork: {
    sculpture: { marketMin: 400, marketMedian: 2400, marketMax: 15e3, sampleCount: 9, sourceCount: 2 },
    decorative: { marketMin: 100, marketMedian: 1e3, marketMax: 4700, sampleCount: 9, sourceCount: 2 },
    toy: { marketMin: 120, marketMedian: 450, marketMax: 1500, sampleCount: 6, sourceCount: 2 }
  },
  "bamboo-cane": {
    basket: { marketMin: 185, marketMedian: 899, marketMax: 3500, sampleCount: 15, sourceCount: 3 },
    lamp: { marketMin: 177, marketMedian: 500, marketMax: 3200, sampleCount: 10, sourceCount: 2 },
    decorative: { marketMin: 90, marketMedian: 537, marketMax: 7400, sampleCount: 10, sourceCount: 2 }
  }
};
var PRICING_CONFIG = {
  labourFactors: {
    simple: 0.3,
    standard: 0.5,
    detailed: 0.8,
    complex: 1.2,
    exceptional: 1.6
  },
  overheadRate: 0.1,
  fairMargin: 0.2,
  marketWeights: {
    high: 0.4,
    medium: 0.25,
    low: 0.1,
    insufficient: 0
  },
  maximumMarkup: 0.2,
  materialCostWarningMultiplier: 2,
  materialCostCapMultiplier: 3,
  overchargeThreshold: 0.3
};
var MATERIAL_COST_REFERENCE_RANGES = {
  textiles: { typicalMin: 80, typicalMax: 4e3 },
  pottery: { typicalMin: 20, typicalMax: 900 },
  jewelry: { typicalMin: 50, typicalMax: 6e3 },
  woodwork: { typicalMin: 60, typicalMax: 3500 },
  "bamboo-cane": { typicalMin: 20, typicalMax: 700 },
  bamboo: { typicalMin: 20, typicalMax: 700 },
  other: { typicalMin: 20, typicalMax: 5e3 }
};
function assessMaterialCost(categoryKey, enteredMaterialCost) {
  const baseline = MATERIAL_COST_REFERENCE_RANGES[categoryKey];
  if (!baseline) {
    return {
      status: "no_reference",
      typicalMin: null,
      typicalMax: null,
      enteredMaterialCost,
      materialCostUsedForCalculation: enteredMaterialCost,
      wasCapped: false
    };
  }
  const capCeiling = baseline.typicalMax * PRICING_CONFIG.materialCostCapMultiplier;
  const warnCeiling = baseline.typicalMax * PRICING_CONFIG.materialCostWarningMultiplier;
  const warnFloor = baseline.typicalMin / PRICING_CONFIG.materialCostWarningMultiplier;
  const materialCostUsedForCalculation = Math.min(enteredMaterialCost, capCeiling);
  const wasCapped = materialCostUsedForCalculation < enteredMaterialCost;
  let status = "within_range";
  if (enteredMaterialCost > warnCeiling) status = "above_typical_range";
  else if (enteredMaterialCost < warnFloor) status = "below_typical_range";
  return {
    status,
    typicalMin: baseline.typicalMin,
    typicalMax: baseline.typicalMax,
    enteredMaterialCost,
    materialCostUsedForCalculation,
    wasCapped
  };
}
function assessOvercharge(suggestion, listedPrice) {
  const overchargeCeiling = suggestion.overchargeCeiling;
  if (!Number.isFinite(listedPrice) || listedPrice <= overchargeCeiling) {
    return { flagged: false, reason: null, overchargeCeiling };
  }
  const reason = `Priced above typical range for this category. Listed at \u20B9${roundToSensibleInr(listedPrice)}; suggested range \u20B9${suggestion.minimumPrice}\u2013\u20B9${suggestion.maximumPrice}.`;
  return { flagged: true, reason, overchargeCeiling };
}
function getMarketWeight(marketAvailable, sampleCount) {
  if (!marketAvailable) return PRICING_CONFIG.marketWeights.insufficient;
  if (sampleCount >= 20) return PRICING_CONFIG.marketWeights.high;
  if (sampleCount >= 10) return PRICING_CONFIG.marketWeights.medium;
  if (sampleCount >= 5) return PRICING_CONFIG.marketWeights.low;
  return PRICING_CONFIG.marketWeights.insufficient;
}
function roundToSensibleInr(val) {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (val < 100) return Math.round(val);
  if (val < 500) return Math.round(val / 5) * 5;
  if (val < 2e3) return Math.round(val / 10) * 10;
  return Math.round(val / 50) * 50;
}
function inferSubcategory(categoryKey, text) {
  const lower = text.toLowerCase();
  const catRef = MARKET_REFERENCE[categoryKey];
  if (!catRef) return null;
  for (const subKey of Object.keys(catRef)) {
    if (lower.includes(subKey)) return subKey;
  }
  if (categoryKey === "textiles") {
    if (lower.includes("sari") || lower.includes("saree") || lower.includes("drape") || lower.includes("silk") || lower.includes("pallu")) return "saree";
    if (lower.includes("shawl") || lower.includes("stole") || lower.includes("scarf") || lower.includes("dupatta") || lower.includes("wrap")) return "shawl";
  } else if (categoryKey === "pottery") {
    if (lower.includes("vase") || lower.includes("vessel") || lower.includes("flower")) return "vase";
    if (lower.includes("plate") || lower.includes("dish") || lower.includes("thali") || lower.includes("bowl")) return "plate";
    if (lower.includes("pot") || lower.includes("matka") || lower.includes("handi") || lower.includes("planter")) return "pot";
  } else if (categoryKey === "jewelry") {
    if (lower.includes("necklace") || lower.includes("chain") || lower.includes("pendant") || lower.includes("choker") || lower.includes("haar")) return "necklace";
    if (lower.includes("earring") || lower.includes("jhumka") || lower.includes("stud")) return "earrings";
    if (lower.includes("bangle") || lower.includes("bracelet") || lower.includes("kada")) return "bangle";
  } else if (categoryKey === "woodwork") {
    if (lower.includes("statue") || lower.includes("sculpture") || lower.includes("idol") || lower.includes("carving") || lower.includes("murti")) return "sculpture";
    if (lower.includes("toy") || lower.includes("game") || lower.includes("puppet")) return "toy";
    if (lower.includes("decor") || lower.includes("tray") || lower.includes("box") || lower.includes("frame")) return "decorative";
  } else if (categoryKey === "bamboo-cane" || categoryKey === "bamboo") {
    if (lower.includes("basket") || lower.includes("tokri") || lower.includes("bin")) return "basket";
    if (lower.includes("lamp") || lower.includes("light") || lower.includes("lantern") || lower.includes("shade")) return "lamp";
    if (lower.includes("decor") || lower.includes("mat") || lower.includes("tray") || lower.includes("box")) return "decorative";
  }
  return null;
}
function inferComplexity(text) {
  const lower = text.toLowerCase();
  if (lower.includes("antique") || lower.includes("masterpiece") || lower.includes("gold leaf") || lower.includes("heritage") || lower.includes("national award") || lower.includes("months to make") || lower.includes("fine intricate filigree")) {
    return "exceptional";
  }
  if (lower.includes("intricate") || lower.includes("elaborate") || lower.includes("fine carving") || lower.includes("hand embroidered") || lower.includes("complex") || lower.includes("multi-layer")) {
    return "complex";
  }
  if (lower.includes("detailed") || lower.includes("pattern") || lower.includes("embossed") || lower.includes("hand-painted") || lower.includes("polished finish")) {
    return "detailed";
  }
  if (lower.includes("simple") || lower.includes("plain") || lower.includes("minimal") || lower.includes("basic") || lower.includes("raw finish")) {
    return "simple";
  }
  return "standard";
}
function buildMaterialCostNote(assessment, categoryName) {
  if (assessment.status === "above_typical_range") {
    const cappedNote = assessment.wasCapped ? ` To keep the suggestion fair, this calculation used a capped material cost of \u20B9${roundToSensibleInr(assessment.materialCostUsedForCalculation)} instead.` : "";
    return `The material cost you entered is well above the typical range for ${categoryName} (\u20B9${assessment.typicalMin}\u2013\u20B9${assessment.typicalMax}).${cappedNote}`;
  }
  if (assessment.status === "below_typical_range") {
    return `The material cost you entered is well below the typical range for ${categoryName} (\u20B9${assessment.typicalMin}\u2013\u20B9${assessment.typicalMax}). Double check it's correct.`;
  }
  return "";
}
function buildExplanation(params) {
  const productionCostText = `Your estimated production cost is \u20B9${roundToSensibleInr(params.productionCost)}. This includes material cost, estimated labour, and overhead.`;
  const fairFloorText = `A fair artisan margin gives a minimum fair price of \u20B9${roundToSensibleInr(params.fairPriceFloor)}.`;
  const materialCostNote = buildMaterialCostNote(params.materialCostAssessment, params.categoryName);
  if (!params.marketAvailable || params.marketMedian === null) {
    return `${productionCostText} ${fairFloorText} No reliable market benchmark was available for this product segment. The recommendation is therefore based primarily on estimated production cost and the fair artisan margin.${materialCostNote ? ` ${materialCostNote}` : ""}`;
  }
  const marketText = `Comparable products have a market median of \u20B9${roundToSensibleInr(params.marketMedian)} based on ${params.sampleCount} samples.`;
  const recommendationText = `The recommended price of \u20B9${params.recommendedPrice} balances artisan protection with market competitiveness.`;
  return `${productionCostText} ${fairFloorText} ${marketText} ${recommendationText}${materialCostNote ? ` ${materialCostNote}` : ""}`;
}
function calculateSmartPrice(input) {
  if (!input.category || !input.category.trim()) {
    throw new Error("Category is required");
  }
  let effectiveMaterialCost = 0;
  if (Array.isArray(input.rawMaterials) && input.rawMaterials.length > 0) {
    effectiveMaterialCost = input.rawMaterials.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
  } else if (typeof input.materialCost === "number" && input.materialCost > 0) {
    effectiveMaterialCost = input.materialCost;
  }
  if (effectiveMaterialCost <= 0) {
    throw new Error("Material cost must be greater than 0");
  }
  const normalizedCategory = input.category.toLowerCase();
  const categoryConfig = CATEGORY_DATASET[normalizedCategory];
  if (!categoryConfig) {
    throw new Error("Unsupported category");
  }
  const categoryName = categoryConfig.name;
  const materialCostAssessment = assessMaterialCost(normalizedCategory, effectiveMaterialCost);
  const materialCostForCalculation = materialCostAssessment.materialCostUsedForCalculation;
  const fullText = `${input.category} ${input.descriptionEn || ""} ${input.descriptionHi || ""}`.trim();
  let complexity;
  let complexitySource;
  if (input.complexity !== void 0) {
    if (isValidComplexity(input.complexity)) {
      complexity = input.complexity;
      complexitySource = "explicit";
    } else {
      complexity = "standard";
      complexitySource = "invalid-fallback";
    }
  } else {
    complexity = inferComplexity(fullText);
    complexitySource = "inferred";
  }
  const labourFactor = PRICING_CONFIG.labourFactors[complexity];
  const estimatedLabourCost = materialCostForCalculation * labourFactor;
  const overhead = (materialCostForCalculation + estimatedLabourCost) * PRICING_CONFIG.overheadRate;
  const productionCost = materialCostForCalculation + estimatedLabourCost + overhead;
  const fairPriceFloor = productionCost * (1 + PRICING_CONFIG.fairMargin);
  const selectedSubcategory = input.subcategory || inferSubcategory(normalizedCategory, fullText);
  const catMarket = MARKET_REFERENCE[normalizedCategory];
  const marketData = selectedSubcategory && catMarket ? catMarket[selectedSubcategory] : void 0;
  const marketAvailable = Boolean(marketData);
  const marketMin = marketData ? marketData.marketMin : null;
  const marketMedian = marketData ? marketData.marketMedian : null;
  const marketMax = marketData ? marketData.marketMax : null;
  const sampleCount = marketData ? marketData.sampleCount : 0;
  const sourceCount = marketData ? marketData.sourceCount : 0;
  const marketWeight = getMarketWeight(marketAvailable, sampleCount);
  const costWeight = 1 - marketWeight;
  const rawRecommendedPrice = marketAvailable && marketMedian !== null ? Math.max(fairPriceFloor, costWeight * fairPriceFloor + marketWeight * marketMedian) : fairPriceFloor;
  const rawMinimumPrice = fairPriceFloor;
  const rawMaximumCandidate = rawRecommendedPrice * (1 + PRICING_CONFIG.maximumMarkup);
  const rawMaximumPrice = marketAvailable && marketMax !== null ? Math.max(rawRecommendedPrice, Math.min(marketMax, rawMaximumCandidate)) : rawMaximumCandidate;
  const minimumPrice = roundToSensibleInr(rawMinimumPrice);
  const recommendedPrice = roundToSensibleInr(rawRecommendedPrice);
  const maximumPrice = roundToSensibleInr(rawMaximumPrice);
  const marketEvidenceScore = !marketAvailable ? 0 : sampleCount >= 20 ? 40 : sampleCount >= 10 ? 30 : sampleCount >= 5 ? 20 : 10;
  const hasImage = Boolean(input.imageUrl && input.imageUrl.startsWith("http"));
  const descText = (input.descriptionEn || input.descriptionHi || "").trim();
  const hasUsefulDescription = descText.length >= 15;
  const hasAnyDescription = descText.length > 0;
  const productIdentificationScore = hasImage && hasUsefulDescription ? 30 : hasImage || hasUsefulDescription ? 20 : hasAnyDescription ? 10 : 0;
  const costEstimateScore = complexitySource === "explicit" ? 30 : complexitySource === "inferred" ? 20 : 10;
  const recommendationReliability = Math.max(
    0,
    Math.min(100, marketEvidenceScore + productIdentificationScore + costEstimateScore)
  );
  let reliabilityLabel = "Medium";
  if (recommendationReliability >= 90) reliabilityLabel = "Very High";
  else if (recommendationReliability >= 75) reliabilityLabel = "High";
  else if (recommendationReliability >= 60) reliabilityLabel = "Medium";
  else if (recommendationReliability >= 40) reliabilityLabel = "Low";
  else reliabilityLabel = "Very Low";
  const reason = buildExplanation({
    productionCost,
    fairPriceFloor,
    marketAvailable,
    marketMedian,
    sampleCount,
    recommendedPrice,
    materialCostAssessment,
    categoryName
  });
  const overchargeCeiling = roundToSensibleInr(maximumPrice * (1 + PRICING_CONFIG.overchargeThreshold));
  return {
    success: true,
    suggestedMin: minimumPrice,
    suggestedMax: maximumPrice,
    minimumPrice,
    recommendedPrice,
    maximumPrice,
    reason,
    reasoning: reason,
    recommendationReliability,
    reliabilityLabel,
    overchargeCeiling,
    materialCostAssessment,
    pricingBreakdown: {
      materialCost: effectiveMaterialCost,
      materialCostUsedForCalculation: roundToSensibleInr(materialCostForCalculation),
      estimatedLabourCost: roundToSensibleInr(estimatedLabourCost),
      overhead: roundToSensibleInr(overhead),
      productionCost: roundToSensibleInr(productionCost),
      fairPriceFloor: roundToSensibleInr(fairPriceFloor),
      marketMedian,
      marketWeight,
      costWeight,
      complexity,
      subcategory: selectedSubcategory,
      categoryName
    },
    marketReference: {
      available: marketAvailable,
      min: marketMin,
      median: marketMedian,
      max: marketMax,
      sampleCount,
      sourceCount
    },
    assumptions: {
      labourFactor,
      overheadRate: PRICING_CONFIG.overheadRate,
      fairMargin: PRICING_CONFIG.fairMargin
    }
  };
}

// shared/locales/as.json
var as_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B9\u09B8\u09CD\u09A4\u09B6\u09BF\u09B2\u09CD\u09AA \u0985\u09A8\u09B2\u09BE\u0987\u09A8\u09A4 \u09B8\u09B9\u099C\u09C7 \u09AC\u09BF\u0995\u09CD\u09F0\u09C0 \u0995\u09F0\u0995\u0964",
  "welcome.languageLabel": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AD\u09BE\u09B7\u09BE \u09AC\u09BE\u099B\u09A8\u09BF \u0995\u09F0\u0995\u0964",
  "welcome.getStarted": "\u0986\u09F0\u09AE\u09CD\u09AD \u0995\u09F0\u0995",
  "language.en": "\u0987\u0982\u09F0\u09BE\u099C\u09C0",
  "language.hi": "\u09B9\u09BF\u09A8\u09CD\u09A6\u09C0",
  "email.title": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09A8\u09BE \u09B2\u09BF\u0996\u0995",
  "email.roleQuestion": "\u09AE\u0987 \u0987\u09AF\u09BC\u09BE\u09A4 \u0986\u099B\u09CB\u0981",
  "email.roleSell": "\u09AE\u09CB\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AC\u09BF\u0995\u09CD\u09F0\u09C0 \u0995\u09F0\u0995",
  "email.roleBuy": "\u09B9\u09BE\u09A4\u09F0 \u0995\u09BE\u09AE\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u0995\u09BF\u09A8\u0995",
  "email.label": "\u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09A8\u09BE",
  "email.helper": "\u0986\u09AA\u09CB\u09A8\u09BE\u0995 \u09EA \u0985\u0982\u0995\u09F0 \u0995\u09CB\u09A1 \u09AA\u09A0\u09BE\u09AE, \u09AF\u09BE\u09F0 \u099C\u09F0\u09BF\u09AF\u09BC\u09A4\u09C7 \u0986\u09AA\u09C1\u09A8\u09BF \u09B9'\u09AC \u09AC\u09C1\u09B2\u09BF \u09A8\u09BF\u09B6\u09CD\u099A\u09BF\u09A4 \u0995\u09F0\u09BF\u09AC\u0964",
  "email.invalid": "\u09AC\u09C8\u09A7 \u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09A8\u09BE \u09B2\u09BF\u0996\u0995",
  "email.sendOtp": "\u0995\u09CB\u09A1 \u09AA\u09A0\u09BE\u0993\u0995",
  "email.error": "\u0995\u09CB\u09A1 \u09AA\u09A0\u09BE\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF, \u0985\u09A8\u09C1\u0997\u09CD\u09F0\u09B9 \u0995\u09F0\u09BF \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "otp.title": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u0987\u09AE\u09C7\u0987\u09B2 \u09A8\u09BF\u09B6\u09CD\u099A\u09BF\u09A4 \u0995\u09F0\u0995",
  "otp.subtitle": "\u09AA\u09A0\u09CB\u09F1\u09BE \u09EA \u0985\u0982\u0995\u09F0 \u0995\u09CB\u09A1 \u09B2\u09BF\u0996\u0995",
  "otp.emailUndelivered": "\u0987\u09AE\u09C7\u0987\u09B2 \u09AA\u09A0\u09BE\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF\u09B2\u09CB\u0981\u0964 \u09A1\u09C7\u09AE\u09CB \u0995\u09CB\u09A1\u09F0 \u09AC\u09BE\u09AC\u09C7 \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09A6\u09B2\u09C7\u09F0\u09C7 \u09AF\u09CB\u0997\u09BE\u09AF\u09CB\u0997 \u0995\u09F0\u0995\u0964",
  "otp.changeEmail": "\u0987\u09AE\u09C7\u0987\u09B2 \u09B8\u09B2\u09A8\u09BF \u0995\u09F0\u0995",
  "otp.verify": "\u09A8\u09BF\u09B6\u09CD\u099A\u09BF\u09A4 \u0995\u09F0\u0995",
  "otp.invalid": "\u09B8\u0995\u09B2\u09CB \u09EA \u0985\u0982\u0995 \u09B2\u09BF\u0996\u0995",
  "otp.wrong": "\u09AD\u09C1\u09B2 OTP, \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "otp.resend": "OTP \u09AA\u09C1\u09A8\u09F0 \u09AA\u09A0\u09BE\u0993\u0995",
  "otp.resendIn": "OTP {n}s \u09A4 \u09AA\u09C1\u09A8\u09F0 \u09AA\u09A0\u09BE\u09AC",
  "otp.resendError": "OTP \u09AA\u09C1\u09A8\u09F0 \u09AA\u09A0\u09BE\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF\u09B2\u09CB\u0981, \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "camera.capture": "\u09AB\u099F\u09CB \u09B2\u0993\u0995",
  "camera.unavailable": "\u0995\u09C7\u09AE\u09C7\u09F0\u09BE \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09B9\u09AF\u09BC, \u09A4\u09BE\u09F0 \u09AC\u09A6\u09B2\u09C7 \u09AB\u099F\u09CB \u09AC\u09BE\u099B\u09A8\u09BF \u0995\u09F0\u0995\u0964",
  "camera.choosePhoto": "\u09AB\u099F\u09CB \u09AC\u09BE\u099B\u09A8\u09BF \u0995\u09F0\u0995",
  "camera.retake": "\u09AA\u09C1\u09A8\u09F0 \u09B2\u0993\u0995",
  "camera.usePhoto": "\u098F\u0987 \u09AB\u099F\u09CB \u09AC\u09CD\u09AF\u09F1\u09B9\u09BE\u09F0 \u0995\u09F0\u0995",
  "camera.enhancing": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AB\u099F\u09CB \u0989\u09A8\u09CD\u09A8\u09A4 \u0995\u09F0\u09BE \u09B9\u09C8\u099B\u09C7...",
  "camera.enhanceError": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AB\u099F\u09CB \u0989\u09A8\u09CD\u09A8\u09A4 \u0995\u09F0\u09BF\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF",
  "camera.retry": "\u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "camera.before": "\u09AE\u09C2\u09B2",
  "camera.after": "\u0989\u09A8\u09CD\u09A8\u09A4",
  "camera.compareHint": "\u09A4\u09C1\u09B2\u09A8\u09BE \u0995\u09F0\u09BF\u09AC\u09B2\u09C8 \u09B8\u09CD\u09B2\u09BE\u0987\u09A1\u09BE\u09F0 \u099F\u09BE\u09A8\u0995",
  "camera.continue": "\u0986\u0997\u09AC\u09BE\u09A2\u09BC\u09BF \u09AF\u09BE\u0993\u0995",
  "studio.title": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AB\u099F\u09CB \u0989\u09A8\u09CD\u09A8\u09A4 \u0995\u09F0\u0995",
  "studio.original": "\u09AE\u09CC\u09B2\u09BF\u0995",
  "studio.processed": "\u09AA\u09CD\u09F0\u0995\u09CD\u09F0\u09BF\u09AF\u09BC\u09BE\u0995\u09C3\u09A4",
  "studio.removeBackground": "\u09AA\u09C3\u09B7\u09CD\u09A0\u09AD\u09C2\u09AE\u09BF \u0986\u0981\u09A4\u09F0\u09BE\u0993\u0995",
  "studio.removingBackground": "\u09AA\u09C3\u09B7\u09CD\u09A0\u09AD\u09C2\u09AE\u09BF \u0986\u0981\u09A4\u09F0\u09BE\u0987\u099B\u09C7...",
  "studio.keepOriginalBackground": "\u09AE\u09CC\u09B2\u09BF\u0995 \u09AA\u09C3\u09B7\u09CD\u09A0\u09AD\u09C2\u09AE\u09BF \u09F0\u09BE\u0996\u0995",
  "studio.backgroundWhite": "\u09AC\u0997\u09BE",
  "studio.backgroundNeutral": "\u09A8\u09AE\u09CD\u09F0 \u0995\u09CD\u09F0\u09C0\u09AE",
  "studio.backgroundBlur": "\u09AC\u09CD\u09B2\u09BE\u09F0",
  "studio.backgroundUnavailableNotice": "\u09AA\u09C3\u09B7\u09CD\u09A0\u09AD\u09C2\u09AE\u09BF \u0986\u0981\u09A4\u09F0\u09CB\u09F1\u09BE \u09AC\u09F0\u09CD\u09A4\u09AE\u09BE\u09A8 \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09B9\u09AF\u09BC\u0964 \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AB\u099F\u09CB \u0985\u09AA\u09B0\u09BF\u09AC\u09F0\u09CD\u09A4\u09BF\u09A4 \u0986\u099B\u09C7\u0964",
  "studio.backgroundTimedOutNotice": "\u09AA\u09C3\u09B7\u09CD\u09A0\u09AD\u09C2\u09AE\u09BF \u0986\u0981\u09A4\u09F0\u09CB\u09F1\u09BE\u09A4 \u0985\u09A7\u09BF\u0995 \u09B8\u09AE\u09AF\u09BC \u09B2\u09BE\u0997\u09BF\u09B2 \u0986\u09F0\u09C1 \u09AC\u09BE\u09A6 \u09A6\u09BF\u09AF\u09BC\u09BE \u09B9\u09B2\u0964 \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AB\u099F\u09CB \u0985\u09AA\u09B0\u09BF\u09AC\u09F0\u09CD\u09A4\u09BF\u09A4 \u0986\u099B\u09C7\u0964",
  "studio.backgroundQuotaNotice": "\u09AA\u09C3\u09B7\u09CD\u09A0\u09AD\u09C2\u09AE\u09BF \u0986\u0981\u09A4\u09F0\u09CB\u09F1\u09BE\u09F0 \u0995\u09CB\u099F\u09BE \u09AC\u09F0\u09CD\u09A4\u09AE\u09BE\u09A8 \u09B6\u09C7\u09B7 \u09B9\u09C8\u099B\u09C7\u0964 \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AB\u099F\u09CB \u0985\u09AA\u09B0\u09BF\u09AC\u09F0\u09CD\u09A4\u09BF\u09A4 \u0986\u099B\u09C7\u0964",
  "studio.backgroundFailedNotice": "\u09AA\u099F\u09AD\u09C2\u09AE\u09BF \u0986\u0981\u09A4\u09F0\u09CB\u09F1\u09BE \u09AC\u09BF\u09AB\u09B2 \u09B9\u09C8\u099B\u09C7\u0964 \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AB\u099F\u09CB \u0985\u09AA\u09B0\u09BF\u09AC\u09F0\u09CD\u09A4\u09BF\u09A4 \u0986\u099B\u09C7\u0964",
  "studio.brightness": "\u0989\u099C\u09CD\u099C\u09CD\u09AC\u09B2\u09A4\u09BE",
  "studio.contrast": "\u0995\u09A8\u09CD\u099F\u09CD\u09F0\u09BE\u09B8\u09CD\u099F",
  "studio.sharpen": "\u09A7\u09BE\u09F0\u09BE\u09B2\u09CB \u0995\u09F0\u0995",
  "studio.autoLighting": "\u09B8\u09CD\u09AC\u09AF\u09BC\u0982\u0995\u09CD\u09F0\u09BF\u09AF\u09BC \u0986\u09B2\u09CB\u0995",
  "studio.crop": "\u0995\u09BE\u099F",
  "studio.cropOriginal": "\u09AE\u09CC\u09B2\u09BF\u0995",
  "studio.cropSquare": "\u09AC\u09F0\u09CD\u0997",
  "studio.cropPortrait": "\u09AA'\u09F0\u09CD\u099F\u09CD\u09F0\u09C7\u0987\u099F",
  "studio.accept": "\u098F\u0987 \u09AB\u099F\u09CB \u09AC\u09CD\u09AF\u09F1\u09B9\u09BE\u09F0 \u0995\u09F0\u0995",
  "studio.retake": "\u09AA\u09C1\u09A8\u09F0 \u09A4\u09C1\u09B2\u09BF \u09B2\u0993\u0995",
  "studio.finalizing": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE \u09AA\u09CD\u09F0\u09AF\u09BC\u09CB\u0997 \u0995\u09F0\u09BE \u09B9\u09C8\u099B\u09C7...",
  "studio.on": "\u099A\u09BE\u09B2\u09C1",
  "studio.off": "\u09AC\u09A8\u09CD\u09A7",
  "category.title": "\u0986\u09AA\u09C1\u09A8\u09BF \u0995\u09BF \u09AC\u09BF\u0995\u09CD\u09F0\u09C0 \u0995\u09F0\u09BF\u09AC?",
  "category.continue": "\u0986\u0997\u09AC\u09BE\u09A2\u09BC\u09BF \u09AF\u09BE\u0993\u0995",
  "category.materialQuestion": "\u0987\u099F\u09CB \u0995\u09BF \u09A6\u09BF\u09AF\u09BC\u09C7 \u09A4\u09C8\u09AF\u09BC\u09BE\u09F0? (\u0990\u099A\u09CD\u099B\u09BF\u0995)",
  "category.textiles": "\u09AC\u09B8\u09CD\u09A4\u09CD\u09F0",
  "category.pottery": "\u09AE\u09BE\u099F\u09BF\u09F0 \u09AC\u09BE\u099F\u09BF",
  "category.jewelry": "\u0997\u09B9\u09A8\u09BE",
  "category.woodwork": "\u0995\u09BE\u09A0\u09F0 \u0995\u09BE\u09AE",
  "category.bambooCane": "\u09AC\u09BE\u0981\u09B9 \u0986\u09F0\u09C1 \u0995\u09BE\u0981\u0987\u099F",
  "category.other": "\u0985\u09A8\u09CD\u09AF\u09BE\u09A8\u09CD\u09AF",
  "voice.tapToRecord": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AC\u09BF\u09F1\u09F0\u09A3 \u09F0\u09C7\u0995\u09F0\u09CD\u09A1 \u0995\u09F0\u09BF\u09AC\u09B2\u09C8 \u099F\u09C7\u09AA \u0995\u09F0\u0995",
  "voice.recording": "\u09F0\u09C7\u0995\u09F0\u09CD\u09A1\u09BF\u0982...",
  "voice.stop": "\u09F0\u09C7\u0995\u09F0\u09CD\u09A1\u09BF\u0982 \u09AC\u09A8\u09CD\u09A7 \u0995\u09F0\u0995",
  "voice.record": "\u09F0\u09C7\u0995\u09F0\u09CD\u09A1 \u0995\u09F0\u0995",
  "voice.reviewRecording": "\u09AA\u09C1\u09A8\u09F0 \u09B6\u09C1\u09A8\u0995, \u09A4\u09BE\u09F0\u09AA\u09BE\u099B\u09A4 \u0986\u0997\u09AC\u09BE\u09A2\u09BC\u0995 \u09AC\u09BE \u09AA\u09C1\u09A8\u09F0 \u09F0\u09C7\u0995\u09F0\u09CD\u09A1 \u0995\u09F0\u0995\u0964",
  "voice.reRecord": "\u09AA\u09C1\u09A8\u09F0 \u09F0\u09C7\u0995\u09F0\u09CD\u09A1 \u0995\u09F0\u0995",
  "voice.continue": "\u099A\u09BE\u09B2\u09C1 \u09F0\u09BE\u0996\u0995",
  "describe.transcribing": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AC\u09BF\u09F1\u09F0\u09A3 \u09AC\u09C1\u099C\u09BF \u0986\u099B\u09CB\u0981...",
  "describe.transcribeError": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AC\u09BF\u09F1\u09F0\u09A3 \u09AC\u09C1\u099C\u09BF\u09AC \u09AA\u09F0\u09BE \u09A8\u0997'\u09B2",
  "describe.retry": "\u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE",
  "describe.reviewHint": "\u0986\u09AC\u09B6\u09CD\u09AF\u0995 \u09B9'\u09B2\u09C7 \u09AA\u09F0\u09CD\u09AF\u09BE\u09B2\u09CB\u099A\u09A8\u09BE \u0986\u09F0\u09C1 \u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE \u0995\u09F0\u0995",
  "describe.fallbackNote": "\u09AE\u09BE\u0987\u0995\u09CD\u09F0\u09CB\u09AB\u09CB\u09A8 \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09B9\u09AF\u09BC, \u09AC\u09BF\u09F1\u09F0\u09A3 \u099F\u09BE\u0987\u09AA \u0995\u09F0\u0995\u0964",
  "describe.placeholderEn": "\u0987\u0982\u09F0\u09BE\u099C\u09C0\u09A4 \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u0989\u09CE\u09AA\u09BE\u09A6\u09A8 \u09AC\u09F0\u09CD\u09A3\u09A8\u09BE \u0995\u09F0\u0995",
  "describe.continue": "\u099A\u09BE\u09B2\u09C1 \u09F0\u09BE\u0996\u0995",
  "pricing.title": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u0989\u09CE\u09AA\u09BE\u09A6\u09A8\u09F0 \u09AE\u09C2\u09B2\u09CD\u09AF \u09A8\u09BF\u09F0\u09CD\u09A7\u09BE\u09F0\u09A3 \u0995\u09F0\u0995",
  "pricing.summaryEdit": "\u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE",
  "pricing.materialCostLabel": "\u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u0996\u09F0\u099A",
  "pricing.materialCostHelper": "\u09F0\u09C1\u09AA\u09BF\u09AF\u09BC\u09BE\u09A4 \u0995\u09BE\u0981\u099A\u09BE\u09AE\u09BE\u09B2\u09A4 \u0996\u09F0\u099A \u0995\u09F0\u09BE \u09A7\u09A8 \u09B2\u09BF\u0996\u0995\u0964",
  "pricing.materialCostInvalid": "\u09B6\u09C2\u09A8\u09CD\u09AF\u09A4\u0995\u09C8 \u09AC\u09C7\u099B\u09BF \u0995\u09BE\u0981\u099A\u09BE\u09AE\u09BE\u09B2 \u0996\u09F0\u099A \u09B2\u09BF\u0996\u0995\u0964",
  "pricing.getSuggestion": "\u09AE\u09C2\u09B2\u09CD\u09AF \u09AA\u09CD\u09F0\u09B8\u09CD\u09A4\u09BE\u09F1 \u09B2\u0993\u0995",
  "pricing.suggestError": "\u09AE\u09C2\u09B2\u09CD\u09AF \u09AA\u09CD\u09F0\u09B8\u09CD\u09A4\u09BE\u09F1 \u09AA\u09CB\u09F1\u09BE \u09A8\u0997'\u09B2",
  "pricing.retry": "\u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "pricing.rangeLabel": "\u09AA\u09CD\u09F0\u09B8\u09CD\u09A4\u09BE\u09F1\u09BF\u09A4 \u09AE\u09C2\u09B2\u09CD\u09AF \u09B8\u09C0\u09AE\u09BE",
  "pricing.sellingPriceLabel": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AC\u09BF\u0995\u09CD\u09F0\u09C0 \u09AE\u09C2\u09B2\u09CD\u09AF",
  "pricing.sellingPriceNote": "\u098F\u09AF\u09BC\u09BE \u09AA\u09CD\u09F0\u09B8\u09CD\u09A4\u09BE\u09F1 \u09AE\u09BE\u09A4\u09CD\u09F0, \u0986\u09AA\u09C1\u09A8\u09BF \u09AF\u09BF\u0995\u09CB\u09A8\u09CB \u09AE\u09C2\u09B2\u09CD\u09AF \u09F0\u09BE\u0996\u09BF\u09AC \u09AA\u09BE\u09F0\u09C7\u0964",
  "pricing.sellingPriceInvalid": "\u09B6\u09C2\u09A8\u09CD\u09AF\u09A4\u0995\u09C8 \u09AC\u09C7\u099B\u09BF \u09AC\u09BF\u0995\u09CD\u09F0\u09C0 \u09AE\u09C2\u09B2\u09CD\u09AF \u09B2\u09BF\u0996\u0995\u0964",
  "pricing.publish": "\u09AA\u09CD\u09F0\u0995\u09BE\u09B6 \u0995\u09F0\u0995",
  "pricing.publishError": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AA\u09CD\u09F0\u0995\u09BE\u09B6 \u0995\u09F0\u09BF\u09AC \u09AA\u09F0\u09BE \u09A8\u0997'\u09B2",
  "pricing.successTitle": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u098F\u09A4\u09BF\u09AF\u09BC\u09BE \u09B2\u09BE\u0987\u09AD!",
  "pricing.successMessage": "\u0995\u09CD\u09F0\u09C7\u09A4\u09BE\u09B8\u0995\u09B2\u09C7 \u098F\u09A4\u09BF\u09AF\u09BC\u09BE \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09A6\u09CB\u0995\u09BE\u09A8\u09A4 \u098F\u0987\u099F\u09CB \u09AC\u09BF\u099A\u09BE\u09F0\u09BF \u09AA\u09BE\u09AC\u0964",
  "pricing.viewShop": "\u09AE\u09CB\u09F0 \u09A6\u09CB\u0995\u09BE\u09A8\u09A4 \u099A\u09BE\u0993\u0995",
  "home.title": "\u09AE\u09CB\u09F0 \u09A6\u09CB\u0995\u09BE\u09A8",
  "home.gemBannerTitle": "GeM / ONDC-\u09F0 \u09B8\u09C8\u09A4\u09C7 \u09B8\u0982\u09AF\u09CB\u0997 \u0995\u09F0\u0995",
  "home.gemBannerBadge": "\u09B6\u09C0\u0998\u09CD\u09F0\u09C7 \u0986\u09B9\u09BF\u09AC",
  "home.gemBannerMessage": "\u098F\u0987 \u09B8\u0982\u09AF\u09CB\u0997 \u09B6\u09C0\u0998\u09CD\u09F0\u09C7 \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09B9'\u09AC\u0964",
  "home.loading": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09B2\u09CB\u09A1 \u0995\u09F0\u09BE \u09B9\u09C8\u099B\u09C7...",
  "home.loadError": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09B2\u09CB\u09A1 \u0995\u09F0\u09BF\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF",
  "home.retry": "\u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "home.emptyTitle": "\u098F\u09A4\u09BF\u09AF\u09BC\u09BE\u09B2\u09C8\u0995\u09C7 \u0995\u09CB\u09A8\u09CB \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09A8\u09BE\u0987",
  "home.emptyMessage": "KalaSetu-\u09A4 \u09AC\u09BF\u0995\u09CD\u09F0\u09C0 \u0986\u09F0\u09AE\u09CD\u09AD \u0995\u09F0\u09BF\u09AC\u09B2\u09C8 \u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AA\u09CD\u09F0\u09A5\u09AE \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AF\u09CB\u0997 \u0995\u09F0\u0995\u0964",
  "home.addFirstProduct": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AA\u09CD\u09F0\u09A5\u09AE \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AF\u09CB\u0997 \u0995\u09F0\u0995",
  "home.statusPublished": "\u09AA\u09CD\u09F0\u0995\u09BE\u09B6\u09BF\u09A4",
  "home.statusDraft": "\u0996\u099A\u09F0\u09BE",
  "home.statusFailed": "\u09AC\u09BF\u09AB\u09B2",
  "home.detailCategory": "\u09B6\u09CD\u09F0\u09C7\u09A3\u09C0",
  "home.detailEdit": "\u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE",
  "home.detailDelete": "\u09AE\u099A\u09BF \u09AA\u09C7\u09B2\u09BE\u0993\u0995",
  "home.detailClose": "\u09AC\u09A8\u09CD\u09A7 \u0995\u09F0\u0995",
  "home.editPriceLabel": "\u09AE\u09C2\u09B2\u09CD\u09AF",
  "home.editDescriptionLabel": "\u09AC\u09BF\u09F1\u09F0\u09A3",
  "home.editSave": "\u09AA\u09F0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8 \u09B8\u0982\u09F0\u0995\u09CD\u09B7\u09A3 \u0995\u09F0\u0995",
  "home.editCancel": "\u09AC\u09BE\u09A4\u09BF\u09B2 \u0995\u09F0\u0995",
  "home.editPriceInvalid": "\u09B6\u09C2\u09A8\u09CD\u09AF\u09A4\u0995\u09C8 \u09AC\u09C7\u099B\u09BF \u09AE\u09C2\u09B2\u09CD\u09AF \u09B2\u09BF\u0996\u0995",
  "home.editDescriptionRequired": "\u09AC\u09BF\u09F1\u09F0\u09A3 \u09A6\u09C1\u09AF\u09BC\u09CB\u099F\u09BE \u09AD\u09BE\u09B7\u09BE\u09A4 \u0996\u09BE\u09B2\u09C0 \u09A5\u09BE\u0995\u09BF\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09C7",
  "home.editError": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09B2\u09A8\u09BF \u09B8\u0982\u09F0\u0995\u09CD\u09B7\u09A3 \u0995\u09F0\u09BF\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF, \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "home.deleteConfirm": "\u098F\u0987 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AE\u099A\u09BF\u09AC \u09A8\u09C7\u0995\u09BF? \u09AE\u099A\u09BF \u09AA\u09C7\u09B2\u09BE\u09B2\u09C7 \u0989\u09B2\u09CD\u099F\u09BE\u0987 \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF",
  "home.deleteConfirmYes": "\u09B9\u09AF\u09BC, \u09AE\u099A\u09BF \u09AA\u09C7\u09B2\u09BE\u0993\u0995",
  "home.deleteError": "\u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AE\u099A\u09BF \u09AA\u09C7\u09B2\u09BE\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF, \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "profile.title": "\u09AA\u09CD\u09F0'\u09AB\u09BE\u0987\u09B2",
  "profile.emailLabel": "\u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09A8\u09BE",
  "profile.emailUnknown": "\u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09B9\u09AF\u09BC",
  "profile.loading": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AA\u09CD\u09F0'\u09AB\u09BE\u0987\u09B2 \u09B2\u09CB\u09A1 \u09B9\u09C8 \u0986\u099B\u09C7...",
  "profile.loadError": "\u09AA\u09CD\u09F0'\u09AB\u09BE\u0987\u09B2 \u09B2\u09CB\u09A1 \u09A8\u09CB\u09B9'\u09B2",
  "profile.displayNameLabel": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09A8\u09BE\u09AE",
  "profile.shopNameLabel": "\u09A6\u09CB\u0995\u09BE\u09A8\u09F0 \u09A8\u09BE\u09AE",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u09AA\u09CD\u09F0'\u09AB\u09BE\u0987\u09B2 \u09B8\u09BE\u0981\u099A\u09BF \u09B2\u0993\u0995",
  "profile.saved": "\u09AA\u09CD\u09F0'\u09AB\u09BE\u0987\u09B2 \u09B8\u09BE\u0981\u099A\u09BF \u09B2\u09CB\u09F1\u09BE \u09B9\u09C8\u099B\u09C7",
  "profile.saveError": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AA\u09CD\u09F0'\u09AB\u09BE\u0987\u09B2 \u09B8\u0982\u09F0\u0995\u09CD\u09B7\u09A3 \u0995\u09F0\u09BF\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF, \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "profile.logout": "\u09AC\u09BE\u09B9\u09BF\u09F0 \u09B9\u0993\u0995",
  "install.message": "\u09A6\u09CD\u09F0\u09C1\u09A4 \u09AC\u09CD\u09AF\u09F1\u09B9\u09BE\u09F0\u09F0 \u09AC\u09BE\u09AC\u09C7 KalaSetu \u0987\u09A8\u09B7\u09CD\u099F\u09B2 \u0995\u09F0\u0995",
  "install.action": "\u0987\u09A8\u09B7\u09CD\u099F\u09B2 \u0995\u09F0\u0995",
  "install.dismiss": "\u09AC\u09BE\u09A4\u09BF\u09B2 \u0995\u09F0\u0995",
  "offline.message": "\u0986\u09AA\u09C1\u09A8\u09BF \u0985\u09AB\u09B2\u09BE\u0987\u09A8, \u0995\u09BF\u099B\u09C1\u09AE\u09BE\u09A8 \u09AB\u09BF\u099A\u09BE\u09F0 \u0995\u09BE\u09AE \u09A8\u0995\u09F0\u09BF\u09AC \u09AA\u09BE\u09F0\u09C7",
  "welcome.languageHint": "\u09B8\u09F0\u09CD\u09AC\u09AE\u09CB\u099F \u098F\u09AA\u099F\u09CB \u098F\u0987 \u09AD\u09BE\u09B7\u09BE\u09A4 \u09B9'\u09AC\u0964",
  "welcome.regionalLanguages": "\u09AD\u09BE\u09F0\u09A4\u09C0\u09AF\u09BC \u09AD\u09BE\u09B7\u09BE\u09B8\u09AE\u09C2\u09B9",
  "describe.localTab": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AD\u09BE\u09B7\u09BE",
  "describe.placeholderLocal": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09A8\u09BF\u099C\u09BE \u09AD\u09BE\u09B7\u09BE\u09A4 \u09AA\u09A3\u09CD\u09AF\u099F\u09CB \u09AC\u09F0\u09CD\u09A3\u09A8\u09BE \u0995\u09F0\u0995",
  "describe.syncing": "\u0985\u09A8\u09CD\u09AF \u09AD\u09BE\u09B7\u09BE \u09B9\u09BE\u09B2\u09A8\u09BE\u0997\u09BE\u09A6 \u0995\u09F0\u09BE \u09B9\u09C8\u099B\u09C7...",
  "describe.syncFailed": "\u0985\u09A8\u09CD\u09AF \u09AD\u09BE\u09B7\u09BE \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09F0\u09BF\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF\u0964 \u09AA\u09CD\u09F0\u09DF\u09CB\u099C\u09A8 \u09B9\u2019\u09B2\u09C7 \u09A8\u09BF\u099C\u09C7 \u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE \u0995\u09F0\u0995\u0964",
  "describe.syncHint": "\u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE\u09B8\u09AE\u09C2\u09B9 \u09B8\u09CD\u09AC\u09DF\u0982\u0995\u09CD\u09F0\u09BF\u09DF\u09AD\u09BE\u09AC\u09C7 \u0985\u09A8\u09CD\u09AF \u09AD\u09BE\u09B7\u09BE\u09B2\u09C8 \u0995\u09AA\u09BF \u0995\u09F0\u09BE \u09B9\u09DF\u0964",
  "pricing.updating": "\u09A8\u09A4\u09C1\u09A8 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AE\u09C2\u09B2\u09CD\u09AF\u09F0 \u09AC\u09BE\u09AC\u09C7 \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09F0\u09BE \u09B9\u09C8\u099B\u09C7...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0995\u09C7\u099F\u09BE\u09B2\u0997 \u098F\u0995\u09CD\u09B8\u09AA\u09CB\u09B0\u09CD\u099F \u0995\u09F0\u0995 (ONDC \u09AB\u09F0\u09CD\u09AE\u09C7\u099F)",
  "home.exportCatalogNote": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09AA\u09CD\u09F0\u0995\u09BE\u09B6\u09BF\u09A4 \u09A4\u09BE\u09B2\u09BF\u0995\u09BE\u09B8\u09AE\u09C2\u09B9\u0995 ONDC \u09F0\u09BF\u099F\u09C7\u0987\u09B2 \u0995\u09C7\u099F\u09BE\u09B2\u0997 \u0997\u09A0\u09A8 \u0985\u09A8\u09C1\u09B8\u09F0\u09BF \u09A1\u09BE\u0989\u09A8\u09B2\u09CB\u09A1 \u0995\u09F0\u09C7\u0964 \u09B8\u0982\u09AF\u09CB\u0997-\u09B8\u099C\u09CD\u099C\u09BF\u09A4: \u09AE\u09BE\u09A8\u099A\u09BF\u09A4\u09CD\u09B0\u09A3 \u09B8\u09AE\u09CD\u09AA\u09C2\u09F0\u09CD\u09A3, \u09A8\u09C7\u099F\u09F1\u09F0\u09CD\u0995\u09A4 \u09B2\u09BE\u0987\u09AD \u09B9'\u09AC\u09B2\u09C8 ONDC \u09F0\u09C7\u099C\u09BF\u09B7\u09CD\u099F\u09CD\u09F0\u09C7\u099A\u09A8 \u0986\u09F1\u09B6\u09CD\u09AF\u0995\u0964",
  "home.exportOndcSingle": "\u098F\u0987 \u0989\u09CE\u09AA\u09BE\u09A6\u09A8 \u098F\u0995\u09CD\u09B8\u09AA\u09CB\u09B0\u09CD\u099F \u0995\u09F0\u0995 (ONDC \u09AB\u09F0\u09CD\u09AE\u09C7\u099F)",
  "profile.relocalising": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u098F\u0987 \u09AD\u09BE\u09B7\u09BE\u09B2\u09C8 \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09F0\u09BE \u09B9\u09C8\u099B\u09C7...",
  "profile.relocalised": "\u098F\u0987 \u09AD\u09BE\u09B7\u09BE\u09B2\u09C8 {n} \u099F\u09BE \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09F0\u09BE \u09B9'\u09B2\u0964",
  "profile.relocaliseFailed": "\u0995\u09BF\u099B\u09C1\u09AE\u09BE\u09A8 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09F0\u09BF\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF\u0964 \u09AA\u09BE\u099B\u09A4 \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995\u0964",
  "marketplace.navBrowse": "\u09AC\u09CD\u09B0\u09BE\u0989\u099C",
  "marketplace.navProfile": "\u09AA\u09CD\u09F0\u09CB\u09AB\u09BE\u0987\u09B2",
  "marketplace.browseTitle": "\u09AC\u099C\u09BE\u09F0",
  "marketplace.searchPlaceholder": "\u0989\u09CE\u09AA\u09BE\u09A6\u09A8 \u09B8\u09A8\u09CD\u09A7\u09BE\u09A8...",
  "marketplace.filtersTitle": "\u09AB\u09BF\u09B2\u09CD\u099F\u09BE\u09F0",
  "marketplace.filtersClear": "\u09B8\u0995\u09B2\u09CB \u09AE\u099A\u09BF",
  "marketplace.filterAll": "\u09B8\u0995\u09B2\u09CB",
  "marketplace.filterMaterial": "\u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0",
  "marketplace.filterRegion": "\u0985\u099E\u09CD\u099A\u09B2",
  "marketplace.filterPrice": "\u09AE\u09C2\u09B2\u09CD\u09AF \u09B8\u09C0\u09AE\u09BE (\u20B9)",
  "marketplace.filterPriceMin": "\u09A8\u09BF\u09AE\u09CD\u09A8",
  "marketplace.filterPriceMax": "\u09B8\u09F0\u09CD\u09AC\u09CB\u099A\u09CD\u099A",
  "marketplace.sortLabel": "\u09B8\u09BE\u099C\u09C1 \u0995\u09F0\u0995",
  "marketplace.sortNewest": "\u09B8\u09F0\u09CD\u09AC\u09B6\u09C7\u09B7 \u09AA\u09CD\u09F0\u09A5\u09AE\u09C7",
  "marketplace.sortPriceAsc": "\u09A6\u09BE\u09AE: \u0995\u09AE\u09F0 \u09AA\u09F0\u09BE \u09AC\u09C7\u099B\u09BF",
  "marketplace.sortPriceDesc": "\u09A6\u09BE\u09AE: \u09AC\u09C7\u099B\u09BF \u09AA\u09F0\u09BE \u0995\u09AE",
  "marketplace.resultCount": "{n} \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AA\u09CB\u09F1\u09BE \u0997'\u09B2",
  "marketplace.loadMore": "\u0985\u09A7\u09BF\u0995 \u09B2\u09CB\u09A1 \u0995\u09F0\u0995",
  "marketplace.loadError": "\u09AC\u099C\u09BE\u09F0 \u09B2\u09CB\u09A1 \u0995\u09F0\u09BF\u09AC \u09AA\u09F0\u09BE \u09A8\u0997'\u09B2, \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995",
  "marketplace.emptyTitle": "\u0995\u09CB\u09A8\u09CB \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AB\u09BF\u09B2\u09CD\u099F\u09BE\u09F0\u09F0 \u09B8\u09C8\u09A4\u09C7 \u09AE\u09BF\u09B2 \u09A8\u09BE\u0996\u09BE\u09DF",
  "marketplace.emptyFiltered": "\u09AB\u09BF\u09B2\u09CD\u099F\u09BE\u09F0 \u09AE\u099A\u09BF \u0985\u09A8\u09CD\u09AF \u0995\u09BF\u099B\u09C1 \u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u0995\u09F0\u0995.",
  "marketplace.emptyNoProducts": "\u098F\u09A4\u09BF\u09AF\u09BC\u09BE\u09B2\u09C8\u0995\u09C7 \u0995\u09CB\u09A8\u09CB \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AA\u09CD\u09F0\u0995\u09BE\u09B6 \u09B9\u09CB\u09F1\u09BE \u09A8\u09BE\u0987\u0964 \u09B6\u09C0\u0998\u09CD\u09F0\u09C7 \u099A\u09BE\u0993\u0995.",
  "marketplace.artisanUnnamed": "KalaSetu \u09B6\u09BF\u09B2\u09CD\u09AA\u09C0",
  "marketplace.backToBrowse": "\u09AC\u099C\u09BE\u09F0\u09A4 \u0998\u09C2\u09F0\u09BF \u09AF\u09BE\u0993\u0995",
  "marketplace.detailNotFoundTitle": "\u0989\u09CE\u09AA\u09BE\u09A6\u09A8 \u09AA\u09CB\u09F1\u09BE \u09A8\u0997'\u09B2",
  "marketplace.detailNotFoundMessage": "\u098F\u0987 \u0989\u09CE\u09AA\u09BE\u09A6\u09A8\u099F\u09CB \u09B9\u09AF\u09BC\u09A4\u09CB \u0986\u0981\u09A4\u09F0\u09BE\u0987 \u09A6\u09BF\u09AF\u09BC\u09BE \u09B9\u09C8\u099B\u09C7 \u09AC\u09BE \u098F\u09A4\u09BF\u09AF\u09BC\u09BE \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09B9\u09AF\u09BC\u0964",
  "marketplace.artisanSummaryTitle": "\u09B6\u09BF\u09B2\u09CD\u09AA\u09C0\u09F0 \u09AC\u09BF\u09B7\u09AF\u09BC\u09C7",
  "marketplace.artisanProductCount": "{n} \u099F\u09BE \u0989\u09CE\u09AA\u09BE\u09A6\u09A8 KalaSetu \u09A4 \u09A4\u09BE\u09B2\u09BF\u0995\u09BE\u09AD\u09C1\u0995\u09CD\u09A4",
  "marketplace.inquiryTitle": "\u098F\u0987 \u0989\u09CE\u09AA\u09BE\u09A6\u09A8\u09A4 \u0986\u0997\u09CD\u09F0\u09B9\u09C0 \u09A8\u09C7?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0986\u09AA\u09C1\u09A8\u09BF \u0995\u09BF \u09AC\u09BF\u099A\u09BE\u09F0\u09BF \u0986\u099B\u09C7, \u09AF\u09C7\u09A8\u09C7 \u09AA\u09F0\u09BF\u09AE\u09BE\u09A3, \u0995\u09BE\u09B7\u09CD\u099F\u09AE\u09BE\u0987\u099C\u09C7\u099A\u09A8, \u09A1\u09C7\u09B2\u09BF\u09AD\u09BE\u09F0\u09C0 \u09B8\u09AE\u09AF\u09BC\u09B8\u09C0\u09AE\u09BE \u0986\u09A6\u09BF \u09B6\u09BF\u09B2\u09CD\u09AA\u09C0\u0995 \u099C\u09A8\u09BE\u0993\u0995\u0964",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0985\u09A8\u09C1\u09F0\u09CB\u09A7 \u09AA\u09A0\u09BF\u09AF\u09BC\u09BE\u0993\u0995",
  "marketplace.inquirySent": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u0985\u09A8\u09C1\u09F0\u09CB\u09A7 \u09AA\u09A0\u09BF\u09AF\u09BC\u09BE\u0987\u099B\u09C7\u0964 \u09B6\u09BF\u09B2\u09CD\u09AA\u09C0 \u09B6\u09C0\u0998\u09CD\u09F0\u09C7 \u09AF\u09CB\u0997\u09BE\u09AF\u09CB\u0997 \u0995\u09F0\u09BF\u09AC\u0964",
  "marketplace.inquiryError": "\u0985\u09A8\u09C1\u09F0\u09CB\u09A7 \u09AA\u09A0\u09BF\u09AF\u09BC\u09BE\u09AC \u09A8\u09CB\u09F1\u09BE\u09F0\u09BF, \u0985\u09A8\u09C1\u0997\u09CD\u09F0\u09B9 \u0995\u09F0\u09BF \u09AA\u09C1\u09A8\u09F0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09F0\u0995\u0964",
  "marketplace.regionLabel": "\u0985\u099E\u09CD\u099A\u09B2",
  "marketplace.regionUnspecified": "\u09A8\u09BF\u09B0\u09CD\u09A6\u09BF\u09B7\u09CD\u099F \u0995\u09F0\u09BE \u09A8\u09B9\u09AF\u09BC",
  "marketplace.myInquiriesTitle": "\u09AE\u09CB\u09F0 \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8",
  "marketplace.inquiriesLoading": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u09B2\u09CB\u09A1 \u0995\u09F0\u09BE \u09B9\u09C8\u099B\u09C7...",
  "marketplace.inquiriesLoadError": "\u0986\u09AA\u09CB\u09A8\u09BE\u09F0 \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u09B2\u09CB\u09A1 \u0995\u09F0\u09BF\u09AC \u09AA\u09F0\u09BE \u09A8\u0997'\u09B2",
  "marketplace.noInquiries": "\u0986\u09AA\u09C1\u09A8\u09BF \u098F\u09A4\u09BF\u09AF\u09BC\u09BE\u09B2\u09C8\u0995\u09C7 \u0995\u09CB\u09A8\u09CB \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u09AA\u09A0\u09BE\u0987\u09A8\u09BF\u0964 \u09AC\u099C\u09BE\u09F0\u09A4 \u0998\u09C1\u09F0\u09BF \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0 \u09AC\u09BF\u099A\u09BE\u09F0\u0995\u0964",
  "marketplace.inquiryProductRemoved": "\u098F\u0987 \u09B8\u09BE\u09AE\u0997\u09CD\u09F0\u09C0\u099F\u09CB \u098F\u09A4\u09BF\u09AF\u09BC\u09BE \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09B9\u09AF\u09BC",
  "marketplace.inquiryStatusOpen": "\u0989\u09A4\u09CD\u09A4\u09F0\u09F0 \u0985\u09AA\u09C7\u0995\u09CD\u09B7\u09BE",
  "marketplace.inquiryStatusClosed": "\u09AC\u09A8\u09CD\u09A7",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/bn.json
var bn_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09B9\u09B8\u09CD\u09A4\u09B6\u09BF\u09B2\u09CD\u09AA \u0985\u09A8\u09B2\u09BE\u0987\u09A8\u09C7 \u09AC\u09BF\u0995\u09CD\u09B0\u09BF \u0995\u09B0\u09C1\u09A8, \u09B8\u09B9\u099C \u0989\u09AA\u09BE\u09DF\u09C7\u0964",
  "welcome.languageLabel": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AD\u09BE\u09B7\u09BE \u09A8\u09BF\u09B0\u09CD\u09AC\u09BE\u099A\u09A8 \u0995\u09B0\u09C1\u09A8",
  "welcome.getStarted": "\u09B6\u09C1\u09B0\u09C1 \u0995\u09B0\u09C1\u09A8",
  "language.en": "\u0987\u0982\u09B0\u09C7\u099C\u09BF",
  "language.hi": "\u09B9\u09BF\u09A8\u09CD\u09A6\u09BF",
  "email.title": "\u0986\u09AA\u09A8\u09BE\u09B0 \u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE \u09B2\u09BF\u0996\u09C1\u09A8",
  "email.roleQuestion": "\u0986\u09AE\u09BF \u098F\u0996\u09BE\u09A8\u09C7 \u0986\u099B\u09BF",
  "email.roleSell": "\u0986\u09AE\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF \u09AC\u09BF\u0995\u09CD\u09B0\u09BF \u0995\u09B0\u09C1\u09A8",
  "email.roleBuy": "\u09B9\u09B8\u09CD\u09A4\u09B6\u09BF\u09B2\u09CD\u09AA \u09AA\u09A3\u09CD\u09AF \u0995\u09BF\u09A8\u09C1\u09A8",
  "email.label": "\u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE",
  "email.helper": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09B0\u09BF\u099A\u09DF \u09AF\u09BE\u099A\u09BE\u0987 \u0995\u09B0\u09A4\u09C7 \u0986\u09AE\u09B0\u09BE \u09EA \u0985\u0999\u09CD\u0995\u09C7\u09B0 \u0995\u09CB\u09A1 \u09AA\u09BE\u09A0\u09BE\u09AC\u0964",
  "email.invalid": "\u09B8\u09A0\u09BF\u0995 \u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE \u09B2\u09BF\u0996\u09C1\u09A8",
  "email.sendOtp": "\u0995\u09CB\u09A1 \u09AA\u09BE\u09A0\u09BE\u09A8",
  "email.error": "\u0995\u09CB\u09A1 \u09AA\u09BE\u09A0\u09BE\u09A4\u09C7 \u09AC\u09CD\u09AF\u09B0\u09CD\u09A5, \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "otp.title": "\u0986\u09AA\u09A8\u09BE\u09B0 \u0987\u09AE\u09C7\u0987\u09B2 \u09AF\u09BE\u099A\u09BE\u0987 \u0995\u09B0\u09C1\u09A8",
  "otp.subtitle": "\u09AA\u09CD\u09B0\u09C7\u09B0\u09BF\u09A4 \u09EA \u0985\u0999\u09CD\u0995\u09C7\u09B0 \u0995\u09CB\u09A1 \u09B2\u09BF\u0996\u09C1\u09A8",
  "otp.emailUndelivered": "\u0987\u09AE\u09C7\u0987\u09B2 \u09AA\u09BE\u09A0\u09BE\u09A4\u09C7 \u09AA\u09BE\u09B0\u09BF\u09A8\u09BF\u0964 \u09A1\u09C7\u09AE\u09CB \u0995\u09CB\u09A1\u09C7\u09B0 \u099C\u09A8\u09CD\u09AF \u0986\u09AA\u09A8\u09BE\u09B0 \u099F\u09BF\u09AE\u09C7\u09B0 \u09B8\u0999\u09CD\u0997\u09C7 \u09AF\u09CB\u0997\u09BE\u09AF\u09CB\u0997 \u0995\u09B0\u09C1\u09A8\u0964",
  "otp.changeEmail": "\u0987\u09AE\u09C7\u0987\u09B2 \u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8 \u0995\u09B0\u09C1\u09A8",
  "otp.verify": "\u09AF\u09BE\u099A\u09BE\u0987 \u0995\u09B0\u09C1\u09A8",
  "otp.invalid": "\u09B8\u09AC \u09EA\u099F\u09BF \u0985\u0999\u09CD\u0995 \u09B2\u09BF\u0996\u09C1\u09A8",
  "otp.wrong": "\u09AD\u09C1\u09B2 OTP, \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "otp.resend": "OTP \u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u09AA\u09BE\u09A0\u09BE\u09A8",
  "otp.resendIn": "OTP {n} \u09B8\u09C7\u0995\u09C7\u09A8\u09CD\u09A1\u09C7 \u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u09AA\u09BE\u09A0\u09BE\u09A8",
  "otp.resendError": "OTP \u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u09AA\u09BE\u09A0\u09BE\u09A4\u09C7 \u09AC\u09CD\u09AF\u09B0\u09CD\u09A5, \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "camera.capture": "\u09AB\u099F\u09CB \u09A4\u09C1\u09B2\u09C1\u09A8",
  "camera.unavailable": "\u0995\u09CD\u09AF\u09BE\u09AE\u09C7\u09B0\u09BE \u09AC\u09CD\u09AF\u09AC\u09B9\u09BE\u09B0\u09AF\u09CB\u0997\u09CD\u09AF \u09A8\u09AF\u09BC, \u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09C7 \u09AB\u099F\u09CB \u09A8\u09BF\u09B0\u09CD\u09AC\u09BE\u099A\u09A8 \u0995\u09B0\u09C1\u09A8\u0964",
  "camera.choosePhoto": "\u09AB\u099F\u09CB \u09A8\u09BF\u09B0\u09CD\u09AC\u09BE\u099A\u09A8 \u0995\u09B0\u09C1\u09A8",
  "camera.retake": "\u0986\u09AC\u09BE\u09B0 \u09A8\u09BF\u09A8",
  "camera.usePhoto": "\u098F\u0987 \u099B\u09AC\u09BF \u09AC\u09CD\u09AF\u09AC\u09B9\u09BE\u09B0 \u0995\u09B0\u09C1\u09A8",
  "camera.enhancing": "\u099B\u09AC\u09BF \u0989\u09A8\u09CD\u09A8\u09A4 \u0995\u09B0\u09BE \u09B9\u099A\u09CD\u099B\u09C7...",
  "camera.enhanceError": "\u099B\u09AC\u09BF \u0989\u09A8\u09CD\u09A8\u09A4 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF",
  "camera.retry": "\u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "camera.before": "\u09AE\u09C2\u09B2",
  "camera.after": "\u0989\u09A8\u09CD\u09A8\u09A4",
  "camera.compareHint": "\u09A4\u09C1\u09B2\u09A8\u09BE\u09B0 \u099C\u09A8\u09CD\u09AF \u09B8\u09CD\u09B2\u09BE\u0987\u09A1\u09BE\u09B0 \u099F\u09BE\u09A8\u09C1\u09A8",
  "camera.continue": "\u099A\u09BE\u09B2\u09BF\u09AF\u09BC\u09C7 \u09AF\u09BE\u09A8",
  "studio.title": "\u0986\u09AA\u09A8\u09BE\u09B0 \u099B\u09AC\u09BF \u0989\u09A8\u09CD\u09A8\u09A4 \u0995\u09B0\u09C1\u09A8",
  "studio.original": "\u09AE\u09C2\u09B2",
  "studio.processed": "\u09AA\u09CD\u09B0\u0995\u09CD\u09B0\u09BF\u09AF\u09BC\u09BE\u0995\u09C3\u09A4",
  "studio.removeBackground": "\u09AA\u099F\u09AD\u09C2\u09AE\u09BF \u09B8\u09B0\u09BE\u09A8",
  "studio.removingBackground": "\u09AA\u099F\u09AD\u09C2\u09AE\u09BF \u09B8\u09B0\u09BE\u09A8\u09CB \u09B9\u099A\u09CD\u099B\u09C7...",
  "studio.keepOriginalBackground": "\u09AE\u09C2\u09B2 \u09AA\u099F\u09AD\u09C2\u09AE\u09BF \u09B0\u09BE\u0996\u09C1\u09A8",
  "studio.backgroundWhite": "\u09B8\u09BE\u09A6\u09BE",
  "studio.backgroundNeutral": "\u09A8\u09B0\u09AE \u0995\u09CD\u09B0\u09BF\u09AE",
  "studio.backgroundBlur": "\u09AC\u09CD\u09B2\u09BE\u09B0",
  "studio.backgroundUnavailableNotice": "\u09AA\u099F\u09AD\u09C2\u09AE\u09BF \u09B8\u09B0\u09BE\u09A8\u09CB \u098F\u0996\u09A8 \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09AF\u09BC\u0964 \u0986\u09AA\u09A8\u09BE\u09B0 \u099B\u09AC\u09BF \u0985\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09BF\u09A4 \u09A5\u09BE\u0995\u09AC\u09C7\u0964",
  "studio.backgroundTimedOutNotice": "\u09AA\u099F\u09AD\u09C2\u09AE\u09BF \u09B8\u09B0\u09BE\u09A4\u09C7 \u09AC\u09C7\u09B6\u09BF \u09B8\u09AE\u09AF\u09BC \u09B2\u09BE\u0997\u09BE\u09AF\u09BC \u098F\u099F\u09BF \u09AC\u09BE\u09A6 \u09A6\u09C7\u0993\u09AF\u09BC\u09BE \u09B9\u09AF\u09BC\u09C7\u099B\u09C7\u0964 \u0986\u09AA\u09A8\u09BE\u09B0 \u099B\u09AC\u09BF \u0985\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09BF\u09A4 \u09A5\u09BE\u0995\u09AC\u09C7\u0964",
  "studio.backgroundQuotaNotice": "\u09AA\u099F\u09AD\u09C2\u09AE\u09BF \u09B8\u09B0\u09BE\u09A8\u09CB\u09B0 \u0995\u09CB\u099F\u09BE \u09AC\u09B0\u09CD\u09A4\u09AE\u09BE\u09A8\u09C7 \u09B6\u09C7\u09B7 \u09B9\u09AF\u09BC\u09C7\u099B\u09C7\u0964 \u0986\u09AA\u09A8\u09BE\u09B0 \u099B\u09AC\u09BF \u0985\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09BF\u09A4 \u09A5\u09BE\u0995\u09AC\u09C7\u0964",
  "studio.backgroundFailedNotice": "\u09AC\u09CD\u09AF\u09BE\u0995\u0997\u09CD\u09B0\u09BE\u0989\u09A8\u09CD\u09A1 \u0985\u09AA\u09B8\u09BE\u09B0\u09A3 \u09AC\u09CD\u09AF\u09B0\u09CD\u09A5 \u09B9\u09AF\u09BC\u09C7\u099B\u09C7\u0964 \u0986\u09AA\u09A8\u09BE\u09B0 \u099B\u09AC\u09BF \u0985\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09BF\u09A4 \u09B0\u09AF\u09BC\u09C7\u099B\u09C7\u0964",
  "studio.brightness": "\u0989\u099C\u09CD\u099C\u09CD\u09AC\u09B2\u09A4\u09BE",
  "studio.contrast": "\u0995\u09A8\u099F\u09CD\u09B0\u09BE\u09B8\u09CD\u099F",
  "studio.sharpen": "\u09A4\u09C0\u0995\u09CD\u09B7\u09CD\u09A3 \u0995\u09B0\u09C1\u09A8",
  "studio.autoLighting": "\u09B8\u09CD\u09AC\u09AF\u09BC\u0982\u0995\u09CD\u09B0\u09BF\u09AF\u09BC \u0986\u09B2\u09CB",
  "studio.crop": "\u0995\u09BE\u099F\u09C1\u09A8",
  "studio.cropOriginal": "\u09AE\u09C2\u09B2",
  "studio.cropSquare": "\u09AC\u09B0\u09CD\u0997\u09BE\u0995\u09BE\u09B0",
  "studio.cropPortrait": "\u09AA\u09CB\u09B0\u09CD\u099F\u09CD\u09B0\u09C7\u099F",
  "studio.accept": "\u098F\u0987 \u099B\u09AC\u09BF \u09AC\u09CD\u09AF\u09AC\u09B9\u09BE\u09B0 \u0995\u09B0\u09C1\u09A8",
  "studio.retake": "\u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u09A4\u09C1\u09B2\u09C1\u09A8",
  "studio.finalizing": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE \u09AA\u09CD\u09B0\u09AF\u09BC\u09CB\u0997 \u0995\u09B0\u09BE \u09B9\u099A\u09CD\u099B\u09C7...",
  "studio.on": "\u0985\u09A8",
  "studio.off": "\u09AC\u09A8\u09CD\u09A7",
  "category.title": "\u0986\u09AA\u09A8\u09BF \u0995\u09C0 \u09AC\u09BF\u0995\u09CD\u09B0\u09BF \u0995\u09B0\u099B\u09C7\u09A8?",
  "category.continue": "\u099A\u09BE\u09B2\u09BF\u09AF\u09BC\u09C7 \u09AF\u09BE\u09A8",
  "category.materialQuestion": "\u098F\u099F\u09BF \u0995\u09C0 \u09A6\u09BF\u09AF\u09BC\u09C7 \u09A4\u09C8\u09B0\u09BF? (\u0990\u099A\u09CD\u099B\u09BF\u0995)",
  "category.textiles": "\u09AC\u09B8\u09CD\u09A4\u09CD\u09B0",
  "category.pottery": "\u09AE\u09C3\u09CE\u09B6\u09BF\u09B2\u09CD\u09AA",
  "category.jewelry": "\u0997\u09B9\u09A8\u09BE",
  "category.woodwork": "\u0995\u09BE\u09A0\u09C7\u09B0 \u0995\u09BE\u099C",
  "category.bambooCane": "\u09AC\u09BE\u0981\u09B6 \u0993 \u09AC\u09C7\u09A4",
  "category.other": "\u0985\u09A8\u09CD\u09AF\u09BE\u09A8\u09CD\u09AF",
  "voice.tapToRecord": "\u09AA\u09A3\u09CD\u09AF\u09C7\u09B0 \u09AC\u09B0\u09CD\u09A3\u09A8\u09BE \u09B0\u09C7\u0995\u09B0\u09CD\u09A1 \u0995\u09B0\u09A4\u09C7 \u099F\u09CD\u09AF\u09BE\u09AA \u0995\u09B0\u09C1\u09A8",
  "voice.recording": "\u09B0\u09C7\u0995\u09B0\u09CD\u09A1\u09BF\u0982 \u099A\u09B2\u099B\u09C7...",
  "voice.stop": "\u09B0\u09C7\u0995\u09B0\u09CD\u09A1\u09BF\u0982 \u09A5\u09BE\u09AE\u09BE\u09A8",
  "voice.record": "\u09B0\u09C7\u0995\u09B0\u09CD\u09A1",
  "voice.reviewRecording": "\u09B6\u09C1\u09A8\u09C7 \u09A8\u09BF\u09A8, \u09A4\u09BE\u09B0\u09AA\u09B0 \u099A\u09BE\u09B2\u09BF\u09AF\u09BC\u09C7 \u09AF\u09BE\u09A8 \u09AC\u09BE \u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u09B0\u09C7\u0995\u09B0\u09CD\u09A1 \u0995\u09B0\u09C1\u09A8",
  "voice.reRecord": "\u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u09B0\u09C7\u0995\u09B0\u09CD\u09A1",
  "voice.continue": "\u099A\u09BE\u09B2\u09BF\u09AF\u09BC\u09C7 \u09AF\u09BE\u09A8",
  "describe.transcribing": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AC\u09B0\u09CD\u09A3\u09A8\u09BE \u09AC\u09CB\u099D\u09BE \u09B9\u099A\u09CD\u099B\u09C7...",
  "describe.transcribeError": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AC\u09B0\u09CD\u09A3\u09A8\u09BE \u09AC\u09C1\u099D\u09A4\u09C7 \u09AA\u09BE\u09B0\u09BF\u09A8\u09BF",
  "describe.retry": "\u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "describe.reviewHint": "\u09AA\u09CD\u09B0\u09AF\u09BC\u09CB\u099C\u09A8 \u09B9\u09B2\u09C7 \u09AA\u09B0\u09CD\u09AF\u09BE\u09B2\u09CB\u099A\u09A8\u09BE \u0995\u09B0\u09C7 \u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE \u0995\u09B0\u09C1\u09A8",
  "describe.fallbackNote": "\u09AE\u09BE\u0987\u0995\u09CD\u09B0\u09CB\u09AB\u09CB\u09A8 \u0995\u09BE\u099C \u0995\u09B0\u099B\u09C7 \u09A8\u09BE, \u09AC\u09A6\u09B2\u09C7 \u0986\u09AA\u09A8\u09BE\u09B0 \u09AC\u09B0\u09CD\u09A3\u09A8\u09BE \u099F\u09BE\u0987\u09AA \u0995\u09B0\u09C1\u09A8\u0964",
  "describe.placeholderEn": "\u0987\u0982\u09B0\u09C7\u099C\u09BF\u09A4\u09C7 \u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF\u09C7\u09B0 \u09AC\u09B0\u09CD\u09A3\u09A8\u09BE \u09A6\u09BF\u09A8",
  "describe.continue": "\u0985\u0997\u09CD\u09B0\u09B8\u09B0 \u09B9\u09A8",
  "pricing.title": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF\u09C7\u09B0 \u09A6\u09BE\u09AE \u09A8\u09BF\u09B0\u09CD\u09A7\u09BE\u09B0\u09A3 \u0995\u09B0\u09C1\u09A8",
  "pricing.summaryEdit": "\u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE",
  "pricing.materialCostLabel": "\u0989\u09AA\u0995\u09B0\u09A3\u09C7\u09B0 \u0996\u09B0\u099A",
  "pricing.materialCostHelper": "\u0995\u09BE\u0981\u099A\u09BE\u09AE\u09BE\u09B2\u09C7\u09B0 \u099C\u09A8\u09CD\u09AF \u0986\u09AA\u09A8\u09BF \u09AF\u09C7 \u099F\u09BE\u0995\u09BE \u09AC\u09CD\u09AF\u09AF\u09BC \u0995\u09B0\u09C7\u099B\u09C7\u09A8, \u09B0\u09C1\u09AA\u09BF-\u09A4\u09C7 \u09B2\u09BF\u0996\u09C1\u09A8\u0964",
  "pricing.materialCostInvalid": "\u09E6 \u098F\u09B0 \u09AC\u09C7\u09B6\u09BF \u0989\u09AA\u0995\u09B0\u09A3\u09C7\u09B0 \u0996\u09B0\u099A \u09B2\u09BF\u0996\u09C1\u09A8",
  "pricing.getSuggestion": "\u09A6\u09BE\u09AE\u09C7\u09B0 \u09AA\u09B0\u09BE\u09AE\u09B0\u09CD\u09B6 \u09A8\u09BF\u09A8",
  "pricing.suggestError": "\u09A6\u09BE\u09AE\u09C7\u09B0 \u09AA\u09B0\u09BE\u09AE\u09B0\u09CD\u09B6 \u09AA\u09BE\u0993\u09AF\u09BC\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF",
  "pricing.retry": "\u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "pricing.rangeLabel": "\u09AA\u09CD\u09B0\u09B8\u09CD\u09A4\u09BE\u09AC\u09BF\u09A4 \u09A6\u09BE\u09AE\u09C7\u09B0 \u09B8\u09C0\u09AE\u09BE",
  "pricing.sellingPriceLabel": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AC\u09BF\u0995\u09CD\u09B0\u09AF\u09BC\u09AE\u09C2\u09B2\u09CD\u09AF",
  "pricing.sellingPriceNote": "\u098F\u099F\u09BF \u098F\u0995\u099F\u09BF \u09AA\u09B0\u09BE\u09AE\u09B0\u09CD\u09B6, \u0986\u09AA\u09A8\u09BF \u09AF\u09C7\u0995\u09CB\u09A8\u09CB \u09A6\u09BE\u09AE \u09B0\u09BE\u0996\u09A4\u09C7 \u09AA\u09BE\u09B0\u09C7\u09A8\u0964",
  "pricing.sellingPriceInvalid": "\u09E6 \u098F\u09B0 \u09AC\u09C7\u09B6\u09BF \u09AC\u09BF\u0995\u09CD\u09B0\u09AF\u09BC\u09AE\u09C2\u09B2\u09CD\u09AF \u09B2\u09BF\u0996\u09C1\u09A8",
  "pricing.publish": "\u09AA\u09CD\u09B0\u0995\u09BE\u09B6 \u0995\u09B0\u09C1\u09A8",
  "pricing.publishError": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF \u09AA\u09CD\u09B0\u0995\u09BE\u09B6 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF",
  "pricing.successTitle": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF \u098F\u0996\u09A8 \u09B2\u09BE\u0987\u09AD!",
  "pricing.successMessage": "\u0995\u09CD\u09B0\u09C7\u09A4\u09BE\u09B0\u09BE \u098F\u0996\u09A8 \u0986\u09AA\u09A8\u09BE\u09B0 \u09A6\u09CB\u0995\u09BE\u09A8\u09C7 \u098F\u099F\u09BF \u09A6\u09C7\u0996\u09A4\u09C7 \u09AA\u09BE\u09AC\u09C7\u0964",
  "pricing.viewShop": "\u0986\u09AE\u09BE\u09B0 \u09A6\u09CB\u0995\u09BE\u09A8\u09C7 \u09A6\u09C7\u0996\u09C1\u09A8",
  "home.title": "\u0986\u09AE\u09BE\u09B0 \u09A6\u09CB\u0995\u09BE\u09A8",
  "home.gemBannerTitle": "GeM / ONDC-\u09A4\u09C7 \u09B8\u0982\u09AF\u09C1\u0995\u09CD\u09A4 \u09B9\u09A8",
  "home.gemBannerBadge": "\u09B6\u09C0\u0998\u09CD\u09B0\u0987 \u0986\u09B8\u099B\u09C7",
  "home.gemBannerMessage": "\u098F\u0987 \u0987\u09A8\u09CD\u099F\u09BF\u0997\u09CD\u09B0\u09C7\u09B6\u09A8 \u09B6\u09C0\u0998\u09CD\u09B0\u0987 \u0986\u09B8\u099B\u09C7\u0964",
  "home.loading": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF \u09B2\u09CB\u09A1 \u09B9\u099A\u09CD\u099B\u09C7...",
  "home.loadError": "\u09AA\u09A3\u09CD\u09AF \u09B2\u09CB\u09A1 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF",
  "home.retry": "\u09AA\u09C1\u09A8\u09B0\u09BE\u09AF\u09BC \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "home.emptyTitle": "\u098F\u0996\u09A8\u09CB \u0995\u09CB\u09A8\u09CB \u09AA\u09A3\u09CD\u09AF \u09A8\u09C7\u0987",
  "home.emptyMessage": "KalaSetu-\u09A4\u09C7 \u09AC\u09BF\u0995\u09CD\u09B0\u09BF \u09B6\u09C1\u09B0\u09C1 \u0995\u09B0\u09A4\u09C7 \u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09CD\u09B0\u09A5\u09AE \u09AA\u09A3\u09CD\u09AF \u09AF\u09CB\u0997 \u0995\u09B0\u09C1\u09A8\u0964",
  "home.addFirstProduct": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09CD\u09B0\u09A5\u09AE \u09AA\u09A3\u09CD\u09AF \u09AF\u09CB\u0997 \u0995\u09B0\u09C1\u09A8",
  "home.statusPublished": "\u09AA\u09CD\u09B0\u0995\u09BE\u09B6\u09BF\u09A4",
  "home.statusDraft": "\u09A1\u09CD\u09B0\u09BE\u09AB\u09CD\u099F",
  "home.statusFailed": "\u09AC\u09CD\u09AF\u09B0\u09CD\u09A5",
  "home.detailCategory": "\u09B6\u09CD\u09B0\u09C7\u09A3\u09C0",
  "home.detailEdit": "\u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE",
  "home.detailDelete": "\u09AE\u09C1\u099B\u09C7 \u09AB\u09C7\u09B2\u09C1\u09A8",
  "home.detailClose": "\u09AC\u09A8\u09CD\u09A7 \u0995\u09B0\u09C1\u09A8",
  "home.editPriceLabel": "\u09A6\u09BE\u09AE",
  "home.editDescriptionLabel": "\u09AC\u09B0\u09CD\u09A3\u09A8\u09BE",
  "home.editSave": "\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8 \u09B8\u0982\u09B0\u0995\u09CD\u09B7\u09A3 \u0995\u09B0\u09C1\u09A8",
  "home.editCancel": "\u09AC\u09BE\u09A4\u09BF\u09B2 \u0995\u09B0\u09C1\u09A8",
  "home.editPriceInvalid": "\u09E6-\u098F\u09B0 \u099A\u09C7\u09AF\u09BC\u09C7 \u09AC\u09A1\u09BC \u09A6\u09BE\u09AE \u09B2\u09BF\u0996\u09C1\u09A8",
  "home.editDescriptionRequired": "\u09AC\u09B0\u09CD\u09A3\u09A8\u09BE \u0995\u09CB\u09A8\u09CB \u09AD\u09BE\u09B7\u09BE\u09A4\u09C7\u0987 \u0996\u09BE\u09B2\u09BF \u09B0\u09BE\u0996\u09BE \u09AF\u09BE\u09AC\u09C7 \u09A8\u09BE",
  "home.editError": "\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8 \u09B8\u0982\u09B0\u0995\u09CD\u09B7\u09A3 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF, \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "home.deleteConfirm": "\u098F\u0987 \u09AA\u09A3\u09CD\u09AF\u099F\u09BF \u09AE\u09C1\u099B\u09C7 \u09AB\u09C7\u09B2\u09AC\u09C7\u09A8? \u098F\u099F\u09BF \u09AA\u09C2\u09B0\u09CD\u09AC\u09BE\u09AC\u09B8\u09CD\u09A5\u09BE\u09AF\u09BC \u09AB\u09C7\u09B0\u09BE\u09A8\u09CB \u09AF\u09BE\u09AC\u09C7 \u09A8\u09BE\u0964",
  "home.deleteConfirmYes": "\u09B9\u09CD\u09AF\u09BE\u0981, \u09AE\u09C1\u099B\u09C7 \u09AB\u09C7\u09B2\u09C1\u09A8",
  "home.deleteError": "\u098F\u0987 \u09AA\u09A3\u09CD\u09AF\u099F\u09BF \u09AE\u09C1\u099B\u09A4\u09C7 \u09AC\u09CD\u09AF\u09B0\u09CD\u09A5 \u09B9\u09AF\u09BC\u09C7\u099B\u09C7, \u09A6\u09AF\u09BC\u09BE \u0995\u09B0\u09C7 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "profile.title": "\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2",
  "profile.emailLabel": "\u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE",
  "profile.emailUnknown": "\u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09AF\u09BC",
  "profile.loading": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2 \u09B2\u09CB\u09A1 \u09B9\u099A\u09CD\u099B\u09C7...",
  "profile.loadError": "\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2 \u09B2\u09CB\u09A1 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF",
  "profile.displayNameLabel": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09A8\u09BE\u09AE",
  "profile.shopNameLabel": "\u09A6\u09CB\u0995\u09BE\u09A8\u09C7\u09B0 \u09A8\u09BE\u09AE",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2 \u09B8\u0982\u09B0\u0995\u09CD\u09B7\u09A3 \u0995\u09B0\u09C1\u09A8",
  "profile.saved": "\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2 \u09B8\u0982\u09B0\u0995\u09CD\u09B7\u09BF\u09A4 \u09B9\u09AF\u09BC\u09C7\u099B\u09C7",
  "profile.saveError": "\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2 \u09B8\u0982\u09B0\u0995\u09CD\u09B7\u09A3 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF, \u09A6\u09AF\u09BC\u09BE \u0995\u09B0\u09C7 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "profile.logout": "\u09B2\u0997 \u0986\u0989\u099F",
  "install.message": "\u09A6\u09CD\u09B0\u09C1\u09A4 \u0985\u09CD\u09AF\u09BE\u0995\u09CD\u09B8\u09C7\u09B8\u09C7\u09B0 \u099C\u09A8\u09CD\u09AF KalaSetu \u0987\u09A8\u09B8\u09CD\u099F\u09B2 \u0995\u09B0\u09C1\u09A8",
  "install.action": "\u0987\u09A8\u09B8\u09CD\u099F\u09B2 \u0995\u09B0\u09C1\u09A8",
  "install.dismiss": "\u09AC\u09BE\u09A4\u09BF\u09B2 \u0995\u09B0\u09C1\u09A8",
  "offline.message": "\u0986\u09AA\u09A8\u09BF \u0985\u09AB\u09B2\u09BE\u0987\u09A8\u09C7 \u0986\u099B\u09C7\u09A8, \u0995\u09BF\u099B\u09C1 \u09AB\u09BF\u099A\u09BE\u09B0 \u0995\u09BE\u099C \u09A8\u09BE\u0993 \u0995\u09B0\u09A4\u09C7 \u09AA\u09BE\u09B0\u09C7",
  "welcome.languageHint": "\u09AA\u09C1\u09B0\u09CB \u0985\u09CD\u09AF\u09BE\u09AA \u098F\u0987 \u09AD\u09BE\u09B7\u09BE\u09AF\u09BC \u09B9\u09AC\u09C7\u0964",
  "welcome.regionalLanguages": "\u09AD\u09BE\u09B0\u09A4\u09C0\u09AF\u09BC \u09AD\u09BE\u09B7\u09BE",
  "describe.localTab": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AD\u09BE\u09B7\u09BE",
  "describe.placeholderLocal": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AD\u09BE\u09B7\u09BE\u09AF\u09BC \u09AA\u09A3\u09CD\u09AF\u099F\u09BF \u09AC\u09B0\u09CD\u09A3\u09A8\u09BE \u0995\u09B0\u09C1\u09A8",
  "describe.syncing": "\u0985\u09A8\u09CD\u09AF \u09AD\u09BE\u09B7\u09BE \u0986\u09AA\u09A1\u09C7\u099F \u09B9\u099A\u09CD\u099B\u09C7...",
  "describe.syncFailed": "\u0985\u09A8\u09CD\u09AF \u09AD\u09BE\u09B7\u09BE \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09B0\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF\u0964 \u09AA\u09CD\u09B0\u09DF\u09CB\u099C\u09A8 \u09B9\u09B2\u09C7 \u09A8\u09BF\u099C\u09C7 \u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE \u0995\u09B0\u09C1\u09A8\u0964",
  "describe.syncHint": "\u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE\u0997\u09C1\u09B2\u09BF \u09B8\u09CD\u09AC\u09DF\u0982\u0995\u09CD\u09B0\u09BF\u09DF\u09AD\u09BE\u09AC\u09C7 \u0985\u09A8\u09CD\u09AF \u09AD\u09BE\u09B7\u09BE\u09DF \u0995\u09AA\u09BF \u09B9\u09DF\u0964",
  "pricing.updating": "\u09A8\u09A4\u09C1\u09A8 \u0989\u09AA\u0995\u09B0\u09A3 \u09AE\u09C2\u09B2\u09CD\u09AF\u09C7\u09B0 \u099C\u09A8\u09CD\u09AF \u0986\u09AA\u09A1\u09C7\u099F \u09B9\u099A\u09CD\u099B\u09C7...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0995\u09CD\u09AF\u09BE\u099F\u09BE\u09B2\u0997 \u09B0\u09AA\u09CD\u09A4\u09BE\u09A8\u09BF (ONDC \u09AB\u09B0\u09AE\u09CD\u09AF\u09BE\u099F)",
  "home.exportCatalogNote": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09CD\u09B0\u0995\u09BE\u09B6\u09BF\u09A4 \u09A4\u09BE\u09B2\u09BF\u0995\u09BE\u0997\u09C1\u09B2\u09CB\u0995\u09C7 ONDC \u09B0\u09BF\u099F\u09C7\u0987\u09B2 \u0995\u09CD\u09AF\u09BE\u099F\u09BE\u09B2\u0997\u09C7\u09B0 \u0995\u09BE\u09A0\u09BE\u09AE\u09CB\u09A4\u09C7 \u09B0\u09C2\u09AA\u09BE\u09A8\u09CD\u09A4\u09B0 \u0995\u09B0\u09C7 \u09A1\u09BE\u0989\u09A8\u09B2\u09CB\u09A1 \u0995\u09B0\u09C7\u0964 \u0987\u09A8\u09CD\u099F\u09BF\u0997\u09CD\u09B0\u09C7\u09B6\u09A8-\u09B0\u09C7\u09A1\u09BF: \u09AE\u09CD\u09AF\u09BE\u09AA\u09BF\u0982 \u09B8\u09AE\u09CD\u09AA\u09A8\u09CD\u09A8, \u09A8\u09C7\u099F\u0993\u09AF\u09BC\u09BE\u09B0\u09CD\u0995\u09C7 \u09B2\u09BE\u0987\u09AD \u09B9\u09A4\u09C7 \u098F\u0996\u09A8\u0993 ONDC \u09B0\u09C7\u099C\u09BF\u09B8\u09CD\u099F\u09CD\u09B0\u09C7\u09B6\u09A8 \u09A6\u09B0\u0995\u09BE\u09B0\u0964",
  "home.exportOndcSingle": "\u098F\u0987 \u09AA\u09A3\u09CD\u09AF \u09B0\u09AA\u09CD\u09A4\u09BE\u09A8\u09BF (ONDC \u09AB\u09B0\u09AE\u09CD\u09AF\u09BE\u099F)",
  "profile.relocalising": "\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF\u0997\u09C1\u09B2\u09CB\u0995\u09C7 \u098F\u0987 \u09AD\u09BE\u09B7\u09BE\u09AF\u09BC \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09B0\u09BE \u09B9\u099A\u09CD\u099B\u09C7...",
  "profile.relocalised": "\u098F\u0987 \u09AD\u09BE\u09B7\u09BE\u09AF\u09BC {n}\u099F\u09BF \u09AA\u09A3\u09CD\u09AF \u0986\u09AA\u09A1\u09C7\u099F \u09B9\u09AF\u09BC\u09C7\u099B\u09C7\u0964",
  "profile.relocaliseFailed": "\u0995\u09BF\u099B\u09C1 \u09AA\u09A3\u09CD\u09AF \u0986\u09AA\u09A1\u09C7\u099F \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF\u0964 \u09AA\u09B0\u09C7 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8\u0964",
  "marketplace.navBrowse": "\u09AC\u09CD\u09B0\u09BE\u0989\u099C \u0995\u09B0\u09C1\u09A8",
  "marketplace.navProfile": "\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2",
  "marketplace.browseTitle": "\u09AC\u09BE\u099C\u09BE\u09B0",
  "marketplace.searchPlaceholder": "\u09AA\u09A3\u09CD\u09AF \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8...",
  "marketplace.filtersTitle": "\u09AB\u09BF\u09B2\u09CD\u099F\u09BE\u09B0",
  "marketplace.filtersClear": "\u09B8\u09AC \u09AE\u09C1\u099B\u09C1\u09A8",
  "marketplace.filterAll": "\u09B8\u09AC",
  "marketplace.filterMaterial": "\u0989\u09AA\u09BE\u09A6\u09BE\u09A8",
  "marketplace.filterRegion": "\u0985\u099E\u09CD\u099A\u09B2",
  "marketplace.filterPrice": "\u09AE\u09C2\u09B2\u09CD\u09AF \u09B8\u09C0\u09AE\u09BE (\u20B9)",
  "marketplace.filterPriceMin": "\u09A8\u09CD\u09AF\u09C2\u09A8\u09A4\u09AE",
  "marketplace.filterPriceMax": "\u09B8\u09B0\u09CD\u09AC\u09CB\u099A\u09CD\u099A",
  "marketplace.sortLabel": "\u09B8\u09BE\u099C\u09BE\u09A8\u09CB\u09B0 \u0995\u09CD\u09B0\u09AE",
  "marketplace.sortNewest": "\u09B8\u09B0\u09CD\u09AC\u09B6\u09C7\u09B7 \u09AA\u09CD\u09B0\u09A5\u09AE\u09C7",
  "marketplace.sortPriceAsc": "\u09A6\u09BE\u09AE: \u0995\u09AE \u09A5\u09C7\u0995\u09C7 \u09AC\u09C7\u09B6\u09BF",
  "marketplace.sortPriceDesc": "\u09A6\u09BE\u09AE: \u09AC\u09C7\u09B6\u09BF \u09A5\u09C7\u0995\u09C7 \u0995\u09AE",
  "marketplace.resultCount": "{n}\u099F\u09BF \u09AA\u09A3\u09CD\u09AF \u09AA\u09BE\u0993\u09DF\u09BE \u0997\u09C7\u099B\u09C7",
  "marketplace.loadMore": "\u0986\u09B0\u09CB \u09B2\u09CB\u09A1 \u0995\u09B0\u09C1\u09A8",
  "marketplace.loadError": "\u09AE\u09BE\u09B0\u09CD\u0995\u09C7\u099F\u09AA\u09CD\u09B2\u09C7\u09B8 \u09B2\u09CB\u09A1 \u0995\u09B0\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF, \u09A6\u09DF\u09BE \u0995\u09B0\u09C7 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "marketplace.emptyTitle": "\u098F\u0987 \u09AB\u09BF\u09B2\u09CD\u099F\u09BE\u09B0\u0997\u09C1\u09B2\u09CB\u09B0 \u09B8\u09BE\u09A5\u09C7 \u0995\u09CB\u09A8\u09CB \u09AA\u09A3\u09CD\u09AF \u09AE\u09C7\u09B2\u09C7 \u09A8\u09BE",
  "marketplace.emptyFiltered": "\u098F\u0995\u099F\u09BF \u09AB\u09BF\u09B2\u09CD\u099F\u09BE\u09B0 \u09AA\u09B0\u09BF\u09B7\u09CD\u0995\u09BE\u09B0 \u0995\u09B0\u09C1\u09A8 \u09AC\u09BE \u0985\u09A8\u09CD\u09AF \u0995\u09BF\u099B\u09C1 \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u0995\u09B0\u09C1\u09A8\u0964",
  "marketplace.emptyNoProducts": "\u098F\u0996\u09A8\u09CB \u0995\u09CB\u09A8\u09CB \u09AA\u09A3\u09CD\u09AF \u09AA\u09CD\u09B0\u0995\u09BE\u09B6\u09BF\u09A4 \u09B9\u09DF\u09A8\u09BF\u0964 \u09B6\u09BF\u0997\u0997\u09BF\u09B0\u0987 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u0995 \u0995\u09B0\u09C1\u09A8\u0964",
  "marketplace.artisanUnnamed": "KalaSetu \u09B6\u09BF\u09B2\u09CD\u09AA\u09C0",
  "marketplace.backToBrowse": "\u09AC\u09BE\u099C\u09BE\u09B0\u09C7 \u09AB\u09BF\u09B0\u09C7 \u09AF\u09BE\u09A8",
  "marketplace.detailNotFoundTitle": "\u09AA\u09A3\u09CD\u09AF \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF",
  "marketplace.detailNotFoundMessage": "\u098F\u0987 \u09AA\u09A3\u09CD\u09AF\u099F\u09BF \u09B8\u09B0\u09BE\u09A8\u09CB \u09B9\u09A4\u09C7 \u09AA\u09BE\u09B0\u09C7 \u0985\u09A5\u09AC\u09BE \u0986\u09B0 \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09C7\u0987\u0964",
  "marketplace.artisanSummaryTitle": "\u09B6\u09BF\u09B2\u09CD\u09AA\u09C0\u09B0 \u09B8\u09AE\u09CD\u09AA\u09B0\u09CD\u0995\u09C7",
  "marketplace.artisanProductCount": "{n}\u099F\u09BF \u09AA\u09A3\u09CD\u09AF \u0995\u09BE\u09B2\u09BE\u09B8\u09C7\u099F\u09C1\u09A4\u09C7 \u09A4\u09BE\u09B2\u09BF\u0995\u09BE\u09AD\u09C1\u0995\u09CD\u09A4",
  "marketplace.inquiryTitle": "\u098F\u0987 \u09AA\u09A3\u09CD\u09AF\u09C7 \u0986\u0997\u09CD\u09B0\u09B9\u09C0?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0986\u09AA\u09A8\u09BF \u0995\u09C0 \u099A\u09BE\u09A8 \u09A4\u09BE \u09B6\u09BF\u09B2\u09CD\u09AA\u09C0\u0995\u09C7 \u099C\u09BE\u09A8\u09BE\u09A8: \u09AA\u09B0\u09BF\u09AE\u09BE\u09A3, \u0995\u09BE\u09B8\u09CD\u099F\u09AE\u09BE\u0987\u099C\u09C7\u09B6\u09A8, \u09A1\u09C7\u09B2\u09BF\u09AD\u09BE\u09B0\u09BF\u09B0 \u09B8\u09AE\u09AF\u09BC\u09B8\u09C0\u09AE\u09BE...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0985\u09A8\u09C1\u09B0\u09CB\u09A7 \u09AA\u09BE\u09A0\u09BE\u09A8",
  "marketplace.inquirySent": "\u0986\u09AA\u09A8\u09BE\u09B0 \u0985\u09A8\u09C1\u09B0\u09CB\u09A7 \u09AA\u09BE\u09A0\u09BE\u09A8\u09CB \u09B9\u09AF\u09BC\u09C7\u099B\u09C7\u0964 \u09B6\u09BF\u09B2\u09CD\u09AA\u09C0 \u09B6\u09C0\u0998\u09CD\u09B0\u0987 \u09AF\u09CB\u0997\u09BE\u09AF\u09CB\u0997 \u0995\u09B0\u09AC\u09C7\u09A8\u0964",
  "marketplace.inquiryError": "\u0985\u09A8\u09C1\u09B0\u09CB\u09A7 \u09AA\u09BE\u09A0\u09BE\u09A4\u09C7 \u09AC\u09CD\u09AF\u09B0\u09CD\u09A5 \u09B9\u09AF\u09BC\u09C7\u099B\u09C7, \u09A6\u09AF\u09BC\u09BE \u0995\u09B0\u09C7 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8",
  "marketplace.regionLabel": "\u0985\u099E\u09CD\u099A\u09B2",
  "marketplace.regionUnspecified": "\u09A8\u09BF\u09B0\u09CD\u09A6\u09BF\u09B7\u09CD\u099F \u09A8\u09AF\u09BC",
  "marketplace.myInquiriesTitle": "\u0986\u09AE\u09BE\u09B0 \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8",
  "marketplace.inquiriesLoading": "\u0986\u09AA\u09A8\u09BE\u09B0 \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u09B2\u09CB\u09A1 \u09B9\u099A\u09CD\u099B\u09C7...",
  "marketplace.inquiriesLoadError": "\u0986\u09AA\u09A8\u09BE\u09B0 \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u09B2\u09CB\u09A1 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF",
  "marketplace.noInquiries": "\u0986\u09AA\u09A8\u09BF \u098F\u0996\u09A8\u09CB \u0995\u09CB\u09A8\u09CB \u0985\u09A8\u09C1\u09B8\u09A8\u09CD\u09A7\u09BE\u09A8 \u09AA\u09BE\u09A0\u09BE\u09A8\u09A8\u09BF\u0964 \u09AA\u09A3\u09CD\u09AF \u0996\u09C1\u0981\u099C\u09A4\u09C7 \u09AE\u09BE\u09B0\u09CD\u0995\u09C7\u099F\u09AA\u09CD\u09B2\u09C7\u09B8 \u09AC\u09CD\u09B0\u09BE\u0989\u099C \u0995\u09B0\u09C1\u09A8\u0964",
  "marketplace.inquiryProductRemoved": "\u098F\u0987 \u09AA\u09A3\u09CD\u09AF\u099F\u09BF \u0986\u09B0 \u0989\u09AA\u09B2\u09AC\u09CD\u09A7 \u09A8\u09AF\u09BC",
  "marketplace.inquiryStatusOpen": "\u0989\u09A4\u09CD\u09A4\u09B0\u09C7\u09B0 \u0985\u09AA\u09C7\u0995\u09CD\u09B7\u09BE\u09AF\u09BC",
  "marketplace.inquiryStatusClosed": "\u09AC\u09A8\u09CD\u09A7",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "\u0995\u09BF\u099B\u09C1 \u0985\u09A4\u09BF\u09B0\u09BF\u0995\u09CD\u09A4 \u09A4\u09A5\u09CD\u09AF (\u0990\u099A\u09CD\u099B\u09BF\u0995)",
  "heritage.subtitle": "\u098F\u0997\u09C1\u09B2\u09CB \u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09A3\u09CD\u09AF\u09C7\u09B0 \u09B9\u09C7\u09B0\u09BF\u099F\u09C7\u099C \u09AA\u09BE\u09B8\u09AA\u09CB\u09B0\u09CD\u099F\u09C7 \u0997\u09B2\u09CD\u09AA \u09AC\u09B2\u09A4\u09C7 \u09B8\u09BE\u09B9\u09BE\u09AF\u09CD\u09AF \u0995\u09B0\u09C7\u0964 \u0986\u09AA\u09A8\u09BF \u09A8\u09BF\u09B6\u09CD\u099A\u09BF\u09A4 \u09A8\u09BE \u09B9\u09B2\u09C7 \u09AC\u09BE\u09A6 \u09A6\u09BF\u09A8\u0964",
  "heritage.techniqueLabel": "\u09AA\u09CD\u09B0\u09AF\u09C1\u0995\u09CD\u09A4\u09BF",
  "heritage.techniquePlaceholder": "\u09AF\u09C7\u09AE\u09A8: \u09B9\u09CD\u09AF\u09BE\u09A8\u09CD\u09A1-\u09A5\u09CD\u09B0\u09CB\u09A8, \u09AC\u09CD\u09B2\u0995 \u09AA\u09CD\u09B0\u09BF\u09A8\u09CD\u099F\u09BF\u0982",
  "heritage.timeTakenLabel": "\u09A8\u09BF\u09B0\u09CD\u09AE\u09BE\u09A3\u09C7 \u09B8\u09AE\u09AF\u09BC",
  "heritage.timeTakenPlaceholder": "\u09AF\u09C7\u09AE\u09A8: \u09E8 \u09A6\u09BF\u09A8",
  "heritage.giTagLabel": "GI \u09AC\u09BE ODOP \u099F\u09CD\u09AF\u09BE\u0997, \u09AF\u09A6\u09BF \u09A5\u09BE\u0995\u09C7",
  "heritage.giTagPlaceholder": "\u09AF\u09C7\u09AE\u09A8: Banaras Brocade GI",
  "heritage.careLabel": "\u09AF\u09A4\u09CD\u09A8\u09C7\u09B0 \u09A8\u09BF\u09B0\u09CD\u09A6\u09C7\u09B6\u09A8\u09BE",
  "heritage.carePlaceholder": "\u09AF\u09C7\u09AE\u09A8: \u0995\u09C7\u09AC\u09B2 \u09B9\u09BE\u09A4\u09C7 \u09A7\u09CB\u09AF\u09BC\u09BE, \u09B8\u09B0\u09BE\u09B8\u09B0\u09BF \u09B8\u09C2\u09B0\u09CD\u09AF\u09BE\u09B2\u09CB\u0995 \u09A5\u09C7\u0995\u09C7 \u09A6\u09C2\u09B0\u09C7 \u09B0\u09BE\u0996\u09C1\u09A8",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "\u099A\u09BE\u09B2\u09BF\u09AF\u09BC\u09C7 \u09AF\u09BE\u09A8",
  "passport.viewLink": "\u09B9\u09C7\u09B0\u09BF\u099F\u09C7\u099C \u09AA\u09BE\u09B8\u09AA\u09CB\u09B0\u09CD\u099F \u09A6\u09C7\u0996\u09C1\u09A8",
  "passport.eyebrow": "\u09B6\u09BF\u09B2\u09CD\u09AA \u0990\u09A4\u09BF\u09B9\u09CD\u09AF \u09AA\u09BE\u09B8\u09AA\u09CB\u09B0\u09CD\u099F",
  "passport.selfDeclaredNotice": "\u09B6\u09BF\u09B2\u09CD\u09AA\u09C0\u09B0 \u09B8\u09CD\u09AC-\u0998\u09CB\u09B7\u09BF\u09A4\u0964 \u09B8\u09B0\u0995\u09BE\u09B0\u09C0 \u09B8\u09BE\u09B0\u09CD\u099F\u09BF\u09AB\u09BF\u0995\u09C7\u099F \u09A8\u09AF\u09BC\u0964",
  "passport.productIdLabel": "\u09AA\u09A3\u09CD\u09AF \u0986\u0987\u09A1\u09BF",
  "passport.artisanLabel": "\u09B6\u09BF\u09B2\u09CD\u09AA\u09C0",
  "passport.regionLabel": "\u0985\u099E\u09CD\u099A\u09B2",
  "passport.craftTypeLabel": "\u09B6\u09BF\u09B2\u09CD\u09AA\u09C7\u09B0 \u09A7\u09B0\u09A8",
  "passport.techniqueLabel": "\u09AA\u09CD\u09B0\u09AF\u09C1\u0995\u09CD\u09A4\u09BF",
  "passport.materialsLabel": "\u09AC\u09CD\u09AF\u09AC\u09B9\u09C3\u09A4 \u0989\u09AA\u0995\u09B0\u09A3",
  "passport.timeTakenLabel": "\u09A8\u09C7\u09AF\u09BC\u09BE \u09B8\u09AE\u09AF\u09BC",
  "passport.createdLabel": "\u09A4\u09C8\u09B0\u09BF",
  "passport.giTagLabel": "GI / ODOP \u099F\u09CD\u09AF\u09BE\u0997",
  "passport.careLabel": "\u09AF\u09A4\u09CD\u09A8 \u09A8\u09BF\u09B0\u09CD\u09A6\u09C7\u09B6\u09A8\u09BE",
  "passport.storyTitle": "\u09AA\u09A3\u09CD\u09AF\u09C7\u09B0 \u0997\u09B2\u09CD\u09AA",
  "passport.storyUnavailable": "\u098F\u0987 \u09AA\u09A3\u09CD\u09AF\u09C7\u09B0 \u0997\u09B2\u09CD\u09AA \u098F\u0996\u09A8\u0993 \u09B2\u09C7\u0996\u09BE \u09B9\u099A\u09CD\u099B\u09C7\u0964",
  "passport.shareButton": "\u09B6\u09C7\u09AF\u09BC\u09BE\u09B0",
  "passport.shareCopied": "\u09B2\u09BF\u0999\u09CD\u0995 \u0995\u09AA\u09BF \u09B9\u09AF\u09BC\u09C7\u099B\u09C7",
  "passport.printButton": "\u09AA\u09CD\u09B0\u09BF\u09A8\u09CD\u099F",
  "passport.scanHint": "\u0985\u09A8\u09B2\u09BE\u0987\u09A8\u09C7 \u09AA\u09BE\u09B8\u09AA\u09CB\u09B0\u09CD\u099F \u09A6\u09C7\u0996\u09A4\u09C7 \u09B8\u09CD\u0995\u09CD\u09AF\u09BE\u09A8 \u0995\u09B0\u09C1\u09A8",
  "passport.notFoundTitle": "\u09AA\u09BE\u09B8\u09AA\u09CB\u09B0\u09CD\u099F \u09AA\u09BE\u0993\u09AF\u09BC\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF",
  "passport.notFoundMessage": "\u098F\u0987 \u0990\u09A4\u09BF\u09B9\u09CD\u09AF\u09AC\u09BE\u09B9\u09C0 \u09AA\u09BE\u09B8\u09AA\u09CB\u09B0\u09CD\u099F\u099F\u09BF \u09A8\u09C7\u0987, \u0985\u09A5\u09AC\u09BE \u09A4\u09BE\u09B2\u09BF\u0995\u09BE\u099F\u09BF \u0986\u09B0 \u09AA\u09BE\u09AC\u09B2\u09BF\u0995 \u09A8\u09AF\u09BC\u0964",
  "passport.loadError": "\u098F\u0987 \u09AA\u09BE\u09B8\u09AA\u09CB\u09B0\u09CD\u099F \u09B2\u09CB\u09A1 \u0995\u09B0\u09BE \u09AF\u09BE\u09AF\u09BC\u09A8\u09BF"
};

// shared/locales/brx.json
var brx_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0924\u0941\u092E\u091A\u093E \u0915\u0932\u093E\u0915\u093E\u0930\u093F\u0924\u093E \u0911\u0928\u0932\u093E\u0907\u0928 \u092C\u093F\u0915\u094D\u0930\u0940 \u0915\u0930, \u0938\u0941\u0932\u092D \u092A\u0926\u094D\u0927\u0924\u0940\u0928\u0947.",
  "welcome.languageLabel": "\u0924\u0941\u092E\u091A\u0940 \u092D\u093E\u0937\u093E \u0928\u093F\u0935\u0921\u093E",
  "welcome.getStarted": "\u0938\u0941\u0930\u0941 \u0915\u0930\u093E",
  "language.en": "\u0907\u0902\u0917\u094D\u0930\u091C\u0940",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "\u0924\u0941\u092E\u091A\u093E \u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E \u091F\u093E\u0915\u093E",
  "email.roleQuestion": "\u092E\u093E\u092F \u0925\u093E\u0902\u0928\u093E\u092F",
  "email.roleSell": "\u092C\u093F\u0938\u093E\u092C \u092C\u0947\u091A\u093E\u092C",
  "email.roleBuy": "\u0939\u093E\u0925\u0947 \u092C\u0928\u093E\u092F \u092C\u093F\u0938\u093E\u092C \u0916\u094B\u0930\u093E\u092C",
  "email.label": "\u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E",
  "email.helper": "\u0906\u092E\u094D\u0939\u0940 \u0924\u0941\u092E\u094D\u0939\u093E\u0932\u093E 4 \u0905\u0902\u0915\u0940 \u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u0942, \u091C\u0947\u0923\u0947\u0915\u0930\u0942\u0928 \u0924\u0941\u092E\u094D\u0939\u0940 \u0924\u0941\u092E\u094D\u0939\u0940 \u0906\u0939\u093E\u0924 \u092F\u093E\u091A\u0940 \u0916\u093E\u0924\u094D\u0930\u0940 \u0939\u094B\u0908\u0932.",
  "email.invalid": "\u0935\u0948\u0927 \u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E \u091F\u093E\u0915\u093E",
  "email.sendOtp": "\u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u093E",
  "email.error": "\u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "otp.title": "\u0908\u092E\u0947\u0932 \u091C\u093E\u0901\u091A",
  "otp.subtitle": "\u092A\u0920\u093E\u092F\u093E 4 \u0905\u0902\u0915\u0915\u094B \u0915\u094B\u0921 \u0932\u093F\u0916",
  "otp.emailUndelivered": "\u0908\u092E\u0947\u0932 \u092A\u0920\u093E\u0909\u0928 \u0938\u0915\u0932\u0964 \u0921\u0947\u092E\u094B \u0915\u094B\u0921 \u0916\u093E\u0924\u093F\u0930 \u091F\u093F\u092E\u0938\u0902\u0917 \u0915\u0941\u0930\u093E \u0915\u0930\u0964",
  "otp.changeEmail": "\u0908\u092E\u0947\u0932 \u092C\u0926\u0932",
  "otp.verify": "\u091C\u093E\u0901\u091A",
  "otp.invalid": "\u0938\u092C 4 \u0905\u0902\u0915 \u0932\u093F\u0916",
  "otp.wrong": "\u0917\u0932\u0924 OTP, \u092B\u0947\u0930\u093F \u0915\u094B\u0936\u093F\u0936 \u0915\u0930",
  "otp.resend": "OTP \u092B\u0947\u0930\u093F \u092A\u0920\u093E",
  "otp.resendIn": "{n}s \u092A\u091B\u093F OTP \u092B\u0947\u0930\u093F \u092A\u0920\u093E",
  "otp.resendError": "OTP \u092B\u0947\u0930\u093F \u092A\u0920\u093E\u0909\u0928 \u0938\u0915\u0932, \u092B\u0947\u0930\u093F \u0915\u094B\u0936\u093F\u0936 \u0915\u0930",
  "camera.capture": "\u092B\u094B\u091F\u094B \u0916\u093F\u0902\u091A",
  "camera.unavailable": "\u0915\u094D\u092F\u093E\u092E\u0930\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E, \u092B\u094B\u091F\u094B \u091A\u0941\u0928\u0964",
  "camera.choosePhoto": "\u092B\u094B\u091F\u094B \u091A\u0941\u0928\u0947",
  "camera.retake": "\u092B\u0947\u0930\u093F \u0916\u093F\u091A\u0947",
  "camera.usePhoto": "\u0907 \u092B\u094B\u091F\u094B \u092C\u094D\u092F\u094B\u0930\u0947",
  "camera.enhancing": "\u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u093F \u092C\u092F\u093E...",
  "camera.enhanceError": "\u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930 \u0928 \u0916\u0947",
  "camera.retry": "\u092B\u0947\u0930\u093F \u0916\u0947",
  "camera.before": "\u092E\u0942\u0933",
  "camera.after": "\u0938\u0941\u0927\u093E\u0930\u0932",
  "camera.compareHint": "\u0924\u0941\u0932\u0928\u093E \u0915\u0930\u0947 \u0916\u093E\u0924\u093F\u0930 \u0938\u094D\u0932\u093E\u0907\u0921 \u0916\u0947",
  "camera.continue": "\u0906\u0917\u093E \u0916\u0947",
  "studio.title": "\u092B\u094B\u091F\u094B \u0928\u093E\u092F\u093E\u092C \u0925\u093E\u0902",
  "studio.original": "\u092E\u0942\u0932",
  "studio.processed": "\u092A\u094D\u0930\u094B\u0938\u0947\u0938\u094D\u0921",
  "studio.removeBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092F",
  "studio.removingBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092F \u091C\u093E\u092C...",
  "studio.keepOriginalBackground": "\u092E\u0942\u0932 \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0930\u0916\u093E\u092F",
  "studio.backgroundWhite": "\u0938\u0947\u092C\u094B",
  "studio.backgroundNeutral": "\u0928\u0930\u092E \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0941\u0902\u0927",
  "studio.backgroundUnavailableNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092F \u0905\u092C\u0939\u093F\u0902 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u092F\u0964 \u0925\u093E\u0902\u0928\u093F \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u093E\u092F \u0928\u093E\u092F\u0964",
  "studio.backgroundTimedOutNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092F \u092C\u093F\u0938\u093E \u0925\u093E\u0902\u092C\u093E\u092F\u0964 \u0925\u093E\u0902\u0928\u093F \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u093E\u092F \u0928\u093E\u092F\u0964",
  "studio.backgroundQuotaNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092F \u0915\u094B\u091F\u093E \u0905\u092C\u0939\u093F\u0902 \u0925\u093E\u0902\u092C\u093E\u092F\u0964 \u0925\u093E\u0902\u0928\u093F \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u093E\u092F \u0928\u093E\u092F\u0964",
  "studio.backgroundFailedNotice": "\u092C\u0948\u0915\u0917\u094D\u0930\u093E\u0909\u0902\u0921 \u0939\u091F\u093E\u092C\u093E \u092B\u0947\u0932 \u0939\u094B\u092C\u094B\u0964 \u0924\u0941\u092E\u093E\u0930 \u092B\u094B\u091F\u094B \u0928\u093E\u092F \u092C\u0926\u0932\u093E\u092F\u0964",
  "studio.brightness": "\u092C\u093F\u0932\u093E\u0907",
  "studio.contrast": "\u092B\u0930\u0915",
  "studio.sharpen": "\u0924\u0940\u0916\u094B",
  "studio.autoLighting": "\u0911\u091F\u094B \u092C\u093F\u0932\u093E\u0907",
  "studio.crop": "\u0915\u091F",
  "studio.cropOriginal": "\u092E\u0942\u0932",
  "studio.cropSquare": "\u091A\u094C\u0915\u094B\u0930",
  "studio.cropPortrait": "\u092A\u094B\u0930\u094D\u091F\u094D\u0930\u0947\u091F",
  "studio.accept": "\u0907\u0939\u093E\u0902 \u092B\u094B\u091F\u094B \u092C\u093E\u092F",
  "studio.retake": "\u092B\u093F\u0930\u093F \u092B\u094B\u091F\u094B \u0932\u093E\u092C",
  "studio.finalizing": "\u0924\u0941\u092E\u093E\u0930 \u090F\u0921\u093F\u091F \u092C\u093E\u092F \u0932\u093E\u0917\u0942 \u0939\u094B\u092C\u094B...",
  "studio.on": "\u0938\u093E\u092C",
  "studio.off": "\u092C\u093F\u0926\u093E",
  "category.title": "\u0924\u0941\u092E \u0915\u093F \u092C\u0947\u091A\u0947?",
  "category.continue": "\u0906\u0917\u093E \u0916\u0947",
  "category.materialQuestion": "\u092C\u093E\u092C\u093E \u0925\u093E\u0902\u0928\u093F? (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "category.textiles": "\u0915\u092A\u0921\u093C\u093E",
  "category.pottery": "\u092E\u093F\u091F\u094D\u091F\u0940 \u0915\u0947 \u092C\u0930\u094D\u0924\u0928",
  "category.jewelry": "\u0906\u092D\u0942\u0937\u0923",
  "category.woodwork": "\u0932\u0915\u0921\u093C\u0940 \u0915\u093E \u0915\u093E\u092E",
  "category.bambooCane": "\u092C\u093E\u0902\u0938 \u0935 \u0915\u0928\u093E",
  "category.other": "\u0905\u0928\u094D\u092F",
  "voice.tapToRecord": "\u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0947 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902 \u092C\u0924\u093E\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u091F\u0948\u092A \u0915\u0930\u0947\u0902",
  "voice.recording": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u0939\u094B \u0930\u0939\u0940 \u0939\u0948...",
  "voice.stop": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u092C\u0902\u0926 \u0915\u0930\u0947\u0902",
  "voice.record": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0947\u0902",
  "voice.reviewRecording": "\u0938\u0941\u0928\u0947\u0902, \u092B\u093F\u0930 \u0906\u0917\u0947 \u092C\u0922\u093C\u0947\u0902 \u092F\u093E \u092B\u093F\u0930 \u0938\u0947 \u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0947\u0902\u0964",
  "voice.reRecord": "\u092B\u093F\u0930 \u0938\u0947 \u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0947\u0902",
  "voice.continue": "\u0906\u0917\u093E\u0907",
  "describe.transcribing": "\u0924\u0941\u092E\u0930 \u0915\u0925\u0928 \u092C\u0941\u091D\u093E\u0924 \u0906...",
  "describe.transcribeError": "\u0924\u0941\u092E\u0930 \u0915\u0925\u0928 \u092C\u0941\u091D\u0932 \u0928\u093E",
  "describe.retry": "\u092B\u0947\u0930 \u0916\u094B\u091C",
  "describe.reviewHint": "\u091C\u0930\u0942\u0930\u0924 \u0939\u094B\u0932\u0947\u0902 \u0924\u0948 \u092C\u0926\u0932",
  "describe.fallbackNote": "\u092E\u093E\u0907\u0915 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E, \u0932\u093F\u0916\u0924 \u092C\u093E\u0928\u0940\u0964",
  "describe.placeholderEn": "\u0905\u0902\u0917\u094D\u0930\u0947\u091C\u0940\u092E \u0924\u0941\u092E\u0930 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092C\u093E\u0928\u0940",
  "describe.continue": "\u0906\u0917\u093E\u0907",
  "pricing.title": "\u0924\u0941\u092E\u0930 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0915 \u092E\u0942\u0932\u094D\u092F",
  "pricing.summaryEdit": "\u092C\u0926\u0932",
  "pricing.materialCostLabel": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940\u0915 \u0932\u093E\u0917\u0924",
  "pricing.materialCostHelper": "\u0915\u091A\u094D\u091A\u093E \u092E\u093E\u0932\u092E \u0916\u0930\u094D\u091A \u0915\u0947\u0932\u0947\u0902, \u0930\u0941\u092A\u093F\u092F\u093E\u092E\u0964",
  "pricing.materialCostInvalid": "\u0966 \u092D\u093F\u0902\u0926\u093E \u0916\u093E\u0932\u0940 \u0916\u0930\u094D\u091A \u0932\u093F\u0916\u0941",
  "pricing.getSuggestion": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935 \u092A\u093E\u0909\u0928\u0941",
  "pricing.suggestError": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935 \u092A\u093E\u0909\u0928 \u0938\u0915\u093E\u0908",
  "pricing.retry": "\u092B\u0947\u0930\u093F \u0916\u094B\u091C\u0941",
  "pricing.rangeLabel": "\u0938\u0941\u091D\u093E\u0935 \u092E\u0942\u0932\u094D\u092F \u0926\u093E\u092F\u0930\u093E",
  "pricing.sellingPriceLabel": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092C\u093F\u0915\u094D\u0930\u0940 \u092E\u0942\u0932\u094D\u092F",
  "pricing.sellingPriceNote": "\u092F\u094B \u0938\u0941\u091D\u093E\u0935 \u0939\u094B, \u0924\u092A\u093E\u0908\u0902\u0932\u0947 \u091C\u0941\u0928 \u092E\u0942\u0932\u094D\u092F \u091A\u093E\u0939\u0928\u0941\u0939\u0941\u0928\u094D\u091B \u0924\u094D\u092F\u094B \u0930\u093E\u0916\u0941\u0964",
  "pricing.sellingPriceInvalid": "\u0966 \u092D\u093F\u0902\u0926\u093E \u0916\u093E\u0932\u0940 \u092C\u093F\u0915\u094D\u0930\u0940 \u092E\u0942\u0932\u094D\u092F \u0932\u093F\u0916\u0941",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0917\u0930\u094D\u0928\u0941",
  "pricing.publishError": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0917\u0930\u094D\u0928 \u0938\u0915\u093E\u0908",
  "pricing.successTitle": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u091B!",
  "pricing.successMessage": "\u0916\u0930\u093F\u0926\u0926\u093E\u0930\u0939\u0930\u0942 \u0905\u092C \u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0926\u0941\u0915\u093E\u0928\u092E\u093E \u092F\u094B \u092A\u0924\u094D\u0924\u093E \u0932\u0917\u093E\u0909\u0928 \u0938\u0915\u094D\u091B\u0964",
  "pricing.viewShop": "\u092E\u092F\u093E \u0926\u0941\u0915\u093E\u0928\u092E\u093F \u0916\u093E\u0932",
  "home.title": "\u092E\u092F\u093E \u0926\u0941\u0915\u093E\u0928",
  "home.gemBannerTitle": "GeM / ONDC \u0915\u0925\u093F \u091C\u094B\u0921",
  "home.gemBannerBadge": "\u091C\u0932\u094D\u0926\u0940 \u0906\u0907\u0924",
  "home.gemBannerMessage": "\u0907 \u091C\u094B\u0921 \u091C\u0932\u094D\u0926\u0940 \u0906\u0907\u0924\u0964",
  "home.loading": "\u0924\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0932\u094B\u0921 \u0939\u094B\u0924...",
  "home.loadError": "\u0924\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0932\u094B\u0921 \u0928 \u0939\u094B\u092F",
  "home.retry": "\u092B\u0947\u0930\u093F \u0916\u093E\u0932",
  "home.emptyTitle": "\u0905\u092D\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0928\u093E",
  "home.emptyMessage": "KalaSetu \u092E\u093F \u092C\u0947\u091A\u0928 \u0936\u0941\u0930\u0942 \u0915\u0930\u0928 \u0915\u0925\u093F \u0924\u092F\u093E \u092A\u0939\u093F\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u091C\u094B\u0921\u093C\u0964",
  "home.addFirstProduct": "\u092A\u0939\u093F\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u091C\u094B\u0921\u093C",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u0921\u094D\u0930\u093E\u092B\u094D\u091F",
  "home.statusFailed": "\u092B\u0947\u0932",
  "home.detailCategory": "\u0936\u094D\u0930\u0947\u0923\u0940",
  "home.detailEdit": "\u0938\u0902\u092A\u093E\u0926\u0928",
  "home.detailDelete": "\u0939\u091F\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.detailClose": "\u092C\u0928\u094D\u0926 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.editPriceLabel": "\u092E\u0942\u0932\u094D\u092F",
  "home.editDescriptionLabel": "\u0935\u093F\u0935\u0930\u0923",
  "home.editSave": "\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928\u0939\u0930\u0942 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.editCancel": "\u0930\u0926\u094D\u0926 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.editPriceInvalid": "0 \u092D\u0928\u094D\u0926\u093E \u092C\u0922\u0940 \u092E\u0942\u0932\u094D\u092F \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.editDescriptionRequired": "\u0915\u0941\u0928\u0948 \u092A\u0928\u093F \u092D\u093E\u0937\u093E\u092E\u093E \u0935\u093F\u0935\u0930\u0923 \u0916\u093E\u0932\u0940 \u0939\u0941\u0928 \u0938\u0915\u094D\u0926\u0948\u0928",
  "home.editError": "\u0924\u092A\u093E\u0908\u0902\u092F\u093E\u0917\u0941 \u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u0938\u0947\u0935 \u0928\u0916\u0947, \u0915\u0943\u092A\u092F\u093E \u092B\u0947\u0930\u093F \u092A\u094D\u0930\u092F\u093E\u0938 \u092F\u093E\u0928\u0941\u0924",
  "home.deleteConfirm": "\u0925\u094D\u0935 \u092A\u094D\u0930\u094B\u0921\u0915\u094D\u091F \u0939\u091F\u093E\u0909\u0924? \u0925\u094D\u0935 \u092B\u0947\u0930\u093F \u0935\u093E\u092A\u0938 \u0928\u0916\u0947\u0964",
  "home.deleteConfirmYes": "\u0939\u092E\u094D, \u0939\u091F\u093E\u0909",
  "home.deleteError": "\u0925\u094D\u0935 \u092A\u094D\u0930\u094B\u0921\u0915\u094D\u091F \u0939\u091F\u093E\u0909 \u0928\u0916\u0947, \u0915\u0943\u092A\u092F\u093E \u092B\u0947\u0930\u093F \u092A\u094D\u0930\u092F\u093E\u0938 \u092F\u093E\u0928\u0941\u0924",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "profile.emailLabel": "\u0908\u092E\u0947\u0932 \u0920\u0947\u0917\u093E\u0928\u093E",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0916\u0947",
  "profile.loading": "\u0924\u092A\u093E\u0908\u0902\u092F\u093E\u0917\u0941 \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u091C\u0941\u0907\u0924...",
  "profile.loadError": "\u0924\u092A\u093E\u0908\u0902\u092F\u093E\u0917\u0941 \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u0928\u0916\u0947",
  "profile.displayNameLabel": "\u0924\u092A\u093E\u0908\u0902\u092F\u093E\u0917\u0941 \u0928\u093E\u092E",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928\u092F\u093E \u0928\u093E\u092E",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0938\u0947\u0935 \u092F\u093E\u0928\u0941\u0924",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0938\u0947\u0935 \u092D\u0947\u0932",
  "profile.saveError": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0938\u0947\u0935 \u0928\u0916\u0947, \u0915\u0943\u092A\u092F\u093E \u092B\u0947\u0930\u093F \u092A\u094D\u0930\u092F\u093E\u0938 \u092F\u093E\u0928",
  "profile.logout": "\u0932\u0949\u0917 \u0906\u0909\u091F",
  "install.message": "KalaSetu \u0924\u094D\u0935\u0930\u093F\u0924 \u092A\u0939\u0941\u0901\u091A \u0916\u093E\u0924\u093F\u0930 \u0907\u0902\u0938\u094D\u091F\u0949\u0932 \u092F\u093E\u0928",
  "install.action": "\u0907\u0902\u0938\u094D\u091F\u0949\u0932",
  "install.dismiss": "\u092C\u0902\u0926 \u092F\u093E\u0928",
  "offline.message": "\u0924\u0941\u0902 \u0911\u092B\u0932\u093E\u0907\u0928 \u091B\u0940, \u0915\u0947\u0939\u0940 \u0938\u0941\u0935\u093F\u0927\u093E \u0915\u093E\u092E \u0928\u0916\u0947",
  "welcome.languageHint": "\u092A\u0942\u0930\u093E \u0910\u092A \u092F\u0948 \u092D\u093E\u0937\u093E\u0902\u0924 \u0939\u094B\u0916\u0947\u0964",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E",
  "describe.localTab": "\u0924\u0941\u0902 \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0924\u0941\u0902 \u0906\u092A\u0941\u0928 \u092D\u093E\u0937\u093E\u0902\u0924 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0935\u093F\u0935\u0930\u0923 \u092F\u093E\u0928",
  "describe.syncing": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0939\u094B\u0924 \u0906...",
  "describe.syncFailed": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0928\u0907\u0916\u0947\u0964 \u091C\u0930 \u091C\u0930\u0941\u0930\u0940 \u0939\u094B, \u0924\u0902 \u0924\u0902\u0907\u092F\u093E\u0902 \u092C\u0926\u0932\u0964",
  "describe.syncHint": "\u092C\u0926\u0932\u093E\u0907\u092F\u093E\u0902 \u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E\u0907\u092F\u093E\u0902 \u0906\u092A\u0948\u0902 \u0928\u0948 \u0916\u094B\u092A\u093F\u091C\u0964",
  "pricing.updating": "\u0928\u0935\u0940\u0928 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924 \u092C\u0930 \u0905\u092A\u0921\u0947\u091F \u0917\u0930\u093F\u0930\u093E...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u0924\u0941\u092E\u0930 \u092A\u094D\u0930\u094B\u0921\u0915\u094D\u091F\u094D\u0938 \u092F\u094B \u092D\u093E\u0937\u093E\u092E\u093E \u0905\u092A\u0921\u0947\u091F \u091C\u0941\u0917\u093E\u0932\u093F...",
  "profile.relocalised": "{n} \u092A\u094D\u0930\u094B\u0921\u0915\u094D\u091F\u094D\u0938 \u092F\u094B \u092D\u093E\u0937\u093E\u092E\u093E \u0905\u092A\u0921\u0947\u091F \u091C\u0941\u0917\u093E\u0932\u093F\u0964",
  "profile.relocaliseFailed": "\u0915\u0941\u091B \u092A\u094D\u0930\u094B\u0921\u0915\u094D\u091F\u094D\u0938 \u0905\u092A\u0921\u0947\u091F \u0928\u091C\u0941\u0917\u093E\u0932\u093F\u0964 \u092A\u091B\u093F \u092B\u0947\u0930\u093F \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0964",
  "marketplace.navBrowse": "\u092C\u094D\u0930\u093E\u0909\u091C",
  "marketplace.navProfile": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "marketplace.browseTitle": "\u092C\u093E\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u094B\u091C...",
  "marketplace.filtersTitle": "\u092B\u093C\u093F\u0932\u094D\u091F\u0930",
  "marketplace.filtersClear": "\u0938\u092C \u0938\u093E\u092B\u093C",
  "marketplace.filterAll": "\u0938\u092C",
  "marketplace.filterMaterial": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "marketplace.filterRegion": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.filterPrice": "\u0915\u0940\u092E\u0924 \u0938\u0940\u092E\u093E (\u20B9)",
  "marketplace.filterPriceMin": "\u0928\u094D\u092F\u0942\u0928\u0924\u092E",
  "marketplace.filterPriceMax": "\u0905\u0927\u093F\u0915\u0924\u092E",
  "marketplace.sortLabel": "\u0938\u094B\u0930\u093E\u092F \u092C\u093E\u092F",
  "marketplace.sortNewest": "\u0928\u0935\u093E\u0902 \u092C\u093F\u0938\u093E",
  "marketplace.sortPriceAsc": "\u092C\u093F\u0938\u093E: \u0925\u094B\u0930\u093E\u092F \u0926\u093E \u092C\u0921\u093C\u093E\u092F",
  "marketplace.sortPriceDesc": "\u092C\u093F\u0938\u093E: \u092C\u0921\u093C\u093E\u092F \u0926\u093E \u0925\u094B\u0930\u093E\u092F",
  "marketplace.resultCount": "{n} \u092C\u093F\u0938\u093E \u092B\u0941\u091C\u0941 \u092B\u093E\u0902\u091C\u093E\u092F",
  "marketplace.loadMore": "\u0906\u0930\u094B \u092B\u093E\u0902\u091C\u093E\u092F",
  "marketplace.loadError": "\u092E\u093E\u0930\u094D\u0915\u0947\u091F\u092A\u094D\u0932\u0947\u0938 \u092B\u093E\u0902\u091C\u093E\u092F \u0928\u093E\u092F, \u092B\u093F\u0928 \u0925\u093E\u0902\u092C\u093E\u092F",
  "marketplace.emptyTitle": "\u092B\u093F\u0932\u094D\u091F\u0930 \u0925\u093E\u0902\u092C\u093E\u092F \u092C\u093F\u0938\u093E \u0928\u093E\u092F",
  "marketplace.emptyFiltered": "\u092B\u093F\u0932\u094D\u091F\u0930 \u0925\u093E\u0902\u092C\u093E\u092F \u092B\u093F\u0928 \u092C\u093F\u0938\u093E \u0938\u093E\u092F \u092C\u093F\u0938\u093E \u092B\u093E\u0902\u091C\u093E\u092F.",
  "marketplace.emptyNoProducts": "\u0915\u094B\u0908 \u092C\u093F\u0938\u093E \u092B\u0941\u091C\u0941 \u0928\u093E\u092F \u0925\u093E\u0902\u092C\u093E\u092F. \u092B\u093F\u0928 \u0925\u093E\u0902\u092C\u093E\u092F.",
  "marketplace.artisanUnnamed": "KalaSetu \u092C\u093F\u0938\u093E \u092B\u0941\u091C\u0941",
  "marketplace.backToBrowse": "\u092C\u093E\u091C\u093E\u0930 \u0928\u093E\u092F\u093E\u0935",
  "marketplace.detailNotFoundTitle": "\u0938\u093E\u092E\u093E\u0928 \u0928\u093E\u092F\u093E\u092C",
  "marketplace.detailNotFoundMessage": "\u0939\u093E\u092C\u093E \u0938\u093E\u092E\u093E\u0928 \u0939\u091F\u093E\u092F \u091C\u093E\u092C\u093E\u092F \u0906\u0930\u094B \u0905\u092C\u094B \u0928\u093E\u092F\u093E\u092C\u0964",
  "marketplace.artisanSummaryTitle": "\u0939\u0938\u094D\u0924\u0915\u0932\u093E \u092C\u093F\u0938\u093E\u092F",
  "marketplace.artisanProductCount": "{n} \u0938\u093E\u092E\u093E\u0928 KalaSetu \u0928\u093E\u092F\u093E\u092C",
  "marketplace.inquiryTitle": "\u0939\u093E\u092C\u093E \u0938\u093E\u092E\u093E\u0928 \u0928\u093E\u092F\u093E\u092C \u0925\u093E\u0902\u092C\u093E\u092F?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0939\u0938\u094D\u0924\u0915\u0932\u093E \u0928\u093E\u092F\u093E\u092C \u0925\u093E\u0902\u092C\u093E\u092F \u0925\u093E\u0902\u092C\u093E\u092F: \u092C\u093F\u0938\u093E\u092C, \u092C\u093F\u0938\u093E\u092C\u0928\u093E\u092F, \u0921\u093F\u0932\u093F\u0935\u0930\u0940 \u092C\u093F\u0938\u093E\u092C...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0938\u0902\u0926\u0947\u0936 \u092C\u0947\u091C\u093E",
  "marketplace.inquirySent": "\u0925\u093E\u0902\u092C\u093E\u092F \u092C\u0947\u091C\u093E\u0964 \u0939\u0938\u094D\u0924\u0915\u0932\u093E \u0925\u093E\u0902\u092C\u093E\u092F \u0925\u093E\u0902\u092C\u093E\u092F\u0964",
  "marketplace.inquiryError": "\u0925\u093E\u0902\u092C\u093E\u092F \u092C\u0947\u091C\u093E \u0928\u093E\u092F\u093E\u092C\u0964 \u092B\u093F\u0928 \u0925\u093E\u0902\u092C\u093E\u092F\u0964",
  "marketplace.regionLabel": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.regionUnspecified": "\u0928\u093E\u092F \u0926\u093F\u0939\u093E",
  "marketplace.myInquiriesTitle": "\u092E\u094B\u0930 \u0938\u094B\u0902\u0925\u093E\u092F",
  "marketplace.inquiriesLoading": "\u0906\u0901\u0907\u0928\u093F \u0938\u094B\u0902\u0925\u093E\u092F \u0932\u093E\u0926\u094B\u0902\u0917...",
  "marketplace.inquiriesLoadError": "\u0906\u0901\u0907\u0928\u093F \u0938\u094B\u0902\u0925\u093E\u092F \u0932\u093E\u0926\u094B\u0902\u0917 \u0928\u093E\u092F \u0939\u094B\u092C\u093E\u092F",
  "marketplace.noInquiries": "\u0906\u0901\u0907\u0928\u093F \u0938\u094B\u0902\u0925\u093E\u092F \u0925\u093E\u0902\u0928\u093E\u092F \u0928\u093E\u092F \u0926\u093F\u0939\u093E\u092F\u0964 \u092C\u091C\u093E\u0930\u0928\u093F \u092C\u093F\u0938\u0930\u093E\u092F \u092C\u093F\u0938\u093E\u092C\u093E\u092F\u0964",
  "marketplace.inquiryProductRemoved": "\u0939\u093E\u092C\u093E \u092C\u093F\u0938\u0930 \u0905\u092C\u093E \u0928\u093E\u092F \u0925\u093E\u0902",
  "marketplace.inquiryStatusOpen": "\u091C\u0935\u093E\u092C\u0928\u093F \u0925\u093E\u0902",
  "marketplace.inquiryStatusClosed": "\u092C\u0902\u0926",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/doi.json
var doi_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0905\u092A\u0928\u093E \u0936\u093F\u0932\u094D\u092A \u0911\u0928\u0932\u093E\u0907\u0928 \u092C\u0947\u091A\u094B, \u0938\u0939\u091C \u0924\u0930\u0940\u0915\u093E\u0964",
  "welcome.languageLabel": "\u0905\u092A\u0928\u0940 \u092D\u093E\u0937\u093E \u091A\u0941\u0928\u094B",
  "welcome.getStarted": "\u0936\u0941\u0930\u0942 \u0915\u0930\u094B",
  "language.en": "\u0905\u0902\u0917\u094D\u0930\u0947\u091C\u093C\u0940",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "\u0905\u092A\u0928\u093E \u0908\u092E\u0947\u0932 \u092A\u0924\u093E \u0926\u0930\u094D\u091C \u0915\u0930\u094B",
  "email.roleQuestion": "\u092E\u0948\u0902 \u0907\u0925\u0947",
  "email.roleSell": "\u092E\u0947\u0930\u0947 \u0938\u093E\u092E\u093E\u0928 \u092C\u0947\u091A\u094B",
  "email.roleBuy": "\u0939\u093E\u0925 \u092C\u0928\u093E\u092F\u0947 \u0938\u093E\u092E\u093E\u0928 \u0916\u0930\u0940\u0926\u094B",
  "email.label": "\u0908\u092E\u0947\u0932 \u092A\u0924\u093E",
  "email.helper": "\u0939\u092E 4 \u0905\u0902\u0915\u094B\u0902 \u0915\u093E \u0915\u094B\u0921 \u092D\u0947\u091C\u0947\u0902\u0917\u0947 \u0924\u093E\u0915\u093F \u092F\u0939 \u092A\u0941\u0937\u094D\u091F\u093F \u0939\u094B \u0938\u0915\u0947 \u0915\u093F \u092F\u0939 \u0906\u092A \u0939\u0940 \u0939\u0948\u0902\u0964",
  "email.invalid": "\u0935\u0948\u0927 \u0908\u092E\u0947\u0932 \u092A\u0924\u093E \u0926\u0930\u094D\u091C \u0915\u0930\u094B",
  "email.sendOtp": "\u0915\u094B\u0921 \u092D\u0947\u091C\u094B",
  "email.error": "\u0915\u094B\u0921 \u092D\u0947\u091C\u0928\u0947 \u092E\u0947\u0902 \u0935\u093F\u092B\u0932, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902",
  "otp.title": "\u0905\u092A\u0928\u093E \u0908\u092E\u0947\u0932 \u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u094B",
  "otp.subtitle": "\u092D\u0947\u091C\u0947 \u0917\u092F\u0947 4 \u0905\u0902\u0915\u094B\u0902 \u0935\u093E\u0932\u093E \u0915\u094B\u0921 \u0926\u0930\u094D\u091C \u0915\u0930\u094B",
  "otp.emailUndelivered": "\u0908\u092E\u0947\u0932 \u0928\u0939\u0940\u0902 \u092D\u0947\u091C \u0938\u0915\u093E\u0964 \u0921\u0947\u092E\u094B \u0915\u094B\u0921 \u0915\u0947 \u0932\u093F\u090F \u0905\u092A\u0928\u0940 \u091F\u0940\u092E \u0938\u0947 \u092A\u0942\u091B\u094B\u0964",
  "otp.changeEmail": "\u0908\u092E\u0947\u0932 \u092C\u0926\u0932\u094B",
  "otp.verify": "\u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u094B",
  "otp.invalid": "\u0938\u092D\u0940 4 \u0905\u0902\u0915 \u0926\u0930\u094D\u091C \u0915\u0930\u094B",
  "otp.wrong": "\u0917\u0932\u0924 OTP, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0938\u0947 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u094B",
  "otp.resend": "OTP \u092B\u093F\u0930 \u092D\u0947\u091C\u094B",
  "otp.resendIn": "OTP \u092B\u093F\u0930 \u092D\u0947\u091C\u094B {n}s \u092E\u0947\u0902",
  "otp.resendError": "OTP \u092B\u093F\u0930 \u0928\u0939\u0940\u0902 \u092D\u0947\u091C \u0938\u0915\u093E, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0938\u0947 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u094B",
  "camera.capture": "\u092B\u094B\u091F\u094B \u0916\u0940\u0902\u091A\u094B",
  "camera.unavailable": "\u0915\u0948\u092E\u0930\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902, \u0907\u0938\u0915\u0947 \u092C\u091C\u093E\u092F \u092B\u094B\u091F\u094B \u091A\u0941\u0928\u094B\u0964",
  "camera.choosePhoto": "\u092B\u093C\u094B\u091F\u094B \u091A\u0941\u0928\u094B",
  "camera.retake": "\u092B\u093F\u0930 \u0932\u0947\u0913",
  "camera.usePhoto": "\u0908 \u092B\u093C\u094B\u091F\u094B \u0907\u0938\u094D\u0924\u0947\u092E\u093E\u0932 \u0915\u0930\u094B",
  "camera.enhancing": "\u0906\u092A\u0915\u0940 \u092B\u093C\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0940 \u091C\u093E \u0930\u0939\u0940 \u0939\u0948...",
  "camera.enhanceError": "\u092B\u093C\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0940 \u0928\u0939\u0940\u0902 \u0938\u0915\u0940",
  "camera.retry": "\u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B",
  "camera.before": "\u092E\u0942\u0932",
  "camera.after": "\u0938\u0941\u0927\u093E\u0930\u0940",
  "camera.compareHint": "\u0938\u094D\u0932\u093E\u0907\u0921\u0930 \u0916\u0940\u0902\u091A \u0915\u0947 \u0924\u0941\u0932\u0928\u093E \u0915\u0930\u094B",
  "camera.continue": "\u091C\u093E\u0930\u0940 \u0930\u0916\u094B",
  "studio.title": "\u092B\u094B\u091F\u094B \u0928\u0942\u0901 \u0938\u0941\u0927\u093E\u0930\u094B",
  "studio.original": "\u0905\u0938\u0932\u0940",
  "studio.processed": "\u092C\u0928\u093E\u092F\u093E",
  "studio.removeBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0913",
  "studio.removingBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0908 \u091C\u093E \u0930\u0940 \u0939\u0948...",
  "studio.keepOriginalBackground": "\u0905\u0938\u0932\u0940 \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0930\u0916\u094B",
  "studio.backgroundWhite": "\u0938\u092B\u093C\u0947\u0926",
  "studio.backgroundNeutral": "\u0928\u0930\u092E \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0941\u0902\u0927\u0932\u093E",
  "studio.backgroundUnavailableNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0928\u093E \u0905\u092D\u0940 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964 \u092B\u094B\u091F\u094B \u091C\u0938\u094D\u0938\u0940 \u0930\u0939\u0948\u0917\u093E\u0964",
  "studio.backgroundTimedOutNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0928\u0947 \u092E\u0947\u0902 \u092C\u0939\u0941\u0924 \u091F\u0948\u092E \u0932\u0917 \u0917\u092F\u093E, \u0907\u0938\u0932\u093F\u092F\u0947 \u091B\u094B\u0921\u093C \u0926\u093F\u0924\u094D\u0924\u093E \u0917\u092F\u093E\u0964 \u092B\u094B\u091F\u094B \u091C\u0938\u094D\u0938\u0940 \u0930\u0939\u0948\u0917\u093E\u0964",
  "studio.backgroundQuotaNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0928\u0947 \u0926\u0940 \u0938\u0940\u092E\u093E \u0905\u092D\u0940 \u092A\u0942\u0930\u0940 \u0939\u094B \u0917\u0908\u0964 \u092B\u094B\u091F\u094B \u091C\u0938\u094D\u0938\u0940 \u0930\u0939\u0948\u0917\u093E\u0964",
  "studio.backgroundFailedNotice": "\u092C\u0948\u0915\u0917\u094D\u0930\u093E\u0909\u0902\u0921 \u0939\u091F\u093E\u0928\u0947 \u092E\u0947\u0902 \u0935\u093F\u092B\u0932\u0964 \u092B\u094B\u091F\u094B \u091C\u0938 \u0926\u0940 \u0924\u0938 \u0930\u0939 \u0917\u092F\u093E\u0964",
  "studio.brightness": "\u091A\u092E\u0915",
  "studio.contrast": "\u0915\u0902\u091F\u094D\u0930\u093E\u0938\u094D\u091F",
  "studio.sharpen": "\u0924\u0940\u0916\u093E \u0915\u0930\u094B",
  "studio.autoLighting": "\u0911\u091F\u094B \u0932\u093E\u0907\u091F\u093F\u0902\u0917",
  "studio.crop": "\u0915\u091F",
  "studio.cropOriginal": "\u092E\u0942\u0932",
  "studio.cropSquare": "\u091A\u094C\u0915\u094B\u0930",
  "studio.cropPortrait": "\u092A\u094B\u0930\u094D\u091F\u094D\u0930\u0947\u091F",
  "studio.accept": "\u0907\u0939 \u092B\u094B\u091F\u094B \u0907\u0938\u094D\u0924\u0947\u092E\u093E\u0932 \u0915\u0930\u094B",
  "studio.retake": "\u092B\u0947\u0930 \u0932\u0947\u0913",
  "studio.finalizing": "\u0924\u0947\u0939\u0921\u093C\u0947 \u092C\u0926\u0932\u093E\u0935 \u0932\u093E\u0917\u0942 \u0915\u0930 \u0930\u0939\u0947 \u0939\u0928...",
  "studio.on": "\u091A\u093E\u0932\u0942",
  "studio.off": "\u092C\u0902\u0926",
  "category.title": "\u0924\u0941\u092E\u094D\u0939\u0947 \u0915\u094D\u092F\u093E \u092C\u0947\u091A\u0923 \u0939\u0948?",
  "category.continue": "\u091C\u093E\u0930\u0940 \u0930\u0916\u094B",
  "category.materialQuestion": "\u0907\u0939 \u0915\u093F\u0921\u093C\u093E \u092C\u0928\u093F\u092F\u093E? (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "category.textiles": "\u0915\u092A\u0921\u093C\u093E",
  "category.pottery": "\u092E\u093F\u091F\u094D\u091F\u0940 \u0915\u0947 \u092C\u0930\u094D\u0924\u0928",
  "category.jewelry": "\u0917\u0939\u0928\u093E",
  "category.woodwork": "\u0932\u0915\u0921\u093C\u0940",
  "category.bambooCane": "\u092C\u093E\u0901\u0938 \u0914\u0930 \u0924\u093E\u0921\u093C",
  "category.other": "\u0905\u0928\u094D\u092F",
  "voice.tapToRecord": "\u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u093E \u0935\u093F\u0935\u0930\u0923 \u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u091F\u0948\u092A \u0915\u0930\u094B",
  "voice.recording": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u0939\u094B \u0930\u0939\u0940 \u0939\u0948...",
  "voice.stop": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u0930\u094B\u0915\u094B",
  "voice.record": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921",
  "voice.reviewRecording": "\u0938\u0941\u0928\u0947\u0902, \u092B\u093F\u0930 \u0906\u0917\u0947 \u092C\u0922\u093C\u0947\u0902 \u092F\u093E \u092A\u0941\u0928\u0903 \u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0947\u0902.",
  "voice.reRecord": "\u092A\u0941\u0928\u0903 \u0930\u093F\u0915\u0949\u0930\u094D\u0921",
  "voice.continue": "\u091C\u093E\u0930\u0940 \u0930\u0916\u094B",
  "describe.transcribing": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u093E \u0935\u093F\u0935\u0930\u0923 \u0938\u092E\u091D \u0930\u0939\u0947 \u0939\u0948\u0902...",
  "describe.transcribeError": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u093E \u0935\u093F\u0935\u0930\u0923 \u0938\u092E\u091D \u0928\u0939\u0940\u0902 \u0906\u092F\u093E",
  "describe.retry": "\u092B\u093F\u0930 \u0938\u0947 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B",
  "describe.reviewHint": "\u091C\u093E\u0902\u091A \u0915\u0930 \u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u094B",
  "describe.fallbackNote": "\u092E\u093E\u0907\u0915\u094D\u0930\u094B\u092B\u094B\u0928 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902, \u0907\u0938\u0915\u0947 \u092C\u091C\u093E\u092F \u0905\u092A\u0928\u093E \u0935\u093F\u0935\u0930\u0923 \u091F\u093E\u0907\u092A \u0915\u0930\u094B.",
  "describe.placeholderEn": "\u0905\u092A\u0928\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u0905\u0902\u0917\u094D\u0930\u0947\u091C\u093C\u0940 \u092E\u0947\u0902 \u092C\u0924\u093E\u0913",
  "describe.continue": "\u091C\u093E\u0930\u0940 \u0930\u0916\u094B",
  "pricing.title": "\u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0940 \u0915\u0940\u092E\u0924 \u0924\u092F \u0915\u0930\u094B",
  "pricing.summaryEdit": "\u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u094B",
  "pricing.materialCostLabel": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924",
  "pricing.materialCostHelper": "\u0915\u091A\u094D\u091A\u0940 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u092A\u0930 \u0916\u0930\u094D\u091A \u0915\u0940 \u0917\u0908 \u0930\u093E\u0936\u093F \u0930\u0941\u092A\u092F\u0947 \u092E\u0947\u0902 \u0926\u0930\u094D\u091C \u0915\u0930\u094B.",
  "pricing.materialCostInvalid": "0 \u0924\u094B\u0902 \u0935\u0927\u093F\u092F\u093E \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924 \u0926\u0930\u094D\u091C \u0915\u0930\u094B",
  "pricing.getSuggestion": "\u0915\u0940\u092E\u0924 \u0938\u0941\u091D\u093E\u0913",
  "pricing.suggestError": "\u0915\u0940\u092E\u0924 \u0915\u093E \u0938\u0941\u091D\u093E\u0935 \u0928\u0939\u0940\u0902 \u092E\u093F\u0932 \u0938\u0915\u093E",
  "pricing.retry": "\u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936",
  "pricing.rangeLabel": "\u0938\u0941\u091D\u093E\u0908 \u0917\u0908 \u0915\u0940\u092E\u0924 \u0938\u0940\u092E\u093E",
  "pricing.sellingPriceLabel": "\u0906\u092A\u0915\u0940 \u092C\u093F\u0915\u094D\u0930\u0940 \u0915\u0940\u092E\u0924",
  "pricing.sellingPriceNote": "\u0908 \u0938\u0941\u091D\u093E\u0935 \u0939\u0948, \u0906\u092A \u092E\u0928\u092A\u0938\u0902\u0926 \u0915\u094B\u0908 \u092D\u0940 \u0915\u0940\u092E\u0924 \u0932\u0917\u093E \u0938\u0915\u0926\u0947 \u0939\u094B",
  "pricing.sellingPriceInvalid": "0 \u0924\u094B\u0902 \u0935\u0927\u093F\u092F\u093E \u092C\u093F\u0915\u094D\u0930\u0940 \u0915\u0940\u092E\u0924 \u0926\u0930\u094D\u091C \u0915\u0930\u094B",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "pricing.publishError": "\u0906\u092A\u0915\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u093E",
  "pricing.successTitle": "\u0906\u092A\u0915\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u093E\u0907\u0935 \u0939\u0948!",
  "pricing.successMessage": "\u0916\u0930\u0940\u0926\u093E\u0930 \u0905\u092C \u0907\u0938\u0947 \u0906\u092A\u0915\u0947 \u0926\u0941\u0915\u093E\u0928 \u092E\u0947\u0902 \u0922\u0942\u0902\u0922 \u0938\u0915\u0924\u0947 \u0939\u0948\u0902",
  "pricing.viewShop": "\u092E\u0947\u0930\u0947 \u0926\u0941\u0915\u093E\u0928 \u0935\u093F\u091A \u0926\u0947\u0916\u094B",
  "home.title": "\u092E\u094D\u0939\u093E\u0930\u093E \u0926\u0941\u0915\u093E\u0928",
  "home.gemBannerTitle": "GeM / ONDC \u0928\u093E\u0932 \u091C\u0941\u0921\u093C\u094B",
  "home.gemBannerBadge": "\u091C\u0932\u094D\u0926 \u0906 \u0930\u0939\u093E \u0939\u0948",
  "home.gemBannerMessage": "\u0908 \u0907\u0902\u091F\u093F\u0917\u094D\u0930\u0947\u0936\u0928 \u091C\u0932\u094D\u0926 \u0906 \u0930\u0939\u093E \u0939\u0948\u0964",
  "home.loading": "\u0906\u092A\u0915\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u094B\u0921 \u0939\u094B \u0930\u0939\u0947 \u0939\u0948\u0902...",
  "home.loadError": "\u0906\u092A\u0915\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0947",
  "home.retry": "\u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938",
  "home.emptyTitle": "\u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0939\u0940\u0902",
  "home.emptyMessage": "KalaSetu \u092A\u0930 \u092C\u0947\u091A\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u0905\u092A\u0928\u093E \u092A\u0939\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u094B\u0921\u093C\u094B\u0964",
  "home.addFirstProduct": "\u0905\u092A\u0928\u093E \u092A\u0939\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u094B\u0921\u093C\u094B",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u092E\u0938\u094C\u0926\u093E",
  "home.statusFailed": "\u0905\u0938\u092B\u0932",
  "home.detailCategory": "\u0936\u094D\u0930\u0947\u0923\u0940",
  "home.detailEdit": "\u0938\u0902\u092A\u093E\u0926\u093F\u0924",
  "home.detailDelete": "\u0939\u091F\u093E\u0913",
  "home.detailClose": "\u092C\u0902\u0926",
  "home.editPriceLabel": "\u0915\u0940\u092E\u0924",
  "home.editDescriptionLabel": "\u0935\u093F\u0935\u0930\u0923",
  "home.editSave": "\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u0938\u0939\u0947\u091C\u0947\u0902",
  "home.editCancel": "\u0930\u0926\u094D\u0926",
  "home.editPriceInvalid": "0 \u0938\u0947 \u0905\u0927\u093F\u0915 \u0915\u0940\u092E\u0924 \u0926\u0930\u094D\u091C \u0915\u0930\u0947\u0902",
  "home.editDescriptionRequired": "\u0915\u093F\u0938\u0940 \u092D\u0940 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0935\u093F\u0935\u0930\u0923 \u0916\u093E\u0932\u0940 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0924\u093E",
  "home.editError": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u0947 \u092C\u0926\u0932\u093E\u0935 \u0938\u0939\u0947\u091C \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0947, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B",
  "home.deleteConfirm": "\u0907\u0938 \u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0942\u0902 \u0939\u091F\u093E\u0913? \u0907\u0939 \u0935\u093E\u092A\u0938 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0947\u0964",
  "home.deleteConfirmYes": "\u0939\u093E\u0901, \u0939\u091F\u093E\u0913",
  "home.deleteError": "\u0907\u0938 \u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0942\u0902 \u0939\u091F\u093E\u092F\u093E \u0928\u0939\u0940\u0902 \u091C\u093E \u0938\u0915\u093E, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932",
  "profile.emailLabel": "\u0908\u092E\u0947\u0932 \u092A\u0924\u093E",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902",
  "profile.loading": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u093E \u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0932\u094B\u0921 \u0939\u094B \u0930\u0939\u093E \u0939\u0948...",
  "profile.loadError": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u093E \u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u093E",
  "profile.displayNameLabel": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u093E \u0928\u093E\u092E",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928 \u0915\u093E \u0928\u093E\u092E",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u092C\u091A\u093E\u0913",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u092C\u091A\u093E \u0932\u0940",
  "profile.saveError": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u0940 \u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u092C\u091A\u093E \u0928\u0939\u0940\u0902 \u0938\u0915\u0940, \u0926\u094B\u092C\u093E\u0930\u093E \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B",
  "profile.logout": "\u092C\u093E\u0939\u0930 \u0928\u093F\u0915\u0932\u094B",
  "install.message": "\u091C\u0932\u094D\u0926\u0940 \u092A\u0939\u0941\u0901\u091A \u0915\u0947 \u0932\u093F\u090F KalaSetu \u0907\u0902\u0938\u094D\u091F\u0949\u0932 \u0915\u0930\u094B",
  "install.action": "\u0907\u0902\u0938\u094D\u091F\u0949\u0932",
  "install.dismiss": "\u0930\u0926\u094D\u0926 \u0915\u0930\u094B",
  "offline.message": "\u0924\u0941\u092E \u0911\u092B\u093C\u0932\u093E\u0907\u0928 \u0939\u094B, \u0915\u0941\u091B \u092B\u093C\u0940\u091A\u0930\u094D\u0938 \u0915\u093E\u092E \u0928\u0939\u0940\u0902 \u0915\u0930 \u0938\u0915\u0924\u0947",
  "welcome.languageHint": "\u092A\u0942\u0930\u093E \u0910\u092A \u0907\u0938 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0939\u094B\u0935\u0947\u0917\u093E",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E\u090F\u0901",
  "describe.localTab": "\u0924\u0941\u092E\u094D\u0939\u093E\u0930\u0940 \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0905\u092A\u0928\u0940 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u093E \u0935\u0930\u094D\u0923\u0928 \u0915\u0930\u094B",
  "describe.syncing": "\u0926\u0942\u0938\u0930\u0940 \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0939\u094B \u0930\u0939\u0940 \u0939\u0948...",
  "describe.syncFailed": "\u0926\u0942\u0938\u0930\u0940 \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0940\u0964 \u091C\u093C\u0930\u0942\u0930\u0924 \u0939\u094B \u0924\u094B \u0916\u0941\u0926 \u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u094B\u0964",
  "describe.syncHint": "\u0938\u0902\u092A\u093E\u0926\u0928 \u0938\u094D\u0935\u0924\u0903 \u0939\u0940 \u0926\u0942\u0938\u0930\u0940 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0915\u0949\u092A\u0940 \u0939\u094B \u091C\u093E\u0902\u0917\u0947\u0964",
  "pricing.updating": "\u0928\u0935\u093E\u0902 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924 \u0935\u093E\u0938\u094D\u0924\u0947 \u0905\u092A\u0921\u0947\u091F \u0939\u094B \u0930\u092F\u093E \u0939\u0948...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u0906\u092A\u0923\u0947\u0902 \u0909\u0924\u094D\u092A\u093E\u0926 \u0907\u0938 \u092D\u093E\u0937\u093E \u0935\u093F\u091A \u0905\u092A\u0921\u0947\u091F \u0939\u094B \u0930\u0939\u0947 \u0939\u0948\u0902...",
  "profile.relocalised": "\u0907\u0938 \u092D\u093E\u0937\u093E \u0935\u093F\u091A {n} \u0909\u0924\u094D\u092A\u093E\u0926 \u0905\u092A\u0921\u0947\u091F \u0939\u094B \u0917\u090F\u0964",
  "profile.relocaliseFailed": "\u0915\u0941\u091B \u0909\u0924\u094D\u092A\u093E\u0926 \u0905\u092A\u0921\u0947\u091F \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0947\u0964 \u092C\u093E\u0926 \u092E\u0947\u0902 \u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B\u0964",
  "marketplace.navBrowse": "\u0926\u0947\u0916\u094B",
  "marketplace.navProfile": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932",
  "marketplace.browseTitle": "\u092C\u093E\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u094B\u091C\u094B...",
  "marketplace.filtersTitle": "\u092B\u093C\u093F\u0932\u094D\u091F\u0930",
  "marketplace.filtersClear": "\u0938\u092C \u0938\u093E\u092B\u093C \u0915\u0930\u094B",
  "marketplace.filterAll": "\u0938\u092D\u0940",
  "marketplace.filterMaterial": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "marketplace.filterRegion": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.filterPrice": "\u0915\u0940\u092E\u0924 \u0938\u0940\u092E\u093E (\u20B9)",
  "marketplace.filterPriceMin": "\u0928\u094D\u092F\u0942\u0928\u0924\u092E",
  "marketplace.filterPriceMax": "\u0905\u0927\u093F\u0915\u0924\u092E",
  "marketplace.sortLabel": "\u0915\u094D\u0930\u092E \u0905\u0928\u0941\u0938\u093E\u0930",
  "marketplace.sortNewest": "\u0928\u0935\u0940\u0928\u0924\u092E \u092A\u0939\u0932\u0947",
  "marketplace.sortPriceAsc": "\u0915\u0940\u092E\u0924: \u0915\u092E \u0924\u094B \u0935\u0927",
  "marketplace.sortPriceDesc": "\u0915\u0940\u092E\u0924: \u0935\u0927 \u0924\u094B \u0915\u092E",
  "marketplace.resultCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926 \u092E\u093F\u0932\u0947",
  "marketplace.loadMore": "\u0939\u094B\u0930 \u0932\u094B\u0921 \u0915\u0930\u094B",
  "marketplace.loadError": "\u092C\u093E\u091C\u093E\u0930 \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B\u092F\u093E, \u092B\u0947\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B",
  "marketplace.emptyTitle": "\u0907\u0928\u094D\u0939\u093E \u092B\u093F\u0932\u094D\u091F\u0930\u093E\u0902 \u0928\u093E\u0932 \u0915\u094B\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0939\u0940\u0902 \u092E\u093F\u0932\u0926\u093E",
  "marketplace.emptyFiltered": "\u092B\u093C\u093F\u0932\u094D\u091F\u0930 \u0939\u091F\u093E\u0913 \u092F\u093E \u0915\u0942\u091C \u0939\u094B\u0930 \u0916\u094B\u091C\u094B.",
  "marketplace.emptyNoProducts": "\u0939\u093E\u0932\u0947 \u0924\u0915 \u0915\u094B\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0928\u0939\u0940\u0902 \u0939\u094B\u092F\u093E\u0964 \u0925\u094B\u0921\u094D\u0921\u093E \u091C\u093F\u092F\u093E \u092C\u093E\u0926 \u0926\u0947\u0916\u094B\u0964",
  "marketplace.artisanUnnamed": "KalaSetu \u0915\u093E\u0930\u0940\u0917\u0930",
  "marketplace.backToBrowse": "\u092C\u093E\u091C\u093E\u0930 \u092A\u0930 \u0935\u093E\u092A\u0938",
  "marketplace.detailNotFoundTitle": "\u0938\u093E\u092E\u093E\u0928 \u0928\u0939\u0940\u0902 \u092E\u093F\u0932\u093E",
  "marketplace.detailNotFoundMessage": "\u090F\u0939 \u0938\u093E\u092E\u093E\u0928 \u0939\u091F\u093E\u092F\u093E \u0917\u092F\u093E \u0939\u094B \u0938\u0915\u0926\u093E \u0939\u0948 \u092F\u093E \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964",
  "marketplace.artisanSummaryTitle": "\u0915\u093E\u0930\u0940\u0917\u0930 \u092C\u093E\u0930\u0947",
  "marketplace.artisanProductCount": "KalaSetu \u092A\u0930 {n} \u0938\u093E\u092E\u093E\u0928 \u0932\u093F\u0938\u094D\u091F\u0947\u0921",
  "marketplace.inquiryTitle": "\u090F\u0939 \u0938\u093E\u092E\u093E\u0928 \u092E\u0947\u0902 \u0930\u0941\u091A\u093F \u0939\u0948?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0915\u093E\u0930\u0940\u0917\u0930 \u0928\u0941 \u0926\u0938\u094B \u0924\u0941\u0939\u093E\u0921\u0947 \u0915\u094B\u0932 \u0915\u0940 \u091A\u093E\u0939\u093F\u0926\u093E \u0939\u0948: \u092E\u093E\u0924\u094D\u0930\u093E, \u0915\u0938\u094D\u091F\u092E\u093E\u0907\u091C\u093C\u0947\u0936\u0928, \u0921\u093F\u0932\u093F\u0935\u0930\u0940 \u091F\u093E\u0907\u092E\u0932\u093E\u0907\u0928...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u092A\u0942\u091B\u0924\u093E\u091B \u092D\u0947\u091C\u094B",
  "marketplace.inquirySent": "\u0924\u0941\u0939\u093E\u0921\u093C\u0940 \u092A\u0942\u091B\u0924\u093E\u091B \u092D\u0947\u091C\u0940 \u0917\u0908 \u0939\u0948\u0964 \u0915\u093E\u0930\u0940\u0917\u0930 \u0938\u0902\u092A\u0930\u094D\u0915 \u0915\u0930\u0947\u0917\u093E\u0964",
  "marketplace.inquiryError": "\u092A\u0942\u091B\u0924\u093E\u091B \u0928\u0939\u0940\u0902 \u092D\u0947\u091C\u0940 \u091C\u093E \u0938\u0915\u0940, \u092B\u0947\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u094B",
  "marketplace.regionLabel": "\u0907\u0932\u093E\u0915\u093E",
  "marketplace.regionUnspecified": "\u0928\u0939\u0940\u0902 \u0926\u0938\u0940",
  "marketplace.myInquiriesTitle": "\u092E\u0947\u0930\u0940 \u092A\u0942\u091B\u0924\u093E\u091B",
  "marketplace.inquiriesLoading": "\u0924\u0941\u0939\u093E\u0921\u093C\u0940 \u092A\u0942\u091B\u0924\u093E\u091B \u0932\u094B\u0921 \u0939\u094B \u0930\u0939\u0940 \u0910...",
  "marketplace.inquiriesLoadError": "\u0924\u0941\u0939\u093E\u0921\u093C\u0940 \u092A\u0942\u091B\u0924\u093E\u091B \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0940",
  "marketplace.noInquiries": "\u0924\u0941\u0938\u094D\u0938\u0940 \u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0908 \u092A\u0942\u091B\u0924\u093E\u091B \u0928\u0939\u0940\u0902 \u092D\u0947\u091C\u0940\u0964 \u092E\u093E\u0930\u094D\u0915\u0947\u091F \u0935\u093F\u091A \u092A\u094D\u0930\u094B\u0921\u0915\u094D\u091F \u0932\u092C\u094B\u0964",
  "marketplace.inquiryProductRemoved": "\u090F \u092A\u094D\u0930\u094B\u0921\u0915\u094D\u091F \u0905\u092C \u0928\u0939\u0940\u0902 \u092E\u093F\u0932\u0926\u093E",
  "marketplace.inquiryStatusOpen": "\u091C\u0935\u093E\u092C \u0926\u093E \u0907\u0902\u0924\u091C\u093E\u0930",
  "marketplace.inquiryStatusClosed": "\u092C\u0902\u0926",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/en.json
var en_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "Sell your craft online, the easy way.",
  "welcome.languageLabel": "Choose your language",
  "welcome.getStarted": "Get Started",
  "language.en": "English",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "Enter your email address",
  "email.roleQuestion": "I'm here to",
  "email.roleSell": "Sell my products",
  "email.roleBuy": "Buy handmade products",
  "email.label": "Email address",
  "email.helper": "We will send a 4 digit code to verify it's you.",
  "email.invalid": "Enter a valid email address",
  "email.sendOtp": "Send code",
  "email.error": "Could not send the code, please try again",
  "otp.title": "Verify your email",
  "otp.subtitle": "Enter the 4 digit code sent to",
  "otp.emailUndelivered": "We could not send the email. Ask your team for the demo code.",
  "otp.changeEmail": "Change email",
  "otp.verify": "Verify",
  "otp.invalid": "Enter all 4 digits",
  "otp.wrong": "Incorrect OTP, please try again",
  "otp.resend": "Resend OTP",
  "otp.resendIn": "Resend OTP in {n}s",
  "otp.resendError": "Could not resend OTP, please try again",
  "camera.capture": "Capture photo",
  "camera.unavailable": "Camera unavailable, choose a photo instead.",
  "camera.choosePhoto": "Choose photo",
  "camera.retake": "Retake",
  "camera.usePhoto": "Use this photo",
  "camera.enhancing": "Enhancing your photo...",
  "camera.enhanceError": "Could not enhance your photo",
  "camera.retry": "Retry",
  "camera.before": "Original",
  "camera.after": "Enhanced",
  "camera.compareHint": "Drag the slider to compare",
  "camera.continue": "Continue",
  "studio.title": "Enhance your photo",
  "studio.original": "Original",
  "studio.processed": "Processed",
  "studio.removeBackground": "Remove background",
  "studio.removingBackground": "Removing background...",
  "studio.keepOriginalBackground": "Keep original background",
  "studio.backgroundWhite": "White",
  "studio.backgroundNeutral": "Soft cream",
  "studio.backgroundBlur": "Blur",
  "studio.backgroundUnavailableNotice": "Background removal is not available right now. Your photo is unchanged.",
  "studio.backgroundTimedOutNotice": "Background removal took too long and was skipped. Your photo is unchanged.",
  "studio.backgroundQuotaNotice": "Background removal quota reached for now. Your photo is unchanged.",
  "studio.backgroundFailedNotice": "Background removal failed. Your photo is unchanged.",
  "studio.brightness": "Brightness",
  "studio.contrast": "Contrast",
  "studio.sharpen": "Sharpen",
  "studio.autoLighting": "Auto lighting",
  "studio.crop": "Crop",
  "studio.cropOriginal": "Original",
  "studio.cropSquare": "Square",
  "studio.cropPortrait": "Portrait",
  "studio.accept": "Use this photo",
  "studio.retake": "Retake",
  "studio.finalizing": "Applying your edits...",
  "studio.on": "On",
  "studio.off": "Off",
  "category.title": "What are you selling?",
  "category.continue": "Continue",
  "category.materialQuestion": "What is it made of? (optional)",
  "category.textiles": "Textiles",
  "category.pottery": "Pottery",
  "category.jewelry": "Jewelry",
  "category.woodwork": "Woodwork",
  "category.bambooCane": "Bamboo & Cane",
  "category.other": "Other",
  "voice.tapToRecord": "Tap to record a description of your product",
  "voice.recording": "Recording...",
  "voice.stop": "Stop recording",
  "voice.record": "Record",
  "voice.reviewRecording": "Listen back, then continue or re-record.",
  "voice.reRecord": "Re-record",
  "voice.continue": "Continue",
  "describe.transcribing": "Understanding your description...",
  "describe.transcribeError": "Could not understand your description",
  "describe.retry": "Retry",
  "describe.reviewHint": "Review and edit if needed",
  "describe.fallbackNote": "Microphone unavailable, type your description instead.",
  "describe.placeholderEn": "Describe your product in English",
  "describe.continue": "Continue",
  "pricing.title": "Price your product",
  "pricing.summaryEdit": "Edit",
  "pricing.materialCostLabel": "Material cost",
  "pricing.materialCostHelper": "Enter what you spent on raw materials, in rupees.",
  "pricing.materialCostInvalid": "Enter a material cost greater than 0",
  "pricing.getSuggestion": "Get price suggestion",
  "pricing.suggestError": "Could not get a price suggestion",
  "pricing.retry": "Retry",
  "pricing.rangeLabel": "Suggested price range",
  "pricing.sellingPriceLabel": "Your selling price",
  "pricing.sellingPriceNote": "This is a suggestion, you can set any price you like.",
  "pricing.sellingPriceInvalid": "Enter a selling price greater than 0",
  "pricing.publish": "Publish",
  "pricing.publishError": "Could not publish your product",
  "pricing.successTitle": "Your product is live!",
  "pricing.successMessage": "Buyers can now find it in your shop.",
  "pricing.viewShop": "View in My Shop",
  "home.title": "My Shop",
  "home.gemBannerTitle": "Connect to GeM / ONDC",
  "home.gemBannerBadge": "Coming soon",
  "home.gemBannerMessage": "This integration is coming soon.",
  "home.loading": "Loading your products...",
  "home.loadError": "Could not load your products",
  "home.retry": "Retry",
  "home.emptyTitle": "No products yet",
  "home.emptyMessage": "Add your first product to start selling on KalaSetu.",
  "home.addFirstProduct": "Add your first product",
  "home.statusPublished": "Published",
  "home.statusDraft": "Draft",
  "home.statusFailed": "Failed",
  "home.detailCategory": "Category",
  "home.detailEdit": "Edit",
  "home.detailDelete": "Delete",
  "home.detailClose": "Close",
  "home.editPriceLabel": "Price",
  "home.editDescriptionLabel": "Description",
  "home.editSave": "Save changes",
  "home.editCancel": "Cancel",
  "home.editPriceInvalid": "Enter a price greater than 0",
  "home.editDescriptionRequired": "Description cannot be empty in either language",
  "home.editError": "Could not save your changes, please try again",
  "home.deleteConfirm": "Delete this product? This cannot be undone.",
  "home.deleteConfirmYes": "Yes, delete",
  "home.deleteError": "Could not delete this product, please try again",
  "profile.title": "Profile",
  "profile.emailLabel": "Email address",
  "profile.emailUnknown": "Not available",
  "profile.loading": "Loading your profile...",
  "profile.loadError": "Could not load your profile",
  "profile.displayNameLabel": "Your name",
  "profile.shopNameLabel": "Shop name",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "Save profile",
  "profile.saved": "Profile saved",
  "profile.saveError": "Could not save your profile, please try again",
  "profile.logout": "Log out",
  "install.message": "Install KalaSetu for quick access",
  "install.action": "Install",
  "install.dismiss": "Dismiss",
  "offline.message": "You're offline, some features may not work",
  "welcome.languageHint": "The whole app will be in this language.",
  "welcome.regionalLanguages": "Indian languages",
  "describe.localTab": "Your language",
  "describe.placeholderLocal": "Describe your product in your own language",
  "describe.syncing": "Updating the other language...",
  "describe.syncFailed": "Could not update the other language. Edit it yourself if needed.",
  "describe.syncHint": "Edits are copied to the other language automatically.",
  "pricing.updating": "Updating for the new material cost...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "Updating your products to this language...",
  "profile.relocalised": "Updated {n} products to this language.",
  "profile.relocaliseFailed": "Could not update some products. Try again later.",
  "marketplace.navBrowse": "Browse",
  "marketplace.navProfile": "Profile",
  "marketplace.browseTitle": "Marketplace",
  "marketplace.searchPlaceholder": "Search products...",
  "marketplace.filtersTitle": "Filters",
  "marketplace.filtersClear": "Clear all",
  "marketplace.filterAll": "All",
  "marketplace.filterMaterial": "Material",
  "marketplace.filterRegion": "Region",
  "marketplace.filterPrice": "Price range (\u20B9)",
  "marketplace.filterPriceMin": "Min",
  "marketplace.filterPriceMax": "Max",
  "marketplace.sortLabel": "Sort by",
  "marketplace.sortNewest": "Newest first",
  "marketplace.sortPriceAsc": "Price: low to high",
  "marketplace.sortPriceDesc": "Price: high to low",
  "marketplace.resultCount": "{n} products found",
  "marketplace.loadMore": "Load more",
  "marketplace.loadError": "Could not load the marketplace, please try again",
  "marketplace.emptyTitle": "No products match these filters",
  "marketplace.emptyFiltered": "Try clearing a filter or searching for something else.",
  "marketplace.emptyNoProducts": "No products have been published yet. Check back soon.",
  "marketplace.artisanUnnamed": "KalaSetu artisan",
  "marketplace.backToBrowse": "Back to marketplace",
  "marketplace.detailNotFoundTitle": "Product not found",
  "marketplace.detailNotFoundMessage": "This product may have been removed or is no longer available.",
  "marketplace.artisanSummaryTitle": "About the artisan",
  "marketplace.artisanProductCount": "{n} products listed on KalaSetu",
  "marketplace.inquiryTitle": "Interested in this product?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "Tell the artisan what you're looking for: customisation, delivery timeline...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "Send inquiry",
  "marketplace.inquirySent": "Your inquiry has been sent. The artisan will be in touch.",
  "marketplace.inquiryError": "Could not send your inquiry, please try again",
  "marketplace.regionLabel": "Region",
  "marketplace.regionUnspecified": "Not specified",
  "marketplace.myInquiriesTitle": "My inquiries",
  "marketplace.inquiriesLoading": "Loading your inquiries...",
  "marketplace.inquiriesLoadError": "Could not load your inquiries",
  "marketplace.noInquiries": "You haven't sent any inquiries yet. Browse the marketplace to find products.",
  "marketplace.inquiryProductRemoved": "This product is no longer available",
  "marketplace.inquiryStatusOpen": "Awaiting reply",
  "marketplace.inquiryStatusClosed": "Closed",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/gu.json
var gu_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0AB9\u0AB8\u0ACD\u0AA4\u0A95\u0AB2\u0ABE \u0A93\u0AA8\u0AB2\u0ABE\u0A87\u0AA8 \u0AB5\u0AC7\u0A9A\u0ACB, \u0AB8\u0AB0\u0AB3 \u0AB0\u0AC0\u0AA4\u0AC7.",
  "welcome.languageLabel": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAD\u0ABE\u0AB7\u0ABE \u0AAA\u0AB8\u0A82\u0AA6 \u0A95\u0AB0\u0ACB",
  "welcome.getStarted": "\u0AB6\u0AB0\u0AC1 \u0A95\u0AB0\u0ACB",
  "language.en": "\u0A85\u0A82\u0A97\u0ACD\u0AB0\u0AC7\u0A9C\u0AC0",
  "language.hi": "\u0AB9\u0ABF\u0AA8\u0ACD\u0AA6\u0AC0",
  "email.title": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0A87\u0AAE\u0AC7\u0AB2 \u0AB8\u0AB0\u0AA8\u0ABE\u0AAE\u0AC1\u0A82 \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB",
  "email.roleQuestion": "\u0AB9\u0AC1\u0A82 \u0A85\u0AB9\u0AC0\u0A82 \u0A9B\u0AC1\u0A82",
  "email.roleSell": "\u0AAE\u0ABE\u0AB0\u0ABE \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0AB5\u0AC7\u0A9A\u0ACB",
  "email.roleBuy": "\u0AB9\u0AB8\u0ACD\u0AA4\u0A95\u0AB2\u0ABE \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0A96\u0AB0\u0AC0\u0AA6\u0ACB",
  "email.label": "\u0A87\u0AAE\u0AC7\u0AB2 \u0AB8\u0AB0\u0AA8\u0ABE\u0AAE\u0AC1\u0A82",
  "email.helper": "\u0A85\u0AAE\u0AC7 4 \u0A85\u0A82\u0A95\u0AA8\u0ACB \u0A95\u0ACB\u0AA1 \u0AAE\u0ACB\u0A95\u0AB2\u0AC0\u0AB6\u0AC1\u0A82, \u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0A93\u0AB3\u0A96 \u0AAE\u0ABE\u0A9F\u0AC7.",
  "email.invalid": "\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0A87\u0AAE\u0AC7\u0AB2 \u0AB8\u0AB0\u0AA8\u0ABE\u0AAE\u0AC1\u0A82 \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB",
  "email.sendOtp": "\u0A95\u0ACB\u0AA1 \u0AAE\u0ACB\u0A95\u0AB2\u0ACB",
  "email.error": "\u0A95\u0ACB\u0AA1 \u0AAE\u0ACB\u0A95\u0AB2\u0AB5\u0ABE\u0AAE\u0ABE\u0A82 \u0A85\u0AB8\u0AAE\u0AB0\u0ACD\u0AA5, \u0A95\u0AC3\u0AAA\u0ABE \u0A95\u0AB0\u0AC0\u0AA8\u0AC7 \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "otp.title": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0A87\u0AAE\u0AC7\u0AB2 \u0A9A\u0A95\u0ABE\u0AB8\u0ACB",
  "otp.subtitle": "\u0AAE\u0ACB\u0A95\u0AB2\u0AC7\u0AB2 4 \u0A85\u0A82\u0A95\u0AA8\u0ACB \u0A95\u0ACB\u0AA1 \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB",
  "otp.emailUndelivered": "\u0A85\u0AAE\u0AC7 \u0A87\u0AAE\u0AC7\u0AB2 \u0AAE\u0ACB\u0A95\u0AB2\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0. \u0AA1\u0AC7\u0AAE\u0ACB \u0A95\u0ACB\u0AA1 \u0AAE\u0ABE\u0A9F\u0AC7 \u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0A9F\u0AC0\u0AAE\u0AA8\u0AC7 \u0AAA\u0AC2\u0A9B\u0ACB.",
  "otp.changeEmail": "\u0A87\u0AAE\u0AC7\u0AB2 \u0AAC\u0AA6\u0AB2\u0ACB",
  "otp.verify": "\u0A9A\u0A95\u0ABE\u0AB8\u0ACB",
  "otp.invalid": "\u0AAC\u0AA7\u0ABE 4 \u0A85\u0A82\u0A95 \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB",
  "otp.wrong": "\u0A96\u0ACB\u0A9F\u0ACB OTP, \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "otp.resend": "OTP \u0AAB\u0AB0\u0AC0 \u0AAE\u0ACB\u0A95\u0AB2\u0ACB",
  "otp.resendIn": "OTP {n}s \u0AAE\u0ABE\u0A82 \u0AAB\u0AB0\u0AC0 \u0AAE\u0ACB\u0A95\u0AB2\u0ACB",
  "otp.resendError": "OTP \u0AAB\u0AB0\u0AC0 \u0AAE\u0ACB\u0A95\u0AB2\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0, \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "camera.capture": "\u0AAB\u0ACB\u0A9F\u0ACB \u0AB2\u0ACB",
  "camera.unavailable": "\u0A95\u0AC7\u0AAE\u0AC7\u0AB0\u0ABE \u0A89\u0AAA\u0AB2\u0AAC\u0ACD\u0AA7 \u0AA8\u0AA5\u0AC0, \u0AAC\u0AA6\u0AB2\u0AC7 \u0AAB\u0ACB\u0A9F\u0ACB \u0AAA\u0AB8\u0A82\u0AA6 \u0A95\u0AB0\u0ACB.",
  "camera.choosePhoto": "\u0AAB\u0ACB\u0A9F\u0ACB \u0AAA\u0AB8\u0A82\u0AA6 \u0A95\u0AB0\u0ACB",
  "camera.retake": "\u0AAB\u0AB0\u0AC0\u0AA5\u0AC0 \u0AB2\u0ACB",
  "camera.usePhoto": "\u0A86 \u0AAB\u0ACB\u0A9F\u0ACB \u0A89\u0AAA\u0AAF\u0ACB\u0A97 \u0A95\u0AB0\u0ACB",
  "camera.enhancing": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0AAB\u0ACB\u0A9F\u0ACB \u0AB8\u0AC1\u0AA7\u0ABE\u0AB0\u0AC0 \u0AB0\u0AB9\u0ACD\u0AAF\u0ABE \u0A9B\u0AC0\u0A8F...",
  "camera.enhanceError": "\u0AAB\u0ACB\u0A9F\u0ACB \u0AB8\u0AC1\u0AA7\u0ABE\u0AB0\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0",
  "camera.retry": "\u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "camera.before": "\u0AAE\u0AC2\u0AB3",
  "camera.after": "\u0AB8\u0AC1\u0AA7\u0ABE\u0AB0\u0AC7\u0AB2",
  "camera.compareHint": "\u0AA4\u0AC1\u0AB2\u0AA8 \u0AAE\u0ABE\u0A9F\u0AC7 \u0AB8\u0ACD\u0AB2\u0ABE\u0A87\u0AA1\u0AB0 \u0A96\u0AC7\u0A82\u0A9A\u0ACB",
  "camera.continue": "\u0A86\u0A97\u0AB3 \u0AB5\u0AA7\u0ACB",
  "studio.title": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAB\u0ACB\u0A9F\u0ACB \u0AB8\u0AC1\u0AA7\u0ABE\u0AB0\u0ACB",
  "studio.original": "\u0AAE\u0AC2\u0AB3",
  "studio.processed": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AB8\u0AC7\u0AB8\u0ACD\u0AA1",
  "studio.removeBackground": "\u0AAA\u0AC3\u0AB7\u0ACD\u0AA0\u0AAD\u0AC2\u0AAE\u0ABF \u0AA6\u0AC2\u0AB0 \u0A95\u0AB0\u0ACB",
  "studio.removingBackground": "\u0AAA\u0AC3\u0AB7\u0ACD\u0AA0\u0AAD\u0AC2\u0AAE\u0ABF \u0AA6\u0AC2\u0AB0 \u0A95\u0AB0\u0AC0 \u0AB0\u0AB9\u0ACD\u0AAF\u0ABE \u0A9B\u0AC0\u0A8F...",
  "studio.keepOriginalBackground": "\u0AAE\u0AC2\u0AB3 \u0AAA\u0AC3\u0AB7\u0ACD\u0AA0\u0AAD\u0AC2\u0AAE\u0ABF \u0AB0\u0ABE\u0A96\u0ACB",
  "studio.backgroundWhite": "\u0AB8\u0AAB\u0AC7\u0AA6",
  "studio.backgroundNeutral": "\u0AAE\u0AC3\u0AA6\u0AC1 \u0A95\u0ACD\u0AB0\u0AC0\u0AAE",
  "studio.backgroundBlur": "\u0AAE\u0A82\u0A9D\u0AB2",
  "studio.backgroundUnavailableNotice": "\u0AAA\u0AC3\u0AB7\u0ACD\u0AA0\u0AAD\u0AC2\u0AAE\u0ABF \u0AA6\u0AC2\u0AB0 \u0A95\u0AB0\u0AB5\u0AC1\u0A82 \u0AB9\u0ABE\u0AB2\u0AAE\u0ABE\u0A82 \u0A89\u0AAA\u0AB2\u0AAC\u0ACD\u0AA7 \u0AA8\u0AA5\u0AC0. \u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAB\u0ACB\u0A9F\u0ACB \u0AAC\u0AA6\u0AB2\u0ABE\u0A88 \u0AA8\u0AA5\u0AC0.",
  "studio.backgroundTimedOutNotice": "\u0AAA\u0AC3\u0AB7\u0ACD\u0AA0\u0AAD\u0AC2\u0AAE\u0ABF \u0AA6\u0AC2\u0AB0 \u0A95\u0AB0\u0AB5\u0ABE\u0AAE\u0ABE\u0A82 \u0AB5\u0AA7\u0AC1 \u0AB8\u0AAE\u0AAF \u0AB2\u0ABE\u0A97\u0ACD\u0AAF\u0ACB \u0A85\u0AA8\u0AC7 \u0AA4\u0AC7\u0AA8\u0AC7 \u0A9B\u0ACB\u0AA1\u0AB5\u0ABE\u0AAE\u0ABE\u0A82 \u0A86\u0AB5\u0ACD\u0AAF\u0AC1\u0A82. \u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAB\u0ACB\u0A9F\u0ACB \u0AAC\u0AA6\u0AB2\u0ABE\u0A88 \u0AA8\u0AA5\u0AC0.",
  "studio.backgroundQuotaNotice": "\u0AAA\u0AC3\u0AB7\u0ACD\u0AA0\u0AAD\u0AC2\u0AAE\u0ABF \u0AA6\u0AC2\u0AB0 \u0A95\u0AB0\u0AB5\u0ABE\u0AA8\u0AC0 \u0A95\u0ACD\u0AB5\u0ACB\u0A9F\u0ABE \u0AB9\u0ABE\u0AB2 \u0AAA\u0AC2\u0AB0\u0ABE\u0A88 \u0A97\u0A88 \u0A9B\u0AC7. \u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAB\u0ACB\u0A9F\u0ACB \u0AAC\u0AA6\u0AB2\u0ABE\u0A88 \u0AA8\u0AA5\u0AC0.",
  "studio.backgroundFailedNotice": "\u0AAA\u0AC3\u0AB7\u0ACD\u0AA0\u0AAD\u0AC2\u0AAE\u0ABF \u0AA6\u0AC2\u0AB0 \u0A95\u0AB0\u0AB5\u0AC1\u0A82 \u0AA8\u0ABF\u0AB7\u0ACD\u0AAB\u0AB3 \u0AA5\u0AAF\u0AC1\u0A82. \u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAB\u0ACB\u0A9F\u0ACB \u0AAC\u0AA6\u0AB2\u0ABE\u0A88 \u0AA8\u0AA5\u0AC0.",
  "studio.brightness": "\u0AAA\u0ACD\u0AB0\u0A95\u0ABE\u0AB6\u0AA4\u0ABE",
  "studio.contrast": "\u0AB5\u0ABF\u0AB0\u0ACB\u0AA7\u0ABE\u0AAD\u0ABE\u0AB8",
  "studio.sharpen": "\u0AA4\u0AC0\u0A95\u0ACD\u0AB7\u0ACD\u0AA3\u0AA4\u0ABE",
  "studio.autoLighting": "\u0AB8\u0ACD\u0AB5\u0A9A\u0ABE\u0AB2\u0ABF\u0AA4 \u0AAA\u0ACD\u0AB0\u0A95\u0ABE\u0AB6",
  "studio.crop": "\u0A95\u0ACD\u0AB0\u0ACB\u0AAA",
  "studio.cropOriginal": "\u0AAE\u0AC2\u0AB3",
  "studio.cropSquare": "\u0A9A\u0ACB\u0AB0\u0AB8",
  "studio.cropPortrait": "\u0AAA\u0ACB\u0AB0\u0ACD\u0A9F\u0ACD\u0AB0\u0AC7\u0A9F",
  "studio.accept": "\u0A86 \u0AAB\u0ACB\u0A9F\u0ACB \u0A89\u0AAA\u0AAF\u0ACB\u0A97 \u0A95\u0AB0\u0ACB",
  "studio.retake": "\u0AAB\u0AB0\u0AC0 \u0AB2\u0ACB",
  "studio.finalizing": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ABE \u0AAB\u0AC7\u0AB0\u0AAB\u0ABE\u0AB0\u0ACB \u0AB2\u0ABE\u0A97\u0AC1 \u0A95\u0AB0\u0AC0 \u0AB0\u0AB9\u0ACD\u0AAF\u0ABE \u0A9B\u0AC0\u0A8F...",
  "studio.on": "\u0A9A\u0ABE\u0AB2\u0AC1",
  "studio.off": "\u0AAC\u0A82\u0AA7",
  "category.title": "\u0AA4\u0AAE\u0AC7 \u0AB6\u0AC1\u0A82 \u0AB5\u0AC7\u0A9A\u0ACB \u0A9B\u0ACB?",
  "category.continue": "\u0A86\u0A97\u0AB3 \u0AB5\u0AA7\u0ACB",
  "category.materialQuestion": "\u0AA4\u0AC7 \u0A95\u0AAF\u0ABE \u0AB8\u0ABE\u0AAE\u0A97\u0ACD\u0AB0\u0AC0\u0AA8\u0AC1\u0A82 \u0A9B\u0AC7? (\u0AB5\u0AC8\u0A95\u0AB2\u0ACD\u0AAA\u0ABF\u0A95)",
  "category.textiles": "\u0AB5\u0AB8\u0ACD\u0AA4\u0ACD\u0AB0\u0ACB",
  "category.pottery": "\u0AAE\u0ABE\u0A9F\u0AC0\u0AA8\u0AC1\u0A82 \u0A95\u0ABE\u0AAE",
  "category.jewelry": "\u0A98\u0AB0\u0AC7\u0AA3\u0ABE\u0A82",
  "category.woodwork": "\u0AB2\u0ABE\u0A95\u0AA1\u0ABE\u0AA8\u0AC1\u0A82 \u0A95\u0ABE\u0AAE",
  "category.bambooCane": "\u0AAC\u0ABE\u0A82\u0AAC\u0AC1 \u0A85\u0AA8\u0AC7 \u0A95\u0ABE\u0A82\u0AA0\u0ACB",
  "category.other": "\u0A85\u0AA8\u0ACD\u0AAF",
  "voice.tapToRecord": "\u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0AA8\u0AC1\u0A82 \u0AB5\u0AB0\u0ACD\u0AA3\u0AA8 \u0AB0\u0AC7\u0A95\u0ACB\u0AB0\u0ACD\u0AA1 \u0A95\u0AB0\u0AB5\u0ABE \u0AAE\u0ABE\u0A9F\u0AC7 \u0A9F\u0AC5\u0AAA \u0A95\u0AB0\u0ACB",
  "voice.recording": "\u0AB0\u0AC7\u0A95\u0ACB\u0AB0\u0ACD\u0AA1\u0ABF\u0A82\u0A97...",
  "voice.stop": "\u0AB0\u0AC7\u0A95\u0ACB\u0AB0\u0ACD\u0AA1\u0ABF\u0A82\u0A97 \u0AAC\u0A82\u0AA7 \u0A95\u0AB0\u0ACB",
  "voice.record": "\u0AB0\u0AC7\u0A95\u0ACB\u0AB0\u0ACD\u0AA1",
  "voice.reviewRecording": "\u0AAA\u0ABE\u0A9B\u0ACB \u0AB8\u0ABE\u0A82\u0AAD\u0AB3\u0ACB, \u0AAA\u0A9B\u0AC0 \u0A9A\u0ABE\u0AB2\u0AC1 \u0AB0\u0ABE\u0A96\u0ACB \u0A85\u0AA5\u0AB5\u0ABE \u0AAB\u0AB0\u0AC0 \u0AB0\u0AC7\u0A95\u0ACB\u0AB0\u0ACD\u0AA1 \u0A95\u0AB0\u0ACB.",
  "voice.reRecord": "\u0AAB\u0AB0\u0AC0 \u0AB0\u0AC7\u0A95\u0ACB\u0AB0\u0ACD\u0AA1",
  "voice.continue": "\u0A9A\u0ABE\u0AB2\u0AC1 \u0AB0\u0ABE\u0A96\u0ACB",
  "describe.transcribing": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AB5\u0AB0\u0ACD\u0AA3\u0AA8 \u0AB8\u0AAE\u0A9C\u0ABE\u0A88 \u0AB0\u0AB9\u0ACD\u0AAF\u0AC1\u0A82 \u0A9B\u0AC7...",
  "describe.transcribeError": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AB5\u0AB0\u0ACD\u0AA3\u0AA8 \u0AB8\u0AAE\u0A9C\u0ABE\u0A88 \u0AB6\u0A95\u0AC0 \u0AA8\u0AA5\u0AC0",
  "describe.retry": "\u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "describe.reviewHint": "\u0A9C\u0AB0\u0AC2\u0AB0\u0AC0 \u0AB9\u0ACB\u0AAF \u0AA4\u0ACB \u0AB8\u0AAE\u0AC0\u0A95\u0ACD\u0AB7\u0ABE \u0A85\u0AA8\u0AC7 \u0AB8\u0A82\u0AAA\u0ABE\u0AA6\u0AA8 \u0A95\u0AB0\u0ACB",
  "describe.fallbackNote": "\u0AAE\u0ABE\u0A87\u0A95\u0ACD\u0AB0\u0ACB\u0AAB\u0ACB\u0AA8 \u0A89\u0AAA\u0AB2\u0AAC\u0ACD\u0AA7 \u0AA8\u0AA5\u0AC0, \u0AA4\u0AC7\u0AA8\u0ABE \u0AAC\u0AA6\u0AB2\u0AC7 \u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0AB5\u0AB0\u0ACD\u0AA3\u0AA8 \u0A9F\u0ABE\u0A87\u0AAA \u0A95\u0AB0\u0ACB.",
  "describe.placeholderEn": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ABE \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0AA8\u0AC1\u0A82 \u0A85\u0A82\u0A97\u0ACD\u0AB0\u0AC7\u0A9C\u0AC0\u0AAE\u0ABE\u0A82 \u0AB5\u0AB0\u0ACD\u0AA3\u0AA8 \u0A95\u0AB0\u0ACB",
  "describe.continue": "\u0A9A\u0ABE\u0AB2\u0AC1 \u0AB0\u0ABE\u0A96\u0ACB",
  "pricing.title": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ABE \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0AA8\u0AC0 \u0A95\u0ABF\u0A82\u0AAE\u0AA4 \u0AA8\u0A95\u0ACD\u0A95\u0AC0 \u0A95\u0AB0\u0ACB",
  "pricing.summaryEdit": "\u0AB8\u0A82\u0AAA\u0ABE\u0AA6\u0ABF\u0AA4 \u0A95\u0AB0\u0ACB",
  "pricing.materialCostLabel": "\u0AB8\u0ABE\u0AAE\u0A97\u0ACD\u0AB0\u0AC0 \u0A96\u0AB0\u0ACD\u0A9A",
  "pricing.materialCostHelper": "\u0AB0\u0AC2\u0AAA\u0AC0\u0AAE\u0ABE\u0A82 \u0A95\u0ABE\u0A9A\u0ABE \u0AAE\u0ABE\u0AB2\u0AA8\u0ACB \u0A96\u0AB0\u0ACD\u0A9A \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB.",
  "pricing.materialCostInvalid": "\u0AB6\u0AC2\u0AA8\u0ACD\u0AAF \u0A95\u0AB0\u0AA4\u0ABE\u0A82 \u0AB5\u0AA7\u0AC1 \u0AB8\u0ABE\u0AAE\u0A97\u0ACD\u0AB0\u0AC0 \u0A96\u0AB0\u0ACD\u0A9A \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB.",
  "pricing.getSuggestion": "\u0AAE\u0AC2\u0AB2\u0ACD\u0AAF \u0AB8\u0AC2\u0A9A\u0AA8 \u0AAE\u0AC7\u0AB3\u0AB5\u0ACB",
  "pricing.suggestError": "\u0AAE\u0AC2\u0AB2\u0ACD\u0AAF \u0AB8\u0AC2\u0A9A\u0AA8 \u0AAE\u0AC7\u0AB3\u0AB5\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0",
  "pricing.retry": "\u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "pricing.rangeLabel": "\u0AB8\u0AC2\u0A9A\u0ABF\u0AA4 \u0A95\u0ABF\u0A82\u0AAE\u0AA4 \u0AB6\u0ACD\u0AB0\u0AC7\u0AA3\u0AC0",
  "pricing.sellingPriceLabel": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AB5\u0AC7\u0A9A\u0ABE\u0AA3 \u0A95\u0ABF\u0A82\u0AAE\u0AA4",
  "pricing.sellingPriceNote": "\u0A86 \u0AAE\u0ABE\u0AA4\u0ACD\u0AB0 \u0AB8\u0AC2\u0A9A\u0AA8 \u0A9B\u0AC7, \u0AA4\u0AAE\u0AC7 \u0A87\u0A9A\u0ACD\u0A9B\u0ACB \u0AA4\u0AC7\u0AB5\u0AC0 \u0A95\u0ABF\u0A82\u0AAE\u0AA4 \u0AA8\u0A95\u0ACD\u0A95\u0AC0 \u0A95\u0AB0\u0AC0 \u0AB6\u0A95\u0ACB \u0A9B\u0ACB",
  "pricing.sellingPriceInvalid": "\u0AB6\u0AC2\u0AA8\u0ACD\u0AAF \u0A95\u0AB0\u0AA4\u0ABE\u0A82 \u0AB5\u0AA7\u0AC1 \u0AB5\u0AC7\u0A9A\u0ABE\u0AA3 \u0A95\u0ABF\u0A82\u0AAE\u0AA4 \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB",
  "pricing.publish": "\u0AAA\u0ACD\u0AB0\u0A95\u0ABE\u0AB6\u0ABF\u0AA4 \u0A95\u0AB0\u0ACB",
  "pricing.publishError": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F \u0AAA\u0ACD\u0AB0\u0A95\u0ABE\u0AB6\u0ABF\u0AA4 \u0A95\u0AB0\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0",
  "pricing.successTitle": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F \u0AB9\u0AB5\u0AC7 \u0AB2\u0ABE\u0A87\u0AB5 \u0A9B\u0AC7!",
  "pricing.successMessage": "\u0A96\u0AB0\u0AC0\u0AA6\u0AA6\u0ABE\u0AB0\u0ACB \u0AB9\u0AB5\u0AC7 \u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AA6\u0AC1\u0A95\u0ABE\u0AA8\u0AAE\u0ABE\u0A82 \u0AA4\u0AC7\u0AA8\u0AC7 \u0AB6\u0ACB\u0AA7\u0AC0 \u0AB6\u0A95\u0AB6\u0AC7.",
  "pricing.viewShop": "\u0AAE\u0ABE\u0AB0\u0AC0 \u0AA6\u0AC1\u0A95\u0ABE\u0AA8\u0AAE\u0ABE\u0A82 \u0A9C\u0AC1\u0A93",
  "home.title": "\u0AAE\u0ABE\u0AB0\u0AC0 \u0AA6\u0AC1\u0A95\u0ABE\u0AA8",
  "home.gemBannerTitle": "GeM / ONDC \u0AB8\u0ABE\u0AA5\u0AC7 \u0A9C\u0ACB\u0AA1\u0ABE\u0A93",
  "home.gemBannerBadge": "\u0AB6\u0AC0\u0A98\u0ACD\u0AB0 \u0A9C \u0A86\u0AB5\u0AB6\u0AC7",
  "home.gemBannerMessage": "\u0A86 \u0A87\u0AA8\u0ACD\u0A9F\u0AC7\u0A97\u0ACD\u0AB0\u0AC7\u0AB6\u0AA8 \u0AB6\u0AC0\u0A98\u0ACD\u0AB0 \u0A9C \u0A86\u0AB5\u0AB6\u0AC7.",
  "home.loading": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ABE \u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F\u0ACD\u0AB8 \u0AB2\u0ACB\u0AA1 \u0AA5\u0A88 \u0AB0\u0AB9\u0ACD\u0AAF\u0ABE \u0A9B\u0AC7...",
  "home.loadError": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F\u0ACD\u0AB8 \u0AB2\u0ACB\u0AA1 \u0A95\u0AB0\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0",
  "home.retry": "\u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "home.emptyTitle": "\u0AB9\u0A9C\u0AC1 \u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F\u0ACD\u0AB8 \u0AA8\u0AA5\u0AC0",
  "home.emptyMessage": "KalaSetu \u0AAA\u0AB0 \u0AB5\u0AC7\u0A9A\u0ABE\u0AA3 \u0AB6\u0AB0\u0AC2 \u0A95\u0AB0\u0AB5\u0ABE \u0AAE\u0ABE\u0A9F\u0AC7 \u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0AAA\u0ACD\u0AB0\u0AA5\u0AAE \u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F \u0A89\u0AAE\u0AC7\u0AB0\u0ACB.",
  "home.addFirstProduct": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ACB \u0AAA\u0ACD\u0AB0\u0AA5\u0AAE \u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F \u0A89\u0AAE\u0AC7\u0AB0\u0ACB",
  "home.statusPublished": "\u0AAA\u0ACD\u0AB0\u0A95\u0ABE\u0AB6\u0ABF\u0AA4",
  "home.statusDraft": "\u0AA1\u0ACD\u0AB0\u0ABE\u0AAB\u0ACD\u0A9F",
  "home.statusFailed": "\u0A85\u0AB8\u0AAB\u0AB3",
  "home.detailCategory": "\u0AB5\u0AB0\u0ACD\u0A97",
  "home.detailEdit": "\u0AB8\u0A82\u0AAA\u0ABE\u0AA6\u0AA8",
  "home.detailDelete": "\u0AAE\u0ABF\u0A9F\u0ABE\u0AB5\u0ACB",
  "home.detailClose": "\u0AAC\u0A82\u0AA7 \u0A95\u0AB0\u0ACB",
  "home.editPriceLabel": "\u0A95\u0ABF\u0A82\u0AAE\u0AA4",
  "home.editDescriptionLabel": "\u0AB5\u0AB0\u0ACD\u0AA3\u0AA8",
  "home.editSave": "\u0AAC\u0AA6\u0AB2\u0ABE\u0AB5 \u0AB8\u0ABE\u0A9A\u0AB5\u0ACB",
  "home.editCancel": "\u0AB0\u0AA6 \u0A95\u0AB0\u0ACB",
  "home.editPriceInvalid": "0 \u0A95\u0AB0\u0AA4\u0ABE \u0AB5\u0AA7\u0AC1 \u0A95\u0ABF\u0A82\u0AAE\u0AA4 \u0AA6\u0ABE\u0A96\u0AB2 \u0A95\u0AB0\u0ACB",
  "home.editDescriptionRequired": "\u0AAC\u0A82\u0AA8\u0AC7 \u0AAD\u0ABE\u0AB7\u0ABE\u0AAE\u0ABE\u0A82 \u0AB5\u0AB0\u0ACD\u0AA3\u0AA8 \u0A96\u0ABE\u0AB2\u0AC0 \u0AA8 \u0AB9\u0ACB\u0A88 \u0AB6\u0A95\u0AC7",
  "home.editError": "\u0AAB\u0AC7\u0AB0\u0AAB\u0ABE\u0AB0\u0ACB \u0AB8\u0ABE\u0A9A\u0AB5\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AB9\u0AC0\u0A82, \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "home.deleteConfirm": "\u0A86 \u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F \u0A95\u0ABE\u0AA2\u0AC0 \u0AA8\u0ABE\u0A96\u0ACB? \u0A86 \u0A95\u0ACD\u0AB0\u0ABF\u0AAF\u0ABE\u0AA8\u0AC7 \u0AAA\u0ABE\u0A9B\u0AC1\u0A82 \u0AAB\u0AC7\u0AB0\u0AB5\u0AC0 \u0AB6\u0A95\u0ABE\u0AB6\u0AC7 \u0AA8\u0AB9\u0AC0\u0A82.",
  "home.deleteConfirmYes": "\u0AB9\u0ABE, \u0A95\u0ABE\u0AA2\u0AC0 \u0AA8\u0ABE\u0A96\u0ACB",
  "home.deleteError": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AA1\u0A95\u0ACD\u0A9F \u0A95\u0ABE\u0AA2\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AB9\u0AC0\u0A82, \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "profile.title": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AAB\u0ABE\u0A87\u0AB2",
  "profile.emailLabel": "\u0A87\u0AAE\u0AC7\u0AB2 \u0AB8\u0AB0\u0AA8\u0ABE\u0AAE\u0AC1\u0A82",
  "profile.emailUnknown": "\u0A89\u0AAA\u0AB2\u0AAC\u0ACD\u0AA7 \u0AA8\u0AA5\u0AC0",
  "profile.loading": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0ACB\u0AAB\u0ABE\u0A87\u0AB2 \u0AB2\u0ACB\u0AA1 \u0AA5\u0A88 \u0AB0\u0AB9\u0AC0 \u0A9B\u0AC7...",
  "profile.loadError": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AAB\u0ABE\u0A87\u0AB2 \u0AB2\u0ACB\u0AA1 \u0A95\u0AB0\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AB9\u0AC0\u0A82",
  "profile.displayNameLabel": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC1\u0A82 \u0AA8\u0ABE\u0AAE",
  "profile.shopNameLabel": "\u0AA6\u0AC1\u0A95\u0ABE\u0AA8\u0AA8\u0AC1\u0A82 \u0AA8\u0ABE\u0AAE",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AAB\u0ABE\u0A87\u0AB2 \u0AB8\u0ABE\u0A9A\u0AB5\u0ACB",
  "profile.saved": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AAB\u0ABE\u0A87\u0AB2 \u0AB8\u0ABE\u0A9A\u0AB5\u0ABE\u0A88 \u0A97\u0A88",
  "profile.saveError": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AAB\u0ABE\u0A87\u0AB2 \u0AB8\u0ABE\u0A9A\u0AB5\u0AC0 \u0AB6\u0A95\u0ABE\u0A88 \u0AA8\u0AB9\u0AC0\u0A82, \u0A95\u0AC3\u0AAA\u0ABE \u0A95\u0AB0\u0AC0\u0AA8\u0AC7 \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "profile.logout": "\u0AB2\u0ACB\u0A97 \u0A86\u0A89\u0A9F",
  "install.message": "\u0A9D\u0AA1\u0AAA\u0AC0 \u0A8D\u0A95\u0ACD\u0AB8\u0AC7\u0AB8 \u0AAE\u0ABE\u0A9F\u0AC7 KalaSetu \u0A87\u0AA8\u0ACD\u0AB8\u0ACD\u0A9F\u0ACB\u0AB2 \u0A95\u0AB0\u0ACB",
  "install.action": "\u0A87\u0AA8\u0ACD\u0AB8\u0ACD\u0A9F\u0ACB\u0AB2",
  "install.dismiss": "\u0AAC\u0A82\u0AA7 \u0A95\u0AB0\u0ACB",
  "offline.message": "\u0AA4\u0AAE\u0AC7 \u0A91\u0AAB\u0AB2\u0ABE\u0A87\u0AA8 \u0A9B\u0ACB, \u0A95\u0AC7\u0A9F\u0AB2\u0AC0\u0A95 \u0AB8\u0AC1\u0AB5\u0ABF\u0AA7\u0ABE\u0A93 \u0A95\u0ABE\u0AAE \u0AA8\u0AB9\u0AC0\u0A82 \u0A95\u0AB0\u0AC7",
  "welcome.languageHint": "\u0AB8\u0A82\u0AAA\u0AC2\u0AB0\u0ACD\u0AA3 \u0A8F\u0AAA\u0ACD\u0AB2\u0ABF\u0A95\u0AC7\u0AB6\u0AA8 \u0A86 \u0AAD\u0ABE\u0AB7\u0ABE\u0AAE\u0ABE\u0A82 \u0AB9\u0AB6\u0AC7.",
  "welcome.regionalLanguages": "\u0AAD\u0ABE\u0AB0\u0AA4\u0AC0\u0AAF \u0AAD\u0ABE\u0AB7\u0ABE\u0A93",
  "describe.localTab": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAD\u0ABE\u0AB7\u0ABE",
  "describe.placeholderLocal": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ABE \u0AAA\u0ACB\u0AA4\u0ABE\u0AA8\u0ABE \u0AAD\u0ABE\u0AB7\u0ABE\u0AAE\u0ABE\u0A82 \u0AA4\u0AAE\u0ABE\u0AB0\u0ABE \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0AA8\u0AC1\u0A82 \u0AB5\u0AB0\u0ACD\u0AA3\u0AA8 \u0A95\u0AB0\u0ACB",
  "describe.syncing": "\u0AAC\u0AC0\u0A9C\u0AC0 \u0AAD\u0ABE\u0AB7\u0ABE \u0A85\u0AAA\u0AA1\u0AC7\u0A9F \u0AA5\u0A88 \u0AB0\u0AB9\u0AC0 \u0A9B\u0AC7...",
  "describe.syncFailed": "\u0AAC\u0AC0\u0A9C\u0AC0 \u0AAD\u0ABE\u0AB7\u0ABE \u0A85\u0AAA\u0AA1\u0AC7\u0A9F \u0A95\u0AB0\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0. \u0A9C\u0AB0\u0AC2\u0AB0 \u0AB9\u0ACB\u0AAF \u0AA4\u0ACB \u0A9C\u0ABE\u0AA4\u0AC7 \u0AB8\u0A82\u0AAA\u0ABE\u0AA6\u0ABF\u0AA4 \u0A95\u0AB0\u0ACB.",
  "describe.syncHint": "\u0AB8\u0A82\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0A86\u0AAA\u0AAE\u0AC7\u0AB3\u0AC7 \u0AAC\u0AC0\u0A9C\u0AC0 \u0AAD\u0ABE\u0AB7\u0ABE\u0AAE\u0ABE\u0A82 \u0AA8\u0A95\u0AB2 \u0AA5\u0ABE\u0AAF \u0A9B\u0AC7.",
  "pricing.updating": "\u0AA8\u0AB5\u0AC0 \u0AB8\u0ABE\u0AAE\u0A97\u0ACD\u0AB0\u0AC0 \u0A96\u0AB0\u0ACD\u0A9A \u0AAE\u0ABE\u0A9F\u0AC7 \u0A85\u0AAA\u0AA1\u0AC7\u0A9F \u0AA5\u0A88 \u0AB0\u0AB9\u0ACD\u0AAF\u0AC1\u0A82 \u0A9B\u0AC7...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0A95\u0AC7\u0A9F\u0AB2\u0ACB\u0A97 \u0AA8\u0ABF\u0A95\u0ABE\u0AB8 (ONDC \u0AAB\u0ACB\u0AB0\u0ACD\u0AAE\u0AC7\u0A9F)",
  "home.exportCatalogNote": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0A95\u0ABE\u0AB6\u0ABF\u0AA4 \u0AAF\u0ABE\u0AA6\u0AC0\u0A93\u0AA8\u0AC7 ONDC \u0AB0\u0ABF\u0A9F\u0AC7\u0AB2 \u0A95\u0AC7\u0A9F\u0AB2\u0ACB\u0A97 \u0AAE\u0ABE\u0AB3\u0A96\u0ABE\u0AAE\u0ABE\u0A82 \u0AA8\u0A95\u0AB6\u0ABE \u0A95\u0AB0\u0AC0\u0AA8\u0AC7 \u0AA1\u0ABE\u0A89\u0AA8\u0AB2\u0ACB\u0AA1 \u0A95\u0AB0\u0AC7 \u0A9B\u0AC7. \u0A87\u0AA8\u0ACD\u0A9F\u0ABF\u0A97\u0ACD\u0AB0\u0AC7\u0AB6\u0AA8-\u0AA4\u0AC8\u0AAF\u0ABE\u0AB0: \u0AA8\u0A95\u0AB6\u0ABE \u0AAA\u0AC2\u0AB0\u0ACD\u0AA3 \u0A9B\u0AC7, \u0AA8\u0AC7\u0A9F\u0AB5\u0AB0\u0ACD\u0A95\u0AAE\u0ABE\u0A82 \u0AB2\u0ABE\u0A87\u0AB5 \u0AA5\u0AB5\u0ABE \u0AAE\u0ABE\u0A9F\u0AC7 ONDC \u0AA8\u0ACB\u0A82\u0AA7\u0AA3\u0AC0 \u0A9C\u0AB0\u0AC2\u0AB0\u0AC0 \u0A9B\u0AC7.",
  "home.exportOndcSingle": "\u0A86 \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8 \u0AA8\u0ABF\u0A95\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB (ONDC \u0AAB\u0ACB\u0AB0\u0ACD\u0AAE\u0AC7\u0A9F)",
  "profile.relocalising": "\u0AA4\u0AAE\u0ABE\u0AB0\u0ABE \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0A86 \u0AAD\u0ABE\u0AB7\u0ABE\u0AAE\u0ABE\u0A82 \u0A85\u0AAA\u0AA1\u0AC7\u0A9F \u0AA5\u0A88 \u0AB0\u0AB9\u0ACD\u0AAF\u0ABE \u0A9B\u0AC7...",
  "profile.relocalised": "\u0A86 \u0AAD\u0ABE\u0AB7\u0ABE\u0AAE\u0ABE\u0A82 {n} \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0A85\u0AAA\u0AA1\u0AC7\u0A9F \u0AA5\u0AAF\u0ABE.",
  "profile.relocaliseFailed": "\u0A95\u0AC7\u0A9F\u0AB2\u0ABE\u0A95 \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0A85\u0AAA\u0AA1\u0AC7\u0A9F \u0A95\u0AB0\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0. \u0AAA\u0A9B\u0AC0 \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB.",
  "marketplace.navBrowse": "\u0AAC\u0ACD\u0AB0\u0ABE\u0A89\u0A9D",
  "marketplace.navProfile": "\u0AAA\u0ACD\u0AB0\u0ACB\u0AAB\u0ABE\u0A87\u0AB2",
  "marketplace.browseTitle": "\u0AAE\u0ABE\u0AB0\u0ACD\u0A95\u0AC7\u0A9F\u0AAA\u0ACD\u0AB2\u0AC7\u0AB8",
  "marketplace.searchPlaceholder": "\u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0AB6\u0ACB\u0AA7\u0ACB...",
  "marketplace.filtersTitle": "\u0AAB\u0ABF\u0AB2\u0ACD\u0A9F\u0AB0\u0ACD\u0AB8",
  "marketplace.filtersClear": "\u0AAC\u0AA7\u0ABE \u0AB8\u0ABE\u0AAB \u0A95\u0AB0\u0ACB",
  "marketplace.filterAll": "\u0AAC\u0AA7\u0ABE",
  "marketplace.filterMaterial": "\u0AB8\u0ABE\u0AAE\u0A97\u0ACD\u0AB0\u0AC0",
  "marketplace.filterRegion": "\u0AAA\u0ACD\u0AB0\u0AA6\u0AC7\u0AB6",
  "marketplace.filterPrice": "\u0A95\u0ABF\u0A82\u0AAE\u0AA4 \u0AB6\u0ACD\u0AB0\u0AC7\u0AA3\u0AC0 (\u20B9)",
  "marketplace.filterPriceMin": "\u0AA8\u0ACD\u0AAF\u0AC2\u0AA8\u0AA4\u0AAE",
  "marketplace.filterPriceMax": "\u0AAE\u0AB9\u0AA4\u0ACD\u0AA4\u0AAE",
  "marketplace.sortLabel": "\u0A95\u0ACD\u0AB0\u0AAE \u0AAE\u0AC1\u0A9C\u0AAC",
  "marketplace.sortNewest": "\u0AA8\u0AB5\u0AC1\u0A82 \u0AAA\u0ACD\u0AB0\u0AA5\u0AAE",
  "marketplace.sortPriceAsc": "\u0A95\u0ABF\u0A82\u0AAE\u0AA4\u0ACB: \u0AA8\u0AC0\u0A9A\u0AC7\u0AA5\u0AC0 \u0A8A\u0A82\u0A9A\u0AC0",
  "marketplace.sortPriceDesc": "\u0A95\u0ABF\u0A82\u0AAE\u0AA4\u0ACB: \u0A8A\u0A82\u0A9A\u0AC7\u0AA5\u0AC0 \u0AA8\u0AC0\u0A9A\u0AC0",
  "marketplace.resultCount": "{n} \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0AAE\u0AB3\u0ACD\u0AAF\u0ABE",
  "marketplace.loadMore": "\u0AB5\u0AA7\u0AC1 \u0AB2\u0ACB\u0AA1 \u0A95\u0AB0\u0ACB",
  "marketplace.loadError": "\u0AAE\u0ABE\u0AB0\u0ACD\u0A95\u0AC7\u0A9F\u0AAA\u0ACD\u0AB2\u0AC7\u0AB8 \u0AB2\u0ACB\u0AA1 \u0AA5\u0A88 \u0AB6\u0A95\u0ACD\u0AAF\u0ACB \u0AA8\u0AA5\u0AC0, \u0A95\u0AC3\u0AAA\u0ABE \u0A95\u0AB0\u0AC0\u0AA8\u0AC7 \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "marketplace.emptyTitle": "\u0A86 \u0AAB\u0ABF\u0AB2\u0ACD\u0A9F\u0AB0\u0ACD\u0AB8 \u0AB8\u0ABE\u0AA5\u0AC7 \u0A95\u0ACB\u0A88 \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8 \u0AAE\u0AC7\u0AB3 \u0A96\u0ABE\u0AA4\u0ABE \u0AA8\u0AA5\u0AC0",
  "marketplace.emptyFiltered": "\u0AAB\u0ABF\u0AB2\u0ACD\u0A9F\u0AB0 \u0AB8\u0ABE\u0AAB \u0A95\u0AB0\u0ACB \u0A85\u0AA5\u0AB5\u0ABE \u0A85\u0AA8\u0ACD\u0AAF \u0A95\u0A82\u0A88 \u0AB6\u0ACB\u0AA7\u0ACB.",
  "marketplace.emptyNoProducts": "\u0AB9\u0A9C\u0AC1 \u0AB8\u0AC1\u0AA7\u0AC0 \u0A95\u0ACB\u0A88 \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8 \u0AAA\u0ACD\u0AB0\u0A95\u0ABE\u0AB6\u0ABF\u0AA4 \u0AA8\u0AA5\u0AC0. \u0A9C\u0AB2\u0ACD\u0AA6\u0AC0 \u0AA4\u0AAA\u0ABE\u0AB8\u0ACB.",
  "marketplace.artisanUnnamed": "KalaSetu \u0A95\u0ABE\u0AB0\u0AC0\u0A97\u0AB0",
  "marketplace.backToBrowse": "\u0AAE\u0ABE\u0AB0\u0ACD\u0A95\u0AC7\u0A9F\u0AAA\u0ACD\u0AB2\u0AC7\u0AB8\u0AAE\u0ABE\u0A82 \u0AAA\u0ABE\u0A9B\u0ABE",
  "marketplace.detailNotFoundTitle": "\u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8 \u0AAE\u0AB3\u0ACD\u0AAF\u0AC1\u0A82 \u0AA8\u0AA5\u0AC0",
  "marketplace.detailNotFoundMessage": "\u0A86 \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8 \u0AA6\u0AC2\u0AB0 \u0A95\u0AB0\u0AB5\u0ABE\u0AAE\u0ABE\u0A82 \u0A86\u0AB5\u0ACD\u0AAF\u0AC1\u0A82 \u0AB9\u0ACB\u0A88 \u0AB6\u0A95\u0AC7 \u0A9B\u0AC7 \u0A85\u0AA5\u0AB5\u0ABE \u0AB9\u0AB5\u0AC7 \u0A89\u0AAA\u0AB2\u0AAC\u0ACD\u0AA7 \u0AA8\u0AA5\u0AC0.",
  "marketplace.artisanSummaryTitle": "\u0A95\u0ABE\u0AB0\u0ABF\u0A97\u0AB0 \u0AB5\u0ABF\u0AB6\u0AC7",
  "marketplace.artisanProductCount": "{n} \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0A95\u0ABE\u0AB2\u0ABE\u0AB8\u0AC7\u0AA4\u0AC1 \u0AAA\u0AB0 \u0AB8\u0AC2\u0A9A\u0ABF\u0AAC\u0AA6\u0ACD\u0AA7",
  "marketplace.inquiryTitle": "\u0A86 \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0AAE\u0ABE\u0A82 \u0AB0\u0AB8 \u0A9B\u0AC7?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0A95\u0ABE\u0AB0\u0ABF\u0A97\u0AB0\u0AA8\u0AC7 \u0A9C\u0AA3\u0ABE\u0AB5\u0ACB \u0A95\u0AC7 \u0AA4\u0AAE\u0AC7 \u0AB6\u0AC1\u0A82 \u0AB6\u0ACB\u0AA7\u0AC0 \u0AB0\u0AB9\u0ACD\u0AAF\u0ABE \u0A9B\u0ACB: \u0AAE\u0ABE\u0AA4\u0ACD\u0AB0\u0ABE, \u0A95\u0AB8\u0ACD\u0A9F\u0AAE\u0ABE\u0A87\u0A9D\u0AC7\u0AB6\u0AA8, \u0AA1\u0ABF\u0AB2\u0ABF\u0AB5\u0AB0\u0AC0 \u0AB8\u0AAE\u0AAF\u0AB8\u0AC0\u0AAE\u0ABE...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0AB5\u0ABF\u0AA8\u0A82\u0AA4\u0AC0 \u0AAE\u0ACB\u0A95\u0AB2\u0ACB",
  "marketplace.inquirySent": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AB5\u0ABF\u0AA8\u0A82\u0AA4\u0AC0 \u0AAE\u0ACB\u0A95\u0AB2\u0ABE\u0A88 \u0A97\u0A88 \u0A9B\u0AC7. \u0A95\u0ABE\u0AB0\u0ABF\u0A97\u0AB0 \u0AB8\u0A82\u0AAA\u0AB0\u0ACD\u0A95 \u0A95\u0AB0\u0AB6\u0AC7.",
  "marketplace.inquiryError": "\u0AB5\u0ABF\u0AA8\u0A82\u0AA4\u0AC0 \u0AAE\u0ACB\u0A95\u0AB2\u0AC0 \u0AB6\u0A95\u0ABE\u0A88 \u0AA8\u0AB9\u0AC0\u0A82, \u0A95\u0AC3\u0AAA\u0ABE \u0A95\u0AB0\u0AC0\u0AA8\u0AC7 \u0AAB\u0AB0\u0AC0 \u0AAA\u0ACD\u0AB0\u0AAF\u0ABE\u0AB8 \u0A95\u0AB0\u0ACB",
  "marketplace.regionLabel": "\u0AAA\u0ACD\u0AB0\u0AA6\u0AC7\u0AB6",
  "marketplace.regionUnspecified": "\u0AA8\u0ABF\u0AB0\u0ACD\u0AA6\u0ABF\u0AB7\u0ACD\u0A9F \u0AA8\u0AA5\u0AC0",
  "marketplace.myInquiriesTitle": "\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAA\u0AC2\u0A9B\u0AAA\u0AB0\u0A9B\u0ACB",
  "marketplace.inquiriesLoading": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAA\u0AC2\u0A9B\u0AAA\u0AB0\u0A9B\u0ACB \u0AB2\u0ACB\u0AA1 \u0AA5\u0A88 \u0AB0\u0AB9\u0AC0 \u0A9B\u0AC7...",
  "marketplace.inquiriesLoadError": "\u0AA4\u0AAE\u0ABE\u0AB0\u0AC0 \u0AAA\u0AC2\u0A9B\u0AAA\u0AB0\u0A9B\u0ACB \u0AB2\u0ACB\u0AA1 \u0A95\u0AB0\u0AC0 \u0AB6\u0A95\u0ACD\u0AAF\u0ABE \u0AA8\u0AA5\u0AC0",
  "marketplace.noInquiries": "\u0AA4\u0AAE\u0AC7 \u0AB9\u0A9C\u0AC0 \u0AB8\u0AC1\u0AA7\u0AC0 \u0A95\u0ACB\u0A88 \u0AAA\u0AC2\u0A9B\u0AAA\u0AB0\u0A9B \u0AAE\u0ACB\u0A95\u0AB2\u0AC0 \u0AA8\u0AA5\u0AC0. \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8\u0ACB \u0AB6\u0ACB\u0AA7\u0AB5\u0ABE \u0AAE\u0ABE\u0A9F\u0AC7 \u0AAE\u0ABE\u0AB0\u0ACD\u0A95\u0AC7\u0A9F\u0AAA\u0ACD\u0AB2\u0AC7\u0AB8 \u0AAC\u0ACD\u0AB0\u0ABE\u0A89\u0A9D \u0A95\u0AB0\u0ACB.",
  "marketplace.inquiryProductRemoved": "\u0A86 \u0A89\u0AA4\u0ACD\u0AAA\u0ABE\u0AA6\u0AA8 \u0AB9\u0AB5\u0AC7 \u0A89\u0AAA\u0AB2\u0AAC\u0ACD\u0AA7 \u0AA8\u0AA5\u0AC0",
  "marketplace.inquiryStatusOpen": "\u0A9C\u0AB5\u0ABE\u0AAC\u0AA8\u0AC0 \u0AB0\u0ABE\u0AB9\u0AAE\u0ABE\u0A82",
  "marketplace.inquiryStatusClosed": "\u0AAC\u0A82\u0AA7",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/hi.json
var hi_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0905\u092A\u0928\u0940 \u0915\u0932\u093E \u0915\u094B \u0906\u0938\u093E\u0928\u0940 \u0938\u0947 \u0911\u0928\u0932\u093E\u0907\u0928 \u092C\u0947\u091A\u0947\u0902\u0964",
  "welcome.languageLabel": "\u0905\u092A\u0928\u0940 \u092D\u093E\u0937\u093E \u091A\u0941\u0928\u0947\u0902",
  "welcome.getStarted": "\u0936\u0941\u0930\u0942 \u0915\u0930\u0947\u0902",
  "language.en": "English",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "\u0905\u092A\u0928\u093E \u0908\u092E\u0947\u0932 \u092A\u0924\u093E \u0921\u093E\u0932\u0947\u0902",
  "email.roleQuestion": "\u092E\u0948\u0902 \u092F\u0939\u093E\u0901 \u0939\u0942\u0901",
  "email.roleSell": "\u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u092C\u0947\u091A\u0947\u0902",
  "email.roleBuy": "\u0939\u0938\u094D\u0924\u0936\u093F\u0932\u094D\u092A \u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u0930\u0940\u0926\u0947\u0902",
  "email.label": "\u0908\u092E\u0947\u0932 \u092A\u0924\u093E",
  "email.helper": "\u092A\u0939\u091A\u093E\u0928 \u0915\u0947 \u0932\u093F\u090F \u0939\u092E 4 \u0905\u0902\u0915\u094B\u0902 \u0915\u093E \u0915\u094B\u0921 \u092D\u0947\u091C\u0947\u0902\u0917\u0947\u0964",
  "email.invalid": "\u090F\u0915 \u092E\u093E\u0928\u094D\u092F \u0908\u092E\u0947\u0932 \u092A\u0924\u093E \u0921\u093E\u0932\u0947\u0902",
  "email.sendOtp": "\u0915\u094B\u0921 \u092D\u0947\u091C\u0947\u0902",
  "email.error": "\u0915\u094B\u0921 \u092D\u0947\u091C\u0928\u0947 \u092E\u0947\u0902 \u0935\u093F\u092B\u0932, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0938\u0947 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902",
  "otp.title": "\u0905\u092A\u0928\u093E \u0908\u092E\u0947\u0932 \u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u0947\u0902",
  "otp.subtitle": "\u0907\u0938 \u0908\u092E\u0947\u0932 \u092A\u0930 \u092D\u0947\u091C\u093E \u0917\u092F\u093E 4 \u0905\u0902\u0915\u094B\u0902 \u0915\u093E \u0915\u094B\u0921 \u0921\u093E\u0932\u0947\u0902",
  "otp.emailUndelivered": "\u0908\u092E\u0947\u0932 \u0928\u0939\u0940\u0902 \u092D\u0947\u091C\u093E \u091C\u093E \u0938\u0915\u093E\u0964 \u0905\u092A\u0928\u0940 \u091F\u0940\u092E \u0938\u0947 \u0921\u0947\u092E\u094B \u0915\u094B\u0921 \u092A\u0942\u091B\u0947\u0902\u0964",
  "otp.changeEmail": "\u0908\u092E\u0947\u0932 \u092C\u0926\u0932\u0947\u0902",
  "otp.verify": "\u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u0947\u0902",
  "otp.invalid": "\u0938\u092D\u0940 4 \u0905\u0902\u0915 \u0921\u093E\u0932\u0947\u0902",
  "otp.wrong": "\u0917\u0932\u0924 OTP, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0938\u0947 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902",
  "otp.resend": "OTP \u092B\u093F\u0930 \u0938\u0947 \u092D\u0947\u091C\u0947\u0902",
  "otp.resendIn": "{n} \u0938\u0947\u0915\u0902\u0921 \u092E\u0947\u0902 \u092B\u093F\u0930 \u0938\u0947 \u092D\u0947\u091C\u0947\u0902",
  "otp.resendError": "OTP \u092B\u093F\u0930 \u0938\u0947 \u092D\u0947\u091C\u0928\u0947 \u092E\u0947\u0902 \u0935\u093F\u092B\u0932, \u0915\u0943\u092A\u092F\u093E \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902",
  "camera.capture": "\u092B\u093C\u094B\u091F\u094B \u0932\u0947\u0902",
  "camera.unavailable": "\u0915\u0948\u092E\u0930\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948, \u0907\u0938\u0915\u0947 \u092C\u091C\u093E\u092F \u090F\u0915 \u092B\u093C\u094B\u091F\u094B \u091A\u0941\u0928\u0947\u0902\u0964",
  "camera.choosePhoto": "\u092B\u093C\u094B\u091F\u094B \u091A\u0941\u0928\u0947\u0902",
  "camera.retake": "\u092B\u093F\u0930 \u0938\u0947 \u0932\u0947\u0902",
  "camera.usePhoto": "\u092F\u0939 \u092B\u093C\u094B\u091F\u094B \u0907\u0938\u094D\u0924\u0947\u092E\u093E\u0932 \u0915\u0930\u0947\u0902",
  "camera.enhancing": "\u0906\u092A\u0915\u0940 \u092B\u093C\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0940 \u091C\u093E \u0930\u0939\u0940 \u0939\u0948...",
  "camera.enhanceError": "\u092B\u093C\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0928\u0947 \u092E\u0947\u0902 \u0935\u093F\u092B\u0932",
  "camera.retry": "\u092B\u093F\u0930 \u0938\u0947 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902",
  "camera.before": "\u092E\u0942\u0932",
  "camera.after": "\u0938\u0941\u0927\u0930\u0940 \u0939\u0941\u0908",
  "camera.compareHint": "\u0924\u0941\u0932\u0928\u093E \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u0938\u094D\u0932\u093E\u0907\u0921\u0930 \u0916\u093F\u0938\u0915\u093E\u090F\u0902",
  "camera.continue": "\u0906\u0917\u0947 \u092C\u0922\u093C\u0947\u0902",
  "studio.title": "\u092B\u093C\u094B\u091F\u094B \u0915\u094B \u092C\u0947\u0939\u0924\u0930 \u092C\u0928\u093E\u0907\u090F",
  "studio.original": "\u092E\u0942\u0932",
  "studio.processed": "\u0938\u0902\u0938\u093E\u0927\u093F\u0924",
  "studio.removeBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u090F\u0901",
  "studio.removingBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0908 \u091C\u093E \u0930\u0939\u0940 \u0939\u0948...",
  "studio.keepOriginalBackground": "\u092E\u0942\u0932 \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0930\u0916\u0947\u0902",
  "studio.backgroundWhite": "\u0938\u092B\u093C\u0947\u0926",
  "studio.backgroundNeutral": "\u0928\u0930\u092E \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0941\u0902\u0927\u0932\u093E",
  "studio.backgroundUnavailableNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0928\u093E \u0905\u092D\u0940 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964 \u0906\u092A\u0915\u0940 \u092B\u093C\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u0939\u0947\u0917\u0940\u0964",
  "studio.backgroundTimedOutNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0928\u0947 \u092E\u0947\u0902 \u092C\u0939\u0941\u0924 \u0938\u092E\u092F \u0932\u0917 \u0917\u092F\u093E \u0914\u0930 \u0907\u0938\u0947 \u091B\u094B\u0921\u093C \u0926\u093F\u092F\u093E \u0917\u092F\u093E\u0964 \u0906\u092A\u0915\u0940 \u092B\u093C\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u0939\u0947\u0917\u0940\u0964",
  "studio.backgroundQuotaNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0928\u0947 \u0915\u0940 \u0938\u0940\u092E\u093E \u0905\u092D\u0940 \u092A\u0942\u0930\u0940 \u0939\u094B \u0917\u0908 \u0939\u0948\u0964 \u0906\u092A\u0915\u0940 \u092B\u093C\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u0939\u0947\u0917\u0940\u0964",
  "studio.backgroundFailedNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0928\u093E \u0935\u093F\u092B\u0932 \u0930\u0939\u093E\u0964 \u0906\u092A\u0915\u0940 \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0939\u0948\u0964",
  "studio.brightness": "\u091A\u092E\u0915",
  "studio.contrast": "\u0915\u0949\u0928\u094D\u091F\u094D\u0930\u093E\u0938\u094D\u091F",
  "studio.sharpen": "\u0924\u0940\u0916\u093E",
  "studio.autoLighting": "\u0911\u091F\u094B \u0932\u093E\u0907\u091F\u093F\u0902\u0917",
  "studio.crop": "\u0915\u094D\u0930\u0949\u092A",
  "studio.cropOriginal": "\u092E\u0942\u0932",
  "studio.cropSquare": "\u0935\u0930\u094D\u0917",
  "studio.cropPortrait": "\u092A\u094B\u0930\u094D\u091F\u094D\u0930\u0947\u091F",
  "studio.accept": "\u0907\u0938 \u092B\u094B\u091F\u094B \u0915\u093E \u0909\u092A\u092F\u094B\u0917 \u0915\u0930\u0947\u0902",
  "studio.retake": "\u092B\u093F\u0930 \u0938\u0947 \u0932\u0947\u0902",
  "studio.finalizing": "\u0906\u092A\u0915\u0947 \u092C\u0926\u0932\u093E\u0935 \u0932\u093E\u0917\u0942 \u0939\u094B \u0930\u0939\u0947 \u0939\u0948\u0902...",
  "studio.on": "\u0911\u0928",
  "studio.off": "\u0911\u092B\u093C",
  "category.title": "\u0906\u092A \u0915\u094D\u092F\u093E \u092C\u0947\u091A \u0930\u0939\u0947 \u0939\u0948\u0902?",
  "category.continue": "\u0906\u0917\u0947 \u092C\u0922\u093C\u0947\u0902",
  "category.materialQuestion": "\u092F\u0939 \u0915\u093F\u0938\u0938\u0947 \u092C\u0928\u093E \u0939\u0948? (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "category.textiles": "\u0935\u0938\u094D\u0924\u094D\u0930",
  "category.pottery": "\u092E\u093F\u091F\u094D\u091F\u0940 \u0915\u0947 \u092C\u0930\u094D\u0924\u0928",
  "category.jewelry": "\u0906\u092D\u0942\u0937\u0923",
  "category.woodwork": "\u0932\u0915\u0921\u093C\u0940 \u0915\u093E \u0915\u093E\u092E",
  "category.bambooCane": "\u092C\u093E\u0902\u0938 \u0914\u0930 \u092C\u0947\u0902\u0924",
  "category.other": "\u0905\u0928\u094D\u092F",
  "voice.tapToRecord": "\u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u093E \u0935\u093F\u0935\u0930\u0923 \u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u091F\u0948\u092A \u0915\u0930\u0947\u0902",
  "voice.recording": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0939\u094B \u0930\u0939\u093E \u0939\u0948...",
  "voice.stop": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u092C\u0902\u0926 \u0915\u0930\u0947\u0902",
  "voice.record": "\u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0947\u0902",
  "voice.reviewRecording": "\u0938\u0941\u0928\u0947\u0902, \u092B\u093F\u0930 \u0906\u0917\u0947 \u092C\u0922\u093C\u0947\u0902 \u092F\u093E \u092B\u093F\u0930 \u0938\u0947 \u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0947\u0902\u0964",
  "voice.reRecord": "\u092B\u093F\u0930 \u0938\u0947 \u0930\u093F\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0947\u0902",
  "voice.continue": "\u0906\u0917\u0947 \u092C\u0922\u093C\u0947\u0902",
  "describe.transcribing": "\u0906\u092A\u0915\u093E \u0935\u093F\u0935\u0930\u0923 \u0938\u092E\u091D\u093E \u091C\u093E \u0930\u0939\u093E \u0939\u0948...",
  "describe.transcribeError": "\u0935\u093F\u0935\u0930\u0923 \u0938\u092E\u091D\u0928\u0947 \u092E\u0947\u0902 \u0935\u093F\u092B\u0932",
  "describe.retry": "\u092B\u093F\u0930 \u0938\u0947 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902",
  "describe.reviewHint": "\u091C\u093C\u0930\u0942\u0930\u0924 \u0939\u094B \u0924\u094B \u091C\u093E\u0902\u091A\u0947\u0902 \u0914\u0930 \u092C\u0926\u0932\u0947\u0902",
  "describe.fallbackNote": "\u092E\u093E\u0907\u0915\u094D\u0930\u094B\u092B\u093C\u094B\u0928 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948, \u0907\u0938\u0915\u0947 \u092C\u091C\u093E\u092F \u0935\u093F\u0935\u0930\u0923 \u091F\u093E\u0907\u092A \u0915\u0930\u0947\u0902\u0964",
  "describe.placeholderEn": "Describe your product in English",
  "describe.continue": "\u0906\u0917\u0947 \u092C\u0922\u093C\u0947\u0902",
  "pricing.title": "\u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0940 \u0915\u0940\u092E\u0924 \u0924\u092F \u0915\u0930\u0947\u0902",
  "pricing.summaryEdit": "\u092C\u0926\u0932\u0947\u0902",
  "pricing.materialCostLabel": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0915\u0940 \u0932\u093E\u0917\u0924",
  "pricing.materialCostHelper": "\u0915\u091A\u094D\u091A\u0947 \u092E\u093E\u0932 \u092A\u0930 \u0916\u0930\u094D\u091A \u0915\u0940 \u0917\u0908 \u0930\u093E\u0936\u093F \u0930\u0941\u092A\u092F\u094B\u0902 \u092E\u0947\u0902 \u0921\u093E\u0932\u0947\u0902\u0964",
  "pricing.materialCostInvalid": "0 \u0938\u0947 \u0905\u0927\u093F\u0915 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924 \u0921\u093E\u0932\u0947\u0902",
  "pricing.getSuggestion": "\u0915\u0940\u092E\u0924 \u0915\u093E \u0938\u0941\u091D\u093E\u0935 \u0932\u0947\u0902",
  "pricing.suggestError": "\u0915\u0940\u092E\u0924 \u0915\u093E \u0938\u0941\u091D\u093E\u0935 \u0928\u0939\u0940\u0902 \u092E\u093F\u0932 \u0938\u0915\u093E",
  "pricing.retry": "\u092B\u093F\u0930 \u0938\u0947 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902",
  "pricing.rangeLabel": "\u0938\u0941\u091D\u093E\u0908 \u0917\u0908 \u0915\u0940\u092E\u0924 \u0938\u0940\u092E\u093E",
  "pricing.sellingPriceLabel": "\u0906\u092A\u0915\u0940 \u092C\u093F\u0915\u094D\u0930\u0940 \u0915\u0940\u092E\u0924",
  "pricing.sellingPriceNote": "\u092F\u0939 \u090F\u0915 \u0938\u0941\u091D\u093E\u0935 \u0939\u0948, \u0906\u092A \u0915\u094B\u0908 \u092D\u0940 \u0915\u0940\u092E\u0924 \u0924\u092F \u0915\u0930 \u0938\u0915\u0924\u0947 \u0939\u0948\u0902\u0964",
  "pricing.sellingPriceInvalid": "0 \u0938\u0947 \u0905\u0927\u093F\u0915 \u092C\u093F\u0915\u094D\u0930\u0940 \u0915\u0940\u092E\u0924 \u0921\u093E\u0932\u0947\u0902",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0915\u0930\u0947\u0902",
  "pricing.publishError": "\u0909\u0924\u094D\u092A\u093E\u0926 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0915\u0930\u0928\u0947 \u092E\u0947\u0902 \u0935\u093F\u092B\u0932",
  "pricing.successTitle": "\u0906\u092A\u0915\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u093E\u0907\u0935 \u0939\u0948!",
  "pricing.successMessage": "\u0916\u0930\u0940\u0926\u093E\u0930 \u0905\u092C \u0907\u0938\u0947 \u0906\u092A\u0915\u0940 \u0926\u0941\u0915\u093E\u0928 \u092E\u0947\u0902 \u0926\u0947\u0916 \u0938\u0915\u0924\u0947 \u0939\u0948\u0902\u0964",
  "pricing.viewShop": "\u092E\u0947\u0930\u0940 \u0926\u0941\u0915\u093E\u0928 \u092E\u0947\u0902 \u0926\u0947\u0916\u0947\u0902",
  "home.title": "\u092E\u0947\u0930\u0940 \u0926\u0941\u0915\u093E\u0928",
  "home.gemBannerTitle": "GeM / ONDC \u0938\u0947 \u091C\u0941\u0921\u093C\u0947\u0902",
  "home.gemBannerBadge": "\u091C\u0932\u094D\u0926 \u0906 \u0930\u0939\u093E \u0939\u0948",
  "home.gemBannerMessage": "\u092F\u0939 \u0938\u0941\u0935\u093F\u0927\u093E \u091C\u0932\u094D\u0926 \u0939\u0940 \u0909\u092A\u0932\u092C\u094D\u0927 \u0939\u094B\u0917\u0940\u0964",
  "home.loading": "\u0906\u092A\u0915\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u094B\u0921 \u0939\u094B \u0930\u0939\u0947 \u0939\u0948\u0902...",
  "home.loadError": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0947",
  "home.retry": "\u092B\u093F\u0930 \u0938\u0947 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902",
  "home.emptyTitle": "\u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0939\u0940\u0902",
  "home.emptyMessage": "KalaSetu \u092A\u0930 \u092C\u093F\u0915\u094D\u0930\u0940 \u0936\u0941\u0930\u0942 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u0905\u092A\u0928\u093E \u092A\u0939\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u094B\u0921\u093C\u0947\u0902\u0964",
  "home.addFirstProduct": "\u0905\u092A\u0928\u093E \u092A\u0939\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u094B\u0921\u093C\u0947\u0902",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u0921\u094D\u0930\u093E\u092B\u093C\u094D\u091F",
  "home.statusFailed": "\u0935\u093F\u092B\u0932",
  "home.detailCategory": "\u0936\u094D\u0930\u0947\u0923\u0940",
  "home.detailEdit": "\u092C\u0926\u0932\u0947\u0902",
  "home.detailDelete": "\u0939\u091F\u093E\u090F\u0902",
  "home.detailClose": "\u092C\u0902\u0926 \u0915\u0930\u0947\u0902",
  "home.editPriceLabel": "\u0915\u0940\u092E\u0924",
  "home.editDescriptionLabel": "\u0935\u093F\u0935\u0930\u0923",
  "home.editSave": "\u092C\u0926\u0932\u093E\u0935 \u0938\u0939\u0947\u091C\u0947\u0902",
  "home.editCancel": "\u0930\u0926\u094D\u0926 \u0915\u0930\u0947\u0902",
  "home.editPriceInvalid": "0 \u0938\u0947 \u0905\u0927\u093F\u0915 \u0915\u0940\u092E\u0924 \u0926\u0930\u094D\u091C \u0915\u0930\u0947\u0902",
  "home.editDescriptionRequired": "\u0926\u094B\u0928\u094B\u0902 \u092D\u093E\u0937\u093E\u0913\u0902 \u092E\u0947\u0902 \u0935\u093F\u0935\u0930\u0923 \u0916\u093E\u0932\u0940 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0924\u093E",
  "home.editError": "\u0906\u092A\u0915\u0947 \u092C\u0926\u0932\u093E\u0935 \u0938\u0939\u0947\u091C\u0947 \u0928\u0939\u0940\u0902 \u091C\u093E \u0938\u0915\u0947, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902",
  "home.deleteConfirm": "\u0915\u094D\u092F\u093E \u092F\u0939 \u0909\u0924\u094D\u092A\u093E\u0926 \u0939\u091F\u093E\u0928\u093E \u0939\u0948? \u0907\u0938\u0947 \u0935\u093E\u092A\u0938 \u0928\u0939\u0940\u0902 \u0932\u093E\u092F\u093E \u091C\u093E \u0938\u0915\u0924\u093E\u0964",
  "home.deleteConfirmYes": "\u0939\u093E\u0902, \u0939\u091F\u093E\u090F\u0902",
  "home.deleteError": "\u092F\u0939 \u0909\u0924\u094D\u092A\u093E\u0926 \u0939\u091F\u093E\u092F\u093E \u0928\u0939\u0940\u0902 \u091C\u093E \u0938\u0915\u093E, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932",
  "profile.emailLabel": "\u0908\u092E\u0947\u0932 \u092A\u0924\u093E",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902",
  "profile.loading": "\u0906\u092A\u0915\u0940 \u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0932\u094B\u0921 \u0939\u094B \u0930\u0939\u0940 \u0939\u0948...",
  "profile.loadError": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0940",
  "profile.displayNameLabel": "\u0906\u092A\u0915\u093E \u0928\u093E\u092E",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928 \u0915\u093E \u0928\u093E\u092E",
  "profile.whatsappLabel": "WhatsApp \u0928\u0902\u092C\u0930 (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "profile.whatsappPlaceholder": "\u0909\u0926\u093E\u0939\u0930\u0923: 98765 43210",
  "profile.whatsappNote": "\u092F\u0926\u093F \u0906\u092A \u0907\u0938\u0947 \u091C\u094B\u0921\u093C\u0924\u0947 \u0939\u0948\u0902 \u0924\u094B \u0916\u0930\u0940\u0926\u093E\u0930 \u0906\u092A\u0915\u0940 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917 \u092A\u0930 WhatsApp \u092C\u091F\u0928 \u0926\u0947\u0916\u0947\u0902\u0917\u0947\u0964",
  "profile.whatsappInvalid": "\u0935\u0948\u0927 \u092B\u093C\u094B\u0928 \u0928\u0902\u092C\u0930 \u0926\u0930\u094D\u091C \u0915\u0930\u0947\u0902",
  "profile.pincodeLabel": "\u092A\u093F\u0928\u0915\u094B\u0921 (\u0936\u093F\u092A\u093F\u0902\u0917 \u0905\u0928\u0941\u092E\u093E\u0928 \u0939\u0947\u0924\u0941)",
  "profile.pincodePlaceholder": "\u0909\u0926\u093E. 560001",
  "profile.pincodeNote": "\u0916\u0930\u0940\u0926\u093E\u0930\u094B\u0902 \u0915\u094B \u0906\u092A\u0915\u0947 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917 \u092A\u0930 \u0905\u0928\u0941\u092E\u093E\u0928\u093F\u0924 \u0936\u093F\u092A\u093F\u0902\u0917 \u0932\u093E\u0917\u0924 \u0926\u093F\u0916\u093E\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F\u0964 \u092F\u0939 \u0938\u0940\u0927\u0947 \u0916\u0930\u0940\u0926\u093E\u0930\u094B\u0902 \u0915\u094B \u0928\u0939\u0940\u0902 \u0926\u093F\u0916\u0924\u093E, \u0915\u0947\u0935\u0932 \u0905\u0928\u0941\u092E\u093E\u0928 \u0915\u0947 \u0932\u093F\u092F\u0947 \u092A\u094D\u0930\u092F\u094B\u0917 \u0939\u094B\u0924\u093E \u0939\u0948\u0964",
  "profile.pincodeInvalid": "\u0935\u0948\u0927 6-\u0905\u0902\u0915\u0940\u092F \u092A\u093F\u0928\u0915\u094B\u0921 \u0926\u0930\u094D\u091C \u0915\u0930\u0947\u0902",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0939\u0947\u091C\u0947\u0902",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0939\u0947\u091C\u0940 \u0917\u0908",
  "profile.saveError": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0939\u0947\u091C\u0940 \u0928\u0939\u0940\u0902 \u091C\u093E \u0938\u0915\u0940, \u0915\u0943\u092A\u092F\u093E \u092B\u093F\u0930 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902",
  "profile.logout": "\u0932\u0949\u0917 \u0906\u0909\u091F \u0915\u0930\u0947\u0902",
  "install.message": "\u091C\u0932\u094D\u0926\u0940 \u092A\u0939\u0941\u0902\u091A \u0915\u0947 \u0932\u093F\u090F KalaSetu \u0907\u0902\u0938\u094D\u091F\u0949\u0932 \u0915\u0930\u0947\u0902",
  "install.action": "\u0907\u0902\u0938\u094D\u091F\u0949\u0932 \u0915\u0930\u0947\u0902",
  "install.dismiss": "\u092C\u0902\u0926 \u0915\u0930\u0947\u0902",
  "offline.message": "\u0906\u092A \u0911\u092B\u093C\u0932\u093E\u0907\u0928 \u0939\u0948\u0902, \u0915\u0941\u091B \u0938\u0941\u0935\u093F\u0927\u093E\u090F\u0902 \u0915\u093E\u092E \u0928\u0939\u0940\u0902 \u0915\u0930 \u0938\u0915\u0924\u0940\u0902",
  "welcome.languageHint": "\u092A\u0942\u0930\u093E \u0910\u092A \u0907\u0938 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0939\u094B\u0917\u093E\u0964",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E\u090F\u0901",
  "describe.localTab": "\u0906\u092A\u0915\u0940 \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0905\u092A\u0928\u0940 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0905\u092A\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u093E \u0935\u0930\u094D\u0923\u0928 \u0915\u0930\u0947\u0902",
  "describe.syncing": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0939\u094B \u0930\u0939\u0940 \u0939\u0948...",
  "describe.syncFailed": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0940\u0964 \u091C\u093C\u0930\u0942\u0930\u0924 \u0939\u094B \u0924\u094B \u0938\u094D\u0935\u092F\u0902 \u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u0947\u0902\u0964",
  "describe.syncHint": "\u0938\u0902\u092A\u093E\u0926\u0928 \u0938\u094D\u0935\u0924\u0903 \u0939\u0940 \u0926\u0942\u0938\u0930\u0940 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0915\u0949\u092A\u0940 \u0939\u094B \u091C\u093E\u0924\u0947 \u0939\u0948\u0902\u0964",
  "pricing.updating": "\u0928\u0908 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924 \u0915\u0947 \u0932\u093F\u090F \u0905\u092A\u0921\u0947\u091F \u0939\u094B \u0930\u0939\u093E \u0939\u0948...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "\u090F\u0928\u093E\u0932\u093F\u091F\u093F\u0915\u094D\u0938 \u0926\u0947\u0916\u0947\u0902",
  "home.viewInquiries": "\u092A\u0942\u091B\u0924\u093E\u091B",
  "inquiries.title": "\u092A\u0942\u091B\u0924\u093E\u091B",
  "inquiries.loadError": "\u0906\u092A\u0915\u0940 \u092A\u0942\u091B\u0924\u093E\u091B \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0940",
  "inquiries.empty": "\u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0908 \u092A\u0942\u091B\u0924\u093E\u091B \u0928\u0939\u0940\u0902 \u0939\u0948\u0964 \u091C\u092C \u0915\u094B\u0908 \u0916\u0930\u0940\u0926\u093E\u0930 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0947 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902 \u0938\u0902\u0926\u0947\u0936 \u092D\u0947\u091C\u0947\u0917\u093E, \u0924\u094B \u092F\u0939\u093E\u0901 \u0926\u093F\u0916\u0947\u0917\u093E\u0964",
  "inquiries.badgeNew": "\u0928\u092F\u093E",
  "inquiries.badgeResponded": "\u091C\u0935\u093E\u092C \u0926\u093F\u092F\u093E \u0917\u092F\u093E",
  "inquiries.quantityLine": "\u0930\u0941\u091A\u093F \u0935\u093E\u0932\u0940 \u092E\u093E\u0924\u094D\u0930\u093E: {n}",
  "inquiries.contactLine": "\u092A\u0938\u0902\u0926\u0940\u0926\u093E \u0938\u0902\u092A\u0930\u094D\u0915: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "WhatsApp \u092A\u0930 \u091C\u0935\u093E\u092C \u0926\u0947\u0902",
  "inquiries.whatsappReplyPrefill": "\u0928\u092E\u0938\u094D\u0924\u0947! KalaSetu \u092A\u0930 {product} \u092E\u0947\u0902 \u0906\u092A\u0915\u0940 \u0930\u0941\u091A\u093F \u0915\u0947 \u0932\u093F\u090F \u0927\u0928\u094D\u092F\u0935\u093E\u0926\u0964",
  "inquiries.markResponded": "\u091C\u0935\u093E\u092C \u0926\u093F\u092F\u093E \u0917\u092F\u093E",
  "inquiries.close": "\u092A\u0942\u091B\u0924\u093E\u091B \u092C\u0902\u0926 \u0915\u0930\u0947\u0902",
  "shipping.estimateToggle": "\u0917\u0902\u0924\u0935\u094D\u092F \u0915\u0947 \u0905\u0928\u0941\u0938\u093E\u0930 \u0905\u0928\u0941\u092E\u093E\u0928\u093F\u0924 \u0936\u093F\u092A\u093F\u0902\u0917 \u0932\u093E\u0917\u0924",
  "shipping.estimateDisclaimer": "\u0938\u093E\u092E\u093E\u0928\u094D\u092F \u092D\u093E\u0930\u0924\u0940\u092F \u0915\u0942\u0930\u093F\u092F\u0930 \u0926\u0930\u094B\u0902 \u092A\u0930 \u0906\u0927\u093E\u0930\u093F\u0924 \u092E\u094B\u091F\u093E \u0905\u0928\u0941\u092E\u093E\u0928, \u0935\u093E\u0938\u094D\u0924\u0935\u093F\u0915 \u0915\u094B\u091F \u092F\u093E \u092C\u0941\u0915\u093F\u0902\u0917 \u0928\u0939\u0940\u0902\u0964 \u0935\u093E\u0938\u094D\u0924\u0935\u093F\u0915 \u0932\u093E\u0917\u0924 \u0916\u0930\u0940\u0926\u093E\u0930 \u0915\u0947 \u0911\u0930\u094D\u0921\u0930 \u0915\u0947 \u0915\u0942\u0930\u093F\u092F\u0930 \u092A\u0930 \u0928\u093F\u0930\u094D\u092D\u0930 \u0915\u0930\u0924\u0940 \u0939\u0948\u0964",
  "shipping.weightMissingArtisanNote": "\u092A\u093F\u091B\u0932\u0947 \u091A\u0930\u0923 \u092E\u0947\u0902 \u0905\u0928\u0941\u092E\u093E\u0928\u093F\u0924 \u0935\u091C\u0928 \u091C\u094B\u0921\u093C\u0947\u0902 \u0924\u093E\u0915\u093F \u092F\u0939\u093E\u0901 \u0905\u0928\u0941\u092E\u093E\u0928\u093F\u0924 \u0936\u093F\u092A\u093F\u0902\u0917 \u0932\u093E\u0917\u0924 \u0926\u093F\u0916\u0947 \u0914\u0930 \u0916\u0930\u0940\u0926\u093E\u0930\u094B\u0902 \u0915\u094B \u092D\u0940 \u0926\u093F\u0916\u0947\u0964",
  "shipping.pincodeMissingArtisanNote": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u092E\u0947\u0902 \u0905\u092A\u0928\u093E \u092A\u093F\u0928\u0915\u094B\u0921 \u091C\u094B\u0921\u093C\u0947\u0902 \u0924\u093E\u0915\u093F \u0916\u0930\u0940\u0926\u093E\u0930 \u0907\u0938 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917 \u092A\u0930 \u0905\u0928\u0941\u092E\u093E\u0928\u093F\u0924 \u0936\u093F\u092A\u093F\u0902\u0917 \u0932\u093E\u0917\u0924 \u0926\u0947\u0916 \u0938\u0915\u0947\u0902\u0964",
  "shipping.zone.local": "\u090F\u0915 \u0939\u0940 \u0936\u0939\u0930",
  "shipping.zone.withinState": "\u0930\u093E\u091C\u094D\u092F \u0915\u0947 \u092D\u0940\u0924\u0930",
  "shipping.zone.metroToMetro": "\u092E\u0947\u091F\u094D\u0930\u094B \u0938\u0947 \u092E\u0947\u091F\u094D\u0930\u094B",
  "shipping.zone.restOfIndia": "\u092D\u093E\u0930\u0924 \u0915\u0947 \u092C\u093E\u0915\u0940 \u0939\u093F\u0938\u094D\u0938\u0947",
  "shipping.zone.special": "\u091C\u092E\u094D\u092E\u0942-\u0915\u0936\u094D\u092E\u0940\u0930, \u0909\u0924\u094D\u0924\u0930-\u092A\u0942\u0930\u094D\u0935 \u0914\u0930 \u0926\u094D\u0935\u0940\u092A \u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "shipping.buyerUnavailable": "\u0907\u0938 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917 \u0915\u0947 \u0932\u093F\u090F \u0905\u092D\u0940 \u0936\u093F\u092A\u093F\u0902\u0917 \u0905\u0928\u0941\u092E\u093E\u0928 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964",
  "shipping.pincodeLabel": "\u0906\u092A\u0915\u093E \u092A\u093F\u0928\u0915\u094B\u0921",
  "shipping.pincodePlaceholder": "\u0909\u0926\u093E. 560001",
  "shipping.pincodeInvalid": "\u0935\u0948\u0927 6-\u0905\u0902\u0915\u0940\u092F \u092A\u093F\u0928\u0915\u094B\u0921 \u0926\u0930\u094D\u091C \u0915\u0930\u0947\u0902",
  "shipping.estimatedShippingLabel": "\u0905\u0928\u0941\u092E\u093E\u0928\u093F\u0924 \u0936\u093F\u092A\u093F\u0902\u0917",
  "shipping.estimatedTotalLabel": "\u0905\u0928\u0941\u092E\u093E\u0928\u093F\u0924 \u0915\u0941\u0932 \u0921\u093F\u0932\u0940\u0935\u0930\u0940",
  "shipping.buyerDisclaimer": "\u0935\u091C\u093C\u0928 \u0914\u0930 \u092E\u093E\u0930\u094D\u0917 \u0915\u0947 \u0906\u0927\u093E\u0930 \u092A\u0930 \u0938\u093E\u092E\u093E\u0928\u094D\u092F \u092D\u093E\u0930\u0924\u0940\u092F \u0915\u0942\u0930\u093F\u092F\u0930 \u0926\u0930\u094B\u0902 \u092A\u0930 \u0905\u0928\u0941\u092E\u093E\u0928, \u092F\u0939 \u0935\u093E\u0938\u094D\u0924\u0935\u093F\u0915 \u0915\u094B\u091F, \u092C\u0941\u0915\u093F\u0902\u0917 \u092F\u093E \u0917\u093E\u0930\u0902\u091F\u0940\u0915\u0943\u0924 \u0915\u0940\u092E\u0924 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964",
  "analytics.backToShop": "\u092E\u0947\u0930\u0940 \u0926\u0941\u0915\u093E\u0928",
  "analytics.title": "\u090F\u0928\u093E\u0932\u093F\u091F\u093F\u0915\u094D\u0938",
  "analytics.loadError": "\u090F\u0928\u093E\u0932\u093F\u091F\u093F\u0915\u094D\u0938 \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u092A\u093E\u090F",
  "analytics.totalViews": "\u0915\u0941\u0932 \u0926\u0943\u0936\u094D\u092F",
  "analytics.viewsThisWeek": "\u0907\u0938 \u0939\u092B\u094D\u0924\u0947 \u0915\u0947 \u0926\u0943\u0936\u094D\u092F",
  "analytics.totalInquiries": "\u0915\u0941\u0932 \u092A\u0942\u091B\u0924\u093E\u091B",
  "analytics.activeListings": "\u0938\u0915\u094D\u0930\u093F\u092F \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917",
  "analytics.chartTitle": "\u0935\u094D\u092F\u0942\u091C\u093C, \u092A\u093F\u091B\u0932\u0947 30 \u0926\u093F\u0928",
  "analytics.chartEmpty": "\u092A\u093F\u091B\u0932\u0947 30 \u0926\u093F\u0928\u094B\u0902 \u092E\u0947\u0902 \u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0908 \u0926\u0943\u0936\u094D\u092F \u0928\u0939\u0940\u0902 \u0939\u0948\u0964 \u0905\u092A\u0928\u0940 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917\u094D\u0938 \u0915\u094B \u0915\u0941\u091B \u0938\u092E\u092F \u0924\u0915 \u0932\u093E\u0907\u0935 \u0930\u0939\u0928\u0947 \u0915\u0947 \u092C\u093E\u0926 \u092B\u093F\u0930 \u0926\u0947\u0916\u0947\u0902\u0964",
  "analytics.topListingsTitle": "\u0936\u0940\u0930\u094D\u0937 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917\u094D\u0938",
  "analytics.listingsEmpty": "\u092F\u0939\u093E\u0901 \u092A\u094D\u0930\u0926\u0930\u094D\u0936\u0928 \u0926\u0947\u0916\u0928\u093E \u0936\u0941\u0930\u0942 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u090F\u0915 \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u094B\u0921\u093C\u0947\u0902\u0964",
  "analytics.windowNote": "\u092A\u093F\u091B\u0932\u0947 30 \u0926\u093F\u0928\u094B\u0902 \u092E\u0947\u0902 \u0926\u0947\u0916\u0947 \u0917\u090F \u0926\u0943\u0936\u094D\u092F \u0914\u0930 \u092A\u0942\u091B\u0924\u093E\u091B \u0915\u0940 \u0938\u0902\u0916\u094D\u092F\u093E\u0964",
  "analytics.columnTitle": "\u0909\u0924\u094D\u092A\u093E\u0926",
  "analytics.columnViews": "\u0926\u0943\u0936\u094D\u092F",
  "analytics.columnInquiries": "\u092A\u0942\u091B\u0924\u093E\u091B",
  "home.exportCatalog": "\u0915\u0948\u091F\u0932\u0949\u0917 \u0928\u093F\u0930\u094D\u092F\u093E\u0924 (ONDC \u092B\u093C\u0949\u0930\u094D\u092E\u0947\u091F)",
  "home.exportCatalogNote": "\u0906\u092A\u0915\u0940 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917 \u0915\u094B ONDC \u0930\u093F\u091F\u0947\u0932 \u0915\u0948\u091F\u0932\u0949\u0917 \u0938\u0902\u0930\u091A\u0928\u093E \u092E\u0947\u0902 \u092E\u0948\u092A \u0915\u0930\u0915\u0947 \u0921\u093E\u0909\u0928\u0932\u094B\u0921 \u0915\u0930\u0924\u093E \u0939\u0948\u0964 \u0907\u0902\u091F\u0940\u0917\u094D\u0930\u0947\u0936\u0928 \u0924\u0948\u092F\u093E\u0930: \u092E\u0948\u092A\u093F\u0902\u0917 \u0939\u094B \u0917\u0908 \u0939\u0948, \u0928\u0947\u091F\u0935\u0930\u094D\u0915 \u092A\u0930 \u0932\u093E\u0907\u0935 \u0939\u094B\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F ONDC \u092A\u0902\u091C\u0940\u0915\u0930\u0923 \u0906\u0935\u0936\u094D\u092F\u0915 \u0939\u0948\u0964",
  "home.exportOndcSingle": "\u0907\u0938 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u094B \u0928\u093F\u0930\u094D\u092F\u093E\u0924 (ONDC \u092B\u093C\u0949\u0930\u094D\u092E\u0947\u091F)",
  "profile.relocalising": "\u0906\u092A\u0915\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0907\u0938 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0905\u092A\u0921\u0947\u091F \u0939\u094B \u0930\u0939\u0947 \u0939\u0948\u0902...",
  "profile.relocalised": "{n} \u0909\u0924\u094D\u092A\u093E\u0926 \u0907\u0938 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0905\u092A\u0921\u0947\u091F \u0915\u093F\u090F \u0917\u090F\u0964",
  "profile.relocaliseFailed": "\u0915\u0941\u091B \u0909\u0924\u094D\u092A\u093E\u0926 \u0905\u092A\u0921\u0947\u091F \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0947\u0964 \u092C\u093E\u0926 \u092E\u0947\u0902 \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902\u0964",
  "marketplace.navBrowse": "\u092C\u094D\u0930\u093E\u0909\u091C\u093C",
  "marketplace.navProfile": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932",
  "marketplace.browseTitle": "\u092C\u093E\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u094B\u091C\u0947\u0902...",
  "marketplace.filtersTitle": "\u092B\u093C\u093F\u0932\u094D\u091F\u0930",
  "marketplace.filtersClear": "\u0938\u092D\u0940 \u0938\u093E\u092B\u093C \u0915\u0930\u0947\u0902",
  "marketplace.filterAll": "\u0938\u092D\u0940",
  "marketplace.filterMaterial": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "marketplace.filterRegion": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.filterPrice": "\u0915\u0940\u092E\u0924 \u0938\u0940\u092E\u093E (\u20B9)",
  "marketplace.filterPriceMin": "\u0928\u094D\u092F\u0942\u0928\u0924\u092E",
  "marketplace.filterPriceMax": "\u0905\u0927\u093F\u0915\u0924\u092E",
  "marketplace.sortLabel": "\u0915\u094D\u0930\u092E\u092C\u0926\u094D\u0927 \u0915\u0930\u0947\u0902",
  "marketplace.sortNewest": "\u0928\u0935\u0940\u0928\u0924\u092E \u092A\u0939\u0932\u0947",
  "marketplace.sortPriceAsc": "\u0915\u0940\u092E\u0924: \u0915\u092E \u0938\u0947 \u0905\u0927\u093F\u0915",
  "marketplace.sortPriceDesc": "\u0915\u0940\u092E\u0924: \u0905\u0927\u093F\u0915 \u0938\u0947 \u0915\u092E",
  "marketplace.resultCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926 \u092E\u093F\u0932\u0947",
  "marketplace.loadMore": "\u0914\u0930 \u0932\u094B\u0921 \u0915\u0930\u0947\u0902",
  "marketplace.loadError": "\u092E\u093E\u0930\u094D\u0915\u0947\u091F\u092A\u094D\u0932\u0947\u0938 \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u093E, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902",
  "marketplace.emptyTitle": "\u0915\u094B\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u0907\u0928 \u092B\u093C\u093F\u0932\u094D\u091F\u0930\u094B\u0902 \u0938\u0947 \u092E\u0947\u0932 \u0928\u0939\u0940\u0902 \u0916\u093E\u0924\u0947",
  "marketplace.emptyFiltered": "\u092B\u093C\u093F\u0932\u094D\u091F\u0930 \u0939\u091F\u093E\u090F\u0901 \u092F\u093E \u0915\u0941\u091B \u0914\u0930 \u0916\u094B\u091C\u0947\u0902.",
  "marketplace.emptyNoProducts": "\u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0928\u0939\u0940\u0902 \u0939\u0941\u0906 \u0939\u0948\u0964 \u091C\u0932\u094D\u0926 \u0939\u0940 \u092B\u093F\u0930 \u0926\u0947\u0916\u0947\u0902.",
  "marketplace.artisanUnnamed": "KalaSetu \u0915\u093E\u0930\u0940\u0917\u0930",
  "marketplace.backToBrowse": "\u092C\u093E\u091C\u093E\u0930 \u092A\u0930 \u0935\u093E\u092A\u0938 \u091C\u093E\u090F\u0901",
  "marketplace.detailNotFoundTitle": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0939\u0940\u0902 \u092E\u093F\u0932\u093E",
  "marketplace.detailNotFoundMessage": "\u092F\u0939 \u0909\u0924\u094D\u092A\u093E\u0926 \u0939\u091F\u093E\u092F\u093E \u0917\u092F\u093E \u0939\u094B \u0938\u0915\u0924\u093E \u0939\u0948 \u092F\u093E \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964",
  "marketplace.artisanSummaryTitle": "\u0915\u093E\u0930\u0940\u0917\u0930 \u0915\u0947 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902",
  "marketplace.artisanProductCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926 KalaSetu \u092A\u0930 \u0938\u0942\u091A\u0940\u092C\u0926\u094D\u0927",
  "marketplace.inquiryTitle": "\u0907\u0938 \u0909\u0924\u094D\u092A\u093E\u0926 \u092E\u0947\u0902 \u0930\u0941\u091A\u093F \u0939\u0948?",
  "marketplace.inquirySubtitle": "\u0915\u093E\u0930\u0940\u0917\u0930 \u0915\u094B \u0938\u0902\u0926\u0947\u0936 \u092D\u0947\u091C\u0947\u0902, \u092F\u093E \u090A\u092A\u0930 WhatsApp \u0938\u0947 \u0938\u0902\u092A\u0930\u094D\u0915 \u0915\u0930\u0947\u0902\u0964",
  "marketplace.inquiryPlaceholder": "\u0915\u093E\u0930\u0940\u0917\u0930 \u0915\u094B \u092C\u0924\u093E\u0907\u090F: \u092E\u093E\u0924\u094D\u0930\u093E, \u0915\u0938\u094D\u091F\u092E\u093E\u0907\u091C\u093C\u0947\u0936\u0928, \u0921\u093F\u0932\u0940\u0935\u0930\u0940 \u0938\u092E\u092F...",
  "marketplace.inquiryQuantityLabel": "\u0907\u091A\u094D\u091B\u093F\u0924 \u092E\u093E\u0924\u094D\u0930\u093E",
  "marketplace.inquiryQuantityPlaceholder": "\u0909\u0926\u093E. 2",
  "marketplace.contactPreferenceLabel": "\u0906\u092A\u0938\u0947 \u0915\u093E\u0930\u0940\u0917\u0930 \u0915\u0948\u0938\u0947 \u0938\u0902\u092A\u0930\u094D\u0915 \u0915\u0930\u0947?",
  "marketplace.contactPreference.email": "\u0908\u092E\u0947\u0932",
  "marketplace.contactPreference.phone": "\u092B\u093C\u094B\u0928",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "\u0906\u092A\u0915\u093E \u0928\u0902\u092C\u0930",
  "marketplace.contactValuePlaceholder": "\u0909\u0926\u093E. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "WhatsApp \u092A\u0930 \u0938\u0902\u0926\u0947\u0936",
  "marketplace.whatsappPrefill": "\u0928\u092E\u0938\u094D\u0924\u0947! \u092E\u0948\u0902 KalaSetu \u092A\u0930 {product} ({passportId}) \u092E\u0947\u0902 \u0930\u0941\u091A\u093F \u0930\u0916\u0924\u093E \u0939\u0942\u0901\u0964",
  "marketplace.inquirySend": "\u092A\u0942\u091B\u0924\u093E\u091B \u092D\u0947\u091C\u0947\u0902",
  "marketplace.inquirySent": "\u0906\u092A\u0915\u0940 \u092A\u0942\u091B\u0924\u093E\u091B \u092D\u0947\u091C \u0926\u0940 \u0917\u0908 \u0939\u0948\u0964 \u0915\u093E\u0930\u0940\u0917\u0930 \u0906\u092A\u0938\u0947 \u0938\u0902\u092A\u0930\u094D\u0915 \u0915\u0930\u0947\u0917\u093E\u0964",
  "marketplace.inquiryError": "\u092A\u0942\u091B\u0924\u093E\u091B \u0928\u0939\u0940\u0902 \u092D\u0947\u091C\u0940 \u091C\u093E \u0938\u0915\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0947\u0902",
  "marketplace.regionLabel": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.regionUnspecified": "\u0928\u093F\u0930\u094D\u0926\u093F\u0937\u094D\u091F \u0928\u0939\u0940\u0902",
  "marketplace.myInquiriesTitle": "\u092E\u0947\u0930\u0940 \u092A\u0942\u091B\u0924\u093E\u091B",
  "marketplace.inquiriesLoading": "\u0906\u092A\u0915\u0940 \u092A\u0942\u091B\u0924\u093E\u091B \u0932\u094B\u0921 \u0939\u094B \u0930\u0939\u0940 \u0939\u0948...",
  "marketplace.inquiriesLoadError": "\u0906\u092A\u0915\u0940 \u092A\u0942\u091B\u0924\u093E\u091B \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0939\u094B \u0938\u0915\u0940",
  "marketplace.noInquiries": "\u0906\u092A\u0928\u0947 \u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0908 \u092A\u0942\u091B\u0924\u093E\u091B \u0928\u0939\u0940\u0902 \u092D\u0947\u091C\u0940 \u0939\u0948\u0964 \u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u094B\u091C\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u092E\u093E\u0930\u094D\u0915\u0947\u091F\u092A\u094D\u0932\u0947\u0938 \u0926\u0947\u0916\u0947\u0902\u0964",
  "marketplace.inquiryProductRemoved": "\u092F\u0939 \u0909\u0924\u094D\u092A\u093E\u0926 \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u0940\u0902 \u0939\u0948",
  "marketplace.inquiryStatusOpen": "\u091C\u0935\u093E\u092C \u0915\u093E \u0907\u0902\u0924\u091C\u093E\u0930",
  "marketplace.inquiryStatusClosed": "\u092C\u0902\u0926",
  "marketplace.inquiryResponded": "\u0915\u093E\u0930\u0940\u0917\u0930 \u0928\u0947 \u091C\u0935\u093E\u092C \u0926\u093F\u092F\u093E",
  "heritage.title": "\u0915\u0941\u091B \u0905\u0924\u093F\u0930\u093F\u0915\u094D\u0924 \u0935\u093F\u0935\u0930\u0923 (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "heritage.subtitle": "\u092F\u0947 \u0906\u092A\u0915\u0947 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0940 \u0915\u0939\u093E\u0928\u0940 \u0915\u094B \u0939\u0947\u0930\u093F\u091F\u0947\u091C \u092A\u093E\u0938\u092A\u094B\u0930\u094D\u091F \u092E\u0947\u0902 \u092C\u0924\u093E\u0928\u0947 \u092E\u0947\u0902 \u092E\u0926\u0926 \u0915\u0930\u0947\u0902\u0917\u0947\u0964 \u091C\u094B \u092C\u093E\u0924 \u092A\u0915\u094D\u0915\u0940 \u0928 \u0939\u094B, \u0909\u0938\u0947 \u091B\u094B\u0921\u093C \u0926\u0947\u0902\u0964",
  "heritage.techniqueLabel": "\u0924\u0915\u0928\u0940\u0915",
  "heritage.techniquePlaceholder": "\u091C\u0948\u0938\u0947 \u0939\u093E\u0925 \u0938\u0947 \u092C\u0928\u093E\u092F\u0940\u0902, \u092C\u094D\u0932\u0949\u0915 \u092A\u094D\u0930\u093F\u0902\u091F\u093F\u0902\u0917",
  "heritage.timeTakenLabel": "\u0928\u093F\u0930\u094D\u092E\u093E\u0923 \u092E\u0947\u0902 \u0932\u0917\u093E \u0938\u092E\u092F",
  "heritage.timeTakenPlaceholder": "\u091C\u0948\u0938\u0947 2 \u0926\u093F\u0928",
  "heritage.giTagLabel": "\u091C\u0940\u0906\u0908 \u092F\u093E \u0913\u0921\u0949\u092A \u091F\u0948\u0917, \u092F\u0926\u093F \u0939\u094B",
  "heritage.giTagPlaceholder": "\u091C\u0948\u0938\u0947 \u092C\u0928\u093E\u0930\u0938 \u092C\u094D\u0930\u094B\u0915\u0947\u0921 \u091C\u0940\u0906\u0908",
  "heritage.careLabel": "\u0926\u0947\u0916\u092D\u093E\u0932 \u0928\u093F\u0930\u094D\u0926\u0947\u0936",
  "heritage.carePlaceholder": "\u091C\u0948\u0938\u0947 \u0915\u0947\u0935\u0932 \u0939\u093E\u0925 \u0938\u0947 \u0927\u094B\u090F\u0901, \u0938\u0940\u0927\u0940 \u0927\u0942\u092A \u0938\u0947 \u0926\u0942\u0930 \u0930\u0916\u0947\u0902",
  "heritage.weightLabel": "\u0932\u0917\u092D\u0917 \u0935\u091C\u0928, \u0936\u093F\u092A\u093F\u0902\u0917 \u0915\u0947 \u0932\u093F\u090F \u092A\u0948\u0915 \u0915\u093F\u092F\u093E \u0939\u0941\u0906",
  "heritage.weightHelper": "\u0924\u0930\u093E\u091C\u0942 \u0928\u0939\u0940\u0902 \u0939\u0948? \u0938\u092C\u0938\u0947 \u0928\u091C\u093C\u0926\u0940\u0915\u0940 \u0906\u0915\u093E\u0930 \u091A\u0941\u0928\u0947\u0902\u0964 \u092F\u0939 \u0915\u0947\u0935\u0932 \u0916\u0930\u0940\u0926\u093E\u0930\u094B\u0902 \u0915\u0947 \u0936\u093F\u092A\u093F\u0902\u0917 \u0916\u0930\u094D\u091A \u0915\u093E \u0905\u0928\u0941\u092E\u093E\u0928 \u0932\u0917\u093E\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u0939\u0948\u0964",
  "heritage.weightExactLabel": "\u092F\u093E \u0915\u093F\u0932\u094B\u0917\u094D\u0930\u093E\u092E \u092E\u0947\u0902 \u0938\u091F\u0940\u0915 \u0935\u091C\u0928 \u0926\u0930\u094D\u091C \u0915\u0930\u0947\u0902",
  "heritage.weightExactPlaceholder": "\u0909\u0926\u093E. 1.2",
  "shipping.weightCategory.light": "\u0939\u0932\u094D\u0915\u093E (0.5 \u0915\u093F\u0917\u094D\u0930\u093E \u0924\u0915)",
  "shipping.weightCategory.medium": "\u092E\u0927\u094D\u092F\u092E (\u0932\u0917\u092D\u0917 1 \u0915\u093F\u0917\u094D\u0930\u093E)",
  "shipping.weightCategory.heavy": "\u092D\u093E\u0930\u0940 (\u0932\u0917\u092D\u0917 3 \u0915\u093F\u0917\u094D\u0930\u093E)",
  "shipping.weightCategory.veryHeavy": "\u092C\u0939\u0941\u0924 \u092D\u093E\u0930\u0940 (\u0932\u0917\u092D\u0917 7 \u0915\u093F\u0917\u094D\u0930\u093E)",
  "heritage.continue": "\u091C\u093E\u0930\u0940 \u0930\u0916\u0947\u0902",
  "passport.viewLink": "\u0939\u0947\u0930\u093F\u091F\u0947\u091C \u092A\u093E\u0938\u092A\u094B\u0930\u094D\u091F \u0926\u0947\u0916\u0947\u0902",
  "passport.eyebrow": "\u0939\u0938\u094D\u0924\u0936\u093F\u0932\u094D\u092A \u0935\u093F\u0930\u093E\u0938\u0924 \u092A\u093E\u0938\u092A\u094B\u0930\u094D\u091F",
  "passport.selfDeclaredNotice": "\u0915\u093E\u0930\u0940\u0917\u0930 \u0926\u094D\u0935\u093E\u0930\u093E \u0938\u094D\u0935\u092F\u0902 \u0918\u094B\u0937\u093F\u0924\u0964 \u0938\u0930\u0915\u093E\u0930\u0940 \u092A\u094D\u0930\u092E\u093E\u0923\u092A\u0924\u094D\u0930 \u0928\u0939\u0940\u0902\u0964",
  "passport.productIdLabel": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0906\u0908\u0921\u0940",
  "passport.artisanLabel": "\u0915\u093E\u0930\u0940\u0917\u0930",
  "passport.regionLabel": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "passport.craftTypeLabel": "\u0939\u0938\u094D\u0924\u0936\u093F\u0932\u094D\u092A \u092A\u094D\u0930\u0915\u093E\u0930",
  "passport.techniqueLabel": "\u0924\u0915\u0928\u0940\u0915",
  "passport.materialsLabel": "\u0909\u092A\u092F\u094B\u0917 \u0915\u0940 \u0917\u0908 \u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "passport.timeTakenLabel": "\u0932\u0917\u0928\u0947 \u0935\u093E\u0932\u093E \u0938\u092E\u092F",
  "passport.createdLabel": "\u0928\u093F\u0930\u094D\u092E\u093F\u0924",
  "passport.giTagLabel": "\u091C\u0940\u0906\u0908 / \u0913\u0921\u0949\u092A \u091F\u0948\u0917",
  "passport.careLabel": "\u0926\u0947\u0916\u092D\u093E\u0932 \u0928\u093F\u0930\u094D\u0926\u0947\u0936",
  "passport.storyTitle": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0940 \u0915\u0939\u093E\u0928\u0940",
  "passport.storyUnavailable": "\u0907\u0938 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0940 \u0915\u0939\u093E\u0928\u0940 \u0905\u092D\u0940 \u0932\u093F\u0916\u0940 \u091C\u093E \u0930\u0939\u0940 \u0939\u0948\u0964",
  "passport.shareButton": "\u0938\u093E\u091D\u093E \u0915\u0930\u0947\u0902",
  "passport.shareCopied": "\u0932\u093F\u0902\u0915 \u0915\u0949\u092A\u0940 \u0939\u094B \u0917\u092F\u093E",
  "passport.printButton": "\u092A\u094D\u0930\u093F\u0902\u091F \u0915\u0930\u0947\u0902",
  "passport.scanHint": "\u0938\u094D\u0915\u0948\u0928 \u0915\u0930\u0915\u0947 \u0907\u0938 \u092A\u093E\u0938\u092A\u094B\u0930\u094D\u091F \u0915\u094B \u0911\u0928\u0932\u093E\u0907\u0928 \u0926\u0947\u0916\u0947\u0902",
  "passport.notFoundTitle": "\u092A\u093E\u0938\u092A\u094B\u0930\u094D\u091F \u0928\u0939\u0940\u0902 \u092E\u093F\u0932\u093E",
  "passport.notFoundMessage": "\u092F\u0939 \u0935\u093F\u0930\u093E\u0938\u0924 \u092A\u093E\u0938\u092A\u094B\u0930\u094D\u091F \u092E\u094C\u091C\u0942\u0926 \u0928\u0939\u0940\u0902 \u0939\u0948, \u092F\u093E \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917 \u0905\u092C \u0938\u093E\u0930\u094D\u0935\u091C\u0928\u093F\u0915 \u0928\u0939\u0940\u0902 \u0939\u0948\u0964",
  "passport.loadError": "\u0907\u0938 \u092A\u093E\u0938\u092A\u094B\u0930\u094D\u091F \u0915\u094B \u0932\u094B\u0921 \u0928\u0939\u0940\u0902 \u0915\u093F\u092F\u093E \u091C\u093E \u0938\u0915\u093E"
};

// shared/locales/kn.json
var kn_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C95\u0CC8\u0C97\u0CBE\u0CB0\u0CBF\u0C95\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB8\u0CC1\u0CB2\u0CAD\u0CB5\u0CBE\u0C97\u0CBF \u0C86\u0CA8\u0CCD\u200C\u0CB2\u0CC8\u0CA8\u0CCD\u200C\u0CA8\u0CB2\u0CCD\u0CB2\u0CBF \u0CAE\u0CBE\u0CB0\u0CBE\u0C9F \u0CAE\u0CBE\u0CA1\u0CBF.",
  "welcome.languageLabel": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAD\u0CBE\u0CB7\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0C86\u0CAF\u0CCD\u0C95\u0CC6\u0CAE\u0CBE\u0CA1\u0CBF",
  "welcome.getStarted": "\u0C86\u0CB0\u0C82\u0CAD\u0CBF\u0CB8\u0CBF",
  "language.en": "\u0C87\u0C82\u0C97\u0CCD\u0CB2\u0CBF\u0CB7\u0CCD",
  "language.hi": "\u0CB9\u0CBF\u0C82\u0CA6\u0CBF",
  "email.title": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C87\u0CAE\u0CC7\u0CB2\u0CCD \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF",
  "email.roleQuestion": "\u0CA8\u0CBE\u0CA8\u0CC1 \u0C87\u0CB2\u0CCD\u0CB2\u0CBF",
  "email.roleSell": "\u0CA8\u0CA8\u0CCD\u0CA8 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CAE\u0CBE\u0CB0\u0CBE\u0C9F\u0CBF\u0CB8\u0CBF",
  "email.roleBuy": "\u0CB9\u0CB8\u0CCD\u0CA4\u0CB6\u0CBF\u0CB2\u0CCD\u0CAA \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0C96\u0CB0\u0CC0\u0CA6\u0CBF\u0CB8\u0CBF",
  "email.label": "\u0C87\u0CAE\u0CC7\u0CB2\u0CCD \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8",
  "email.helper": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA6\u0CC3\u0CA2\u0CC0\u0C95\u0CB0\u0CBF\u0CB8\u0CB2\u0CC1 4 \u0C85\u0C82\u0C95\u0CBF\u0CAF \u0C95\u0CCB\u0CA1\u0CCD \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CC1\u0CA4\u0CCD\u0CA4\u0CC7\u0CB5\u0CC6.",
  "email.invalid": "\u0CB8\u0CB0\u0CBF\u0CAF\u0CBE\u0CA6 \u0C87\u0CAE\u0CC7\u0CB2\u0CCD \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF",
  "email.sendOtp": "\u0C95\u0CCB\u0CA1\u0CCD \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CBF",
  "email.error": "\u0C95\u0CCB\u0CA1\u0CCD \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2, \u0CA6\u0CAF\u0CB5\u0CBF\u0C9F\u0CCD\u0C9F\u0CC1 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "otp.title": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C87\u0CAE\u0CC7\u0CB2\u0CCD \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0CAA\u0CB0\u0CBF\u0CB6\u0CC0\u0CB2\u0CBF\u0CB8\u0CBF",
  "otp.subtitle": "\u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CB2\u0CBE\u0CA6 4 \u0C85\u0C82\u0C95\u0CBF\u0CAF \u0C95\u0CCB\u0CA1\u0CCD \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF",
  "otp.emailUndelivered": "\u0C87\u0CAE\u0CC7\u0CB2\u0CCD \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2. \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CA4\u0C82\u0CA1\u0CA6\u0CBF\u0C82\u0CA6 \u0CA1\u0CC6\u0CAE\u0CCA \u0C95\u0CCB\u0CA1\u0CCD \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0C95\u0CC7\u0CB3\u0CBF.",
  "otp.changeEmail": "\u0C87\u0CAE\u0CC7\u0CB2\u0CCD \u0CAC\u0CA6\u0CB2\u0CBE\u0CAF\u0CBF\u0CB8\u0CBF",
  "otp.verify": "\u0CAA\u0CB0\u0CBF\u0CB6\u0CC0\u0CB2\u0CBF\u0CB8\u0CBF",
  "otp.invalid": "\u0C8E\u0CB2\u0CCD\u0CB2\u0CBE 4 \u0C85\u0C82\u0C95\u0CBF\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF",
  "otp.wrong": "\u0CA4\u0CAA\u0CCD\u0CAA\u0CC1 OTP, \u0CA6\u0CAF\u0CB5\u0CBF\u0C9F\u0CCD\u0C9F\u0CC1 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "otp.resend": "OTP \u0CAE\u0CB0\u0CC1\u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CBF",
  "otp.resendIn": "{n} \u0CB8\u0CC6\u0C95\u0CC6\u0C82\u0CA1\u0CC1\u0C97\u0CB3\u0CB2\u0CCD\u0CB2\u0CBF OTP \u0CAE\u0CB0\u0CC1\u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CBF",
  "otp.resendError": "OTP \u0CAE\u0CB0\u0CC1\u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2, \u0CA6\u0CAF\u0CB5\u0CBF\u0C9F\u0CCD\u0C9F\u0CC1 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "camera.capture": "\u0CAB\u0CCB\u0C9F\u0CCB \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0C95\u0CCA\u0CB3\u0CCD\u0CB3\u0CBF",
  "camera.unavailable": "\u0C95\u0CCD\u0CAF\u0CBE\u0CAE\u0CC6\u0CB0\u0CBE \u0CB2\u0CAD\u0CCD\u0CAF\u0CB5\u0CBF\u0CB2\u0CCD\u0CB2, \u0CAC\u0CA6\u0CB2\u0CBF\u0C97\u0CC6 \u0CAB\u0CCB\u0C9F\u0CCB \u0C86\u0CAF\u0CCD\u0C95\u0CC6\u0CAE\u0CBE\u0CA1\u0CBF.",
  "camera.choosePhoto": "\u0CAB\u0CCB\u0C9F\u0CCB \u0C86\u0CAF\u0CCD\u0C95\u0CC6\u0CAE\u0CBE\u0CA1\u0CBF",
  "camera.retake": "\u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6",
  "camera.usePhoto": "\u0C88 \u0CAB\u0CCB\u0C9F\u0CCB \u0CAC\u0CB3\u0CB8\u0CBF",
  "camera.enhancing": "\u0CAB\u0CCB\u0C9F\u0CCB \u0CB8\u0CC1\u0CA7\u0CBE\u0CB0\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "camera.enhanceError": "\u0CAB\u0CCB\u0C9F\u0CCB\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB8\u0CC1\u0CA7\u0CBE\u0CB0\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2",
  "camera.retry": "\u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "camera.before": "\u0CAE\u0CC2\u0CB2",
  "camera.after": "\u0CB8\u0CC1\u0CA7\u0CBE\u0CB0\u0CBF\u0CA4",
  "camera.compareHint": "\u0CB9\u0CCB\u0CB2\u0CBF\u0CB8\u0CB2\u0CC1 \u0CB8\u0CCD\u0CB2\u0CC8\u0CA1\u0CB0\u0CCD \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0C8E\u0CB3\u0CC6",
  "camera.continue": "\u0CAE\u0CC1\u0C82\u0CA6\u0CC1\u0CB5\u0CB0\u0CBF\u0CB8\u0CBF",
  "studio.title": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAB\u0CCB\u0C9F\u0CCB\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB8\u0CC1\u0CA7\u0CBE\u0CB0\u0CBF\u0CB8\u0CBF",
  "studio.original": "\u0CAE\u0CC2\u0CB2",
  "studio.processed": "\u0CB8\u0C82\u0CB8\u0CCD\u0C95\u0CB0\u0CBF\u0CB8\u0CBF\u0CA6",
  "studio.removeBackground": "\u0CB9\u0CBF\u0CA8\u0CCD\u0CA8\u0CB2\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0CB9\u0CBE\u0C95\u0CBF",
  "studio.removingBackground": "\u0CB9\u0CBF\u0CA8\u0CCD\u0CA8\u0CB2\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0CB9\u0CBE\u0C95\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "studio.keepOriginalBackground": "\u0CAE\u0CC2\u0CB2 \u0CB9\u0CBF\u0CA8\u0CCD\u0CA8\u0CB2\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0C89\u0CB3\u0CBF\u0CB8\u0CBF",
  "studio.backgroundWhite": "\u0CAC\u0CBF\u0CB3\u0CBF",
  "studio.backgroundNeutral": "\u0CAE\u0CC3\u0CA6\u0CC1 \u0C95\u0CCD\u0CB0\u0CC0\u0CAE\u0CCD",
  "studio.backgroundBlur": "\u0CAE\u0CB8\u0CC1\u0C95\u0CC1",
  "studio.backgroundUnavailableNotice": "\u0CB9\u0CBF\u0CA8\u0CCD\u0CA8\u0CB2\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0CB9\u0CBE\u0C95\u0CC1\u0CB5 \u0CB8\u0CC7\u0CB5\u0CC6 \u0C88\u0C97 \u0CB2\u0CAD\u0CCD\u0CAF\u0CB5\u0CBF\u0CB2\u0CCD\u0CB2. \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAB\u0CCB\u0C9F\u0CCB \u0CAC\u0CA6\u0CB2\u0CBE\u0C97\u0CBF\u0CB2\u0CCD\u0CB2.",
  "studio.backgroundTimedOutNotice": "\u0CB9\u0CBF\u0CA8\u0CCD\u0CA8\u0CB2\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0CB9\u0CBE\u0C95\u0CC1\u0CB5\u0CB2\u0CCD\u0CB2\u0CBF \u0CB9\u0CC6\u0C9A\u0CCD\u0C9A\u0CC1 \u0CB8\u0CAE\u0CAF \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0C95\u0CCA\u0C82\u0CA1\u0CC1 \u0CAC\u0CBF\u0CA1\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6. \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAB\u0CCB\u0C9F\u0CCB \u0CAC\u0CA6\u0CB2\u0CBE\u0C97\u0CBF\u0CB2\u0CCD\u0CB2.",
  "studio.backgroundQuotaNotice": "\u0CB9\u0CBF\u0CA8\u0CCD\u0CA8\u0CB2\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0CB9\u0CBE\u0C95\u0CC1\u0CB5 \u0CAE\u0CBF\u0CA4\u0CBF\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA4\u0CB2\u0CC1\u0CAA\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6. \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAB\u0CCB\u0C9F\u0CCB \u0CAC\u0CA6\u0CB2\u0CBE\u0C97\u0CBF\u0CB2\u0CCD\u0CB2.",
  "studio.backgroundFailedNotice": "\u0CB9\u0CBF\u0CA8\u0CCD\u0CA8\u0CB2\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0CB9\u0CBE\u0C95\u0CC1\u0CB5\u0CBF\u0C95\u0CC6 \u0CB5\u0CBF\u0CAB\u0CB2\u0CB5\u0CBE\u0C97\u0CBF\u0CA6\u0CC6. \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAB\u0CCB\u0C9F\u0CCB \u0CAC\u0CA6\u0CB2\u0CBE\u0C97\u0CBF\u0CB2\u0CCD\u0CB2.",
  "studio.brightness": "\u0CAC\u0CC6\u0CB3\u0C95\u0CC1",
  "studio.contrast": "\u0CB5\u0CBF\u0CB0\u0CCB\u0CA7",
  "studio.sharpen": "\u0CA4\u0CC0\u0C95\u0CCD\u0CB7\u0CCD\u0CA3\u0C97\u0CCA\u0CB3\u0CBF\u0CB8\u0CBF",
  "studio.autoLighting": "\u0CB8\u0CCD\u0CB5\u0CAF\u0C82 \u0CAC\u0CC6\u0CB3\u0C95\u0CC1",
  "studio.crop": "\u0C95\u0CA4\u0CCD\u0CA4\u0CB0\u0CBF\u0CB8\u0CBF",
  "studio.cropOriginal": "\u0CAE\u0CC2\u0CB2",
  "studio.cropSquare": "\u0C9A\u0CCC\u0C95",
  "studio.cropPortrait": "\u0CAA\u0CCB\u0CB0\u0CCD\u0C9F\u0CCD\u0CB0\u0CC7\u0C9F\u0CCD",
  "studio.accept": "\u0C88 \u0CAB\u0CCB\u0C9F\u0CCB \u0CAC\u0CB3\u0CB8\u0CBF",
  "studio.retake": "\u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0C95\u0CCA\u0CB3\u0CCD\u0CB3\u0CBF",
  "studio.finalizing": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CB8\u0C82\u0CAA\u0CBE\u0CA6\u0CA8\u0CC6\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0C85\u0CA8\u0CCD\u0CB5\u0CAF\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "studio.on": "\u0C86\u0CA8\u0CCD",
  "studio.off": "\u0C86\u0CAB\u0CCD",
  "category.title": "\u0CA8\u0CC0\u0CB5\u0CC1 \u0C8F\u0CA8\u0CC1 \u0CAE\u0CBE\u0CB0\u0CBE\u0C9F \u0CAE\u0CBE\u0CA1\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CCD\u0CA6\u0CC0\u0CB0\u0CBF?",
  "category.continue": "\u0CAE\u0CC1\u0C82\u0CA6\u0CC1\u0CB5\u0CB0\u0CBF\u0CB8\u0CBF",
  "category.materialQuestion": "\u0C87\u0CA6\u0CC1 \u0CAF\u0CBE\u0CB5 \u0CB5\u0CB8\u0CCD\u0CA4\u0CC1\u0CB5\u0CBF\u0CA8\u0CBF\u0C82\u0CA6? (\u0C90\u0C9A\u0CCD\u0C9B\u0CBF\u0C95)",
  "category.textiles": "\u0CAC\u0C9F\u0CCD\u0C9F\u0CC6\u0C97\u0CB3\u0CC1",
  "category.pottery": "\u0CAE\u0CA3\u0CCD\u0CA3\u0CBF\u0CA8 \u0CAA\u0CBE\u0CA4\u0CCD\u0CB0\u0CC6\u0C97\u0CB3\u0CC1",
  "category.jewelry": "\u0C86\u0CAD\u0CB0\u0CA3\u0C97\u0CB3\u0CC1",
  "category.woodwork": "\u0CAE\u0CB0 \u0C95\u0CC6\u0CB2\u0CB8",
  "category.bambooCane": "\u0CAC\u0CBE\u0C82\u0CAC\u0CC1 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC1 \u0C95\u0CAC\u0CCD\u0CAC\u0CC1",
  "category.other": "\u0C87\u0CA4\u0CB0",
  "voice.tapToRecord": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CA6 \u0CB5\u0CBF\u0CB5\u0CB0\u0CA3\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA6\u0CBE\u0C96\u0CB2\u0CBF\u0CB8\u0CB2\u0CC1 \u0C9F\u0CCD\u0CAF\u0CBE\u0CAA\u0CCD \u0CAE\u0CBE\u0CA1\u0CBF",
  "voice.recording": "\u0CA6\u0CBE\u0C96\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "voice.stop": "\u0CA6\u0CBE\u0C96\u0CB2\u0CC6 \u0CA8\u0CBF\u0CB2\u0CCD\u0CB2\u0CBF\u0CB8\u0CBF",
  "voice.record": "\u0CA6\u0CBE\u0C96\u0CB2\u0CC6",
  "voice.reviewRecording": "\u0C86\u0CB2\u0CBF\u0CB8\u0CBF, \u0CA8\u0C82\u0CA4\u0CB0 \u0CAE\u0CC1\u0C82\u0CA6\u0CC1\u0CB5\u0CB0\u0CBF\u0CB8\u0CBF \u0C85\u0CA5\u0CB5\u0CBE \u0CAE\u0CB0\u0CC1 \u0CA6\u0CBE\u0C96\u0CB2\u0CBF\u0CB8\u0CBF.",
  "voice.reRecord": "\u0CAE\u0CB0\u0CC1 \u0CA6\u0CBE\u0C96\u0CB2\u0CBF\u0CB8\u0CBF",
  "voice.continue": "\u0CAE\u0CC1\u0C82\u0CA6\u0CC1\u0CB5\u0CB0\u0CBF\u0CB8\u0CBF",
  "describe.transcribing": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CB5\u0CBF\u0CB5\u0CB0\u0CA3\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0C85\u0CB0\u0CCD\u0CA5\u0CAE\u0CBE\u0CA1\u0CBF\u0C95\u0CCA\u0CB3\u0CCD\u0CB3\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "describe.transcribeError": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CB5\u0CBF\u0CB5\u0CB0\u0CA3\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0C85\u0CB0\u0CCD\u0CA5\u0CAE\u0CBE\u0CA1\u0CBF\u0C95\u0CCA\u0CB3\u0CCD\u0CB3\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2",
  "describe.retry": "\u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "describe.reviewHint": "\u0C85\u0C97\u0CA4\u0CCD\u0CAF\u0CB5\u0CBF\u0CA6\u0CCD\u0CA6\u0CB0\u0CC6 \u0CAA\u0CB0\u0CBF\u0CB6\u0CC0\u0CB2\u0CBF\u0CB8\u0CBF \u0CAE\u0CA4\u0CCD\u0CA4\u0CC1 \u0CB8\u0C82\u0CAA\u0CBE\u0CA6\u0CBF\u0CB8\u0CBF",
  "describe.fallbackNote": "\u0CAE\u0CC8\u0C95\u0CCD\u0CB0\u0CCB\u0CAB\u0CCB\u0CA8\u0CCD \u0CB2\u0CAD\u0CCD\u0CAF\u0CB5\u0CBF\u0CB2\u0CCD\u0CB2, \u0CAC\u0CA6\u0CB2\u0CBF\u0C97\u0CC6 \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CB5\u0CBF\u0CB5\u0CB0\u0CA3\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0C9F\u0CC8\u0CAA\u0CCD \u0CAE\u0CBE\u0CA1\u0CBF.",
  "describe.placeholderEn": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0C87\u0C82\u0C97\u0CCD\u0CB2\u0CBF\u0CB7\u0CCD\u200C\u0CA8\u0CB2\u0CCD\u0CB2\u0CBF \u0CB5\u0CBF\u0CB5\u0CB0\u0CBF\u0CB8\u0CBF",
  "describe.continue": "\u0CAE\u0CC1\u0C82\u0CA6\u0CC1\u0CB5\u0CB0\u0CBF\u0CB8\u0CBF",
  "pricing.title": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CA6 \u0CAC\u0CC6\u0CB2\u0CC6 \u0CA8\u0CBF\u0C97\u0CA6\u0CBF\u0CAA\u0CA1\u0CBF\u0CB8\u0CBF",
  "pricing.summaryEdit": "\u0CB8\u0C82\u0CAA\u0CBE\u0CA6\u0CBF\u0CB8\u0CBF",
  "pricing.materialCostLabel": "\u0CB5\u0CB8\u0CCD\u0CA4\u0CC1 \u0CB5\u0CC6\u0C9A\u0CCD\u0C9A",
  "pricing.materialCostHelper": "\u0CB0\u0CC2\u0CAA\u0CBE\u0CAF\u0CBF\u0C97\u0CB3\u0CB2\u0CCD\u0CB2\u0CBF \u0C95\u0C9A\u0CCD\u0C9A\u0CBE \u0CB5\u0CB8\u0CCD\u0CA4\u0CC1\u0C97\u0CB3 \u0CAE\u0CC7\u0CB2\u0CC6 \u0CA8\u0CC0\u0CB5\u0CC1 \u0C96\u0CB0\u0CCD\u0C9A\u0CC1 \u0CAE\u0CBE\u0CA1\u0CBF\u0CA6 \u0CAE\u0CCA\u0CA4\u0CCD\u0CA4\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF.",
  "pricing.materialCostInvalid": "0 \u0C95\u0CCD\u0C95\u0CBF\u0C82\u0CA4 \u0CB9\u0CC6\u0C9A\u0CCD\u0C9A\u0CC1 \u0CB5\u0CB8\u0CCD\u0CA4\u0CC1 \u0CB5\u0CC6\u0C9A\u0CCD\u0C9A\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF.",
  "pricing.getSuggestion": "\u0CAC\u0CC6\u0CB2\u0CC6 \u0CB8\u0CC2\u0C9A\u0CA8\u0CC6 \u0CAA\u0CA1\u0CC6\u0CAF\u0CBF\u0CB0\u0CBF",
  "pricing.suggestError": "\u0CAC\u0CC6\u0CB2\u0CC6 \u0CB8\u0CC2\u0C9A\u0CA8\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CAA\u0CA1\u0CC6\u0CAF\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2",
  "pricing.retry": "\u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "pricing.rangeLabel": "\u0CB8\u0CC2\u0C9A\u0CBF\u0CA4 \u0CAC\u0CC6\u0CB2\u0CC6 \u0CB5\u0CCD\u0CAF\u0CBE\u0CAA\u0CCD\u0CA4\u0CBF",
  "pricing.sellingPriceLabel": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAE\u0CBE\u0CB0\u0CBE\u0C9F \u0CAC\u0CC6\u0CB2\u0CC6",
  "pricing.sellingPriceNote": "\u0C87\u0CA6\u0CC1 \u0CB8\u0CC2\u0C9A\u0CA8\u0CC6 \u0CAE\u0CBE\u0CA4\u0CCD\u0CB0, \u0CA8\u0CC0\u0CB5\u0CC1 \u0C87\u0CB7\u0CCD\u0C9F\u0CA6 \u0CAF\u0CBE\u0CB5\u0CC1\u0CA6\u0CC7 \u0CAC\u0CC6\u0CB2\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CBF\u0C97\u0CA6\u0CBF\u0CAA\u0CA1\u0CBF\u0CB8\u0CAC\u0CB9\u0CC1\u0CA6\u0CC1.",
  "pricing.sellingPriceInvalid": "0 \u0C95\u0CCD\u0C95\u0CBF\u0C82\u0CA4 \u0CB9\u0CC6\u0C9A\u0CCD\u0C9A\u0CC1 \u0CAE\u0CBE\u0CB0\u0CBE\u0C9F \u0CAC\u0CC6\u0CB2\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF.",
  "pricing.publish": "\u0CAA\u0CCD\u0CB0\u0C95\u0C9F\u0CBF\u0CB8\u0CBF",
  "pricing.publishError": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CAA\u0CCD\u0CB0\u0C95\u0C9F\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2",
  "pricing.successTitle": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8 \u0C88\u0C97 \u0CB2\u0CC8\u0CB5\u0CCD \u0C86\u0C97\u0CBF\u0CA6\u0CC6!",
  "pricing.successMessage": "\u0C96\u0CB0\u0CC0\u0CA6\u0CBF\u0CA6\u0CBE\u0CB0\u0CB0\u0CC1 \u0C88\u0C97 \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C85\u0C82\u0C97\u0CA1\u0CBF\u0CAF\u0CB2\u0CCD\u0CB2\u0CBF \u0C87\u0CA6\u0CA8\u0CCD\u0CA8\u0CC1 \u0C95\u0C82\u0CA1\u0CC1\u0CB9\u0CBF\u0CA1\u0CBF\u0CAF\u0CAC\u0CB9\u0CC1\u0CA6\u0CC1.",
  "pricing.viewShop": "\u0CA8\u0CA8\u0CCD\u0CA8 \u0C85\u0C82\u0C97\u0CA1\u0CBF\u0CAF\u0CB2\u0CCD\u0CB2\u0CBF \u0CA8\u0CCB\u0CA1\u0CBF",
  "home.title": "\u0CA8\u0CA8\u0CCD\u0CA8 \u0C85\u0C82\u0C97\u0CA1\u0CBF",
  "home.gemBannerTitle": "GeM / ONDC \u0C97\u0CC6 \u0CB8\u0C82\u0CAA\u0CB0\u0CCD\u0C95\u0CBF\u0CB8\u0CBF",
  "home.gemBannerBadge": "\u0CB6\u0CC0\u0C98\u0CCD\u0CB0\u0CA6\u0CB2\u0CCD\u0CB2\u0CC7",
  "home.gemBannerMessage": "\u0C88 \u0CB8\u0C82\u0CAF\u0CCB\u0C9C\u0CA8\u0CC6 \u0CB6\u0CC0\u0C98\u0CCD\u0CB0\u0CA6\u0CB2\u0CCD\u0CB2\u0CC7 \u0CAC\u0CB0\u0CC1\u0CA4\u0CCD\u0CA4\u0CA6\u0CC6.",
  "home.loading": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB2\u0CCB\u0CA1\u0CCD \u0CAE\u0CBE\u0CA1\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "home.loadError": "\u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB2\u0CCB\u0CA1\u0CCD \u0CAE\u0CBE\u0CA1\u0CB2\u0CC1 \u0CB8\u0CBE\u0CA7\u0CCD\u0CAF\u0CB5\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2",
  "home.retry": "\u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "home.emptyTitle": "\u0C87\u0CA8\u0CCD\u0CA8\u0CC2 \u0CAF\u0CBE\u0CB5\u0CC1\u0CA6\u0CC7 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CBF\u0CB2\u0CCD\u0CB2",
  "home.emptyMessage": "KalaSetu \u0CA8\u0CB2\u0CCD\u0CB2\u0CBF \u0CAE\u0CBE\u0CB0\u0CBE\u0C9F \u0CAA\u0CCD\u0CB0\u0CBE\u0CB0\u0C82\u0CAD\u0CBF\u0CB8\u0CB2\u0CC1 \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAE\u0CCA\u0CA6\u0CB2 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB8\u0CC7\u0CB0\u0CBF\u0CB8\u0CBF.",
  "home.addFirstProduct": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAE\u0CCA\u0CA6\u0CB2 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB8\u0CC7\u0CB0\u0CBF\u0CB8\u0CBF",
  "home.statusPublished": "\u0CAA\u0CCD\u0CB0\u0C95\u0C9F\u0CBF\u0CA4",
  "home.statusDraft": "\u0C95\u0CB0\u0CA1\u0CC1",
  "home.statusFailed": "\u0CB5\u0CBF\u0CAB\u0CB2",
  "home.detailCategory": "\u0CB5\u0CB0\u0CCD\u0C97",
  "home.detailEdit": "\u0CB8\u0C82\u0CAA\u0CBE\u0CA6\u0CBF\u0CB8\u0CBF",
  "home.detailDelete": "\u0C85\u0CB3\u0CBF\u0CB8\u0CBF",
  "home.detailClose": "\u0CAE\u0CC1\u0C9A\u0CCD\u0C9A\u0CC1",
  "home.editPriceLabel": "\u0CAC\u0CC6\u0CB2\u0CC6",
  "home.editDescriptionLabel": "\u0CB5\u0CBF\u0CB5\u0CB0\u0CA3\u0CC6",
  "home.editSave": "\u0CAC\u0CA6\u0CB2\u0CBE\u0CB5\u0CA3\u0CC6\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0C89\u0CB3\u0CBF\u0CB8\u0CBF",
  "home.editCancel": "\u0CB0\u0CA6\u0CCD\u0CA6\u0CC1",
  "home.editPriceInvalid": "0 \u0C95\u0CCD\u0C95\u0CBF\u0C82\u0CA4 \u0CB9\u0CC6\u0C9A\u0CCD\u0C9A\u0CC1 \u0CAC\u0CC6\u0CB2\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CAE\u0CC2\u0CA6\u0CBF\u0CB8\u0CBF",
  "home.editDescriptionRequired": "\u0CB5\u0CBF\u0CB5\u0CB0\u0CA3\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CAF\u0CBE\u0CB5\u0CC1\u0CA6\u0CC7 \u0CAD\u0CBE\u0CB7\u0CC6\u0CAF\u0CB2\u0CCD\u0CB2\u0CBF \u0C96\u0CBE\u0CB2\u0CBF \u0CAC\u0CBF\u0CA1\u0CB2\u0CBE\u0C97\u0CC1\u0CB5\u0CC1\u0CA6\u0CBF\u0CB2\u0CCD\u0CB2",
  "home.editError": "\u0CAC\u0CA6\u0CB2\u0CBE\u0CB5\u0CA3\u0CC6\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0C89\u0CB3\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2, \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "home.deleteConfirm": "\u0C88 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0C85\u0CB3\u0CBF\u0CB8\u0CAC\u0CC7\u0C95\u0CC7? \u0CB9\u0CBF\u0C82\u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0C95\u0CCA\u0CB3\u0CCD\u0CB3\u0CB2\u0CBE\u0C97\u0CC1\u0CB5\u0CC1\u0CA6\u0CBF\u0CB2\u0CCD\u0CB2.",
  "home.deleteConfirmYes": "\u0CB9\u0CCC\u0CA6\u0CC1, \u0C85\u0CB3\u0CBF\u0CB8\u0CBF",
  "home.deleteError": "\u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0C85\u0CB3\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2, \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "profile.title": "\u0CAA\u0CCD\u0CB0\u0CCA\u0CAB\u0CC8\u0CB2\u0CCD",
  "profile.emailLabel": "\u0C87\u0CAE\u0CC7\u0CB2\u0CCD \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8",
  "profile.emailUnknown": "\u0CB2\u0CAD\u0CCD\u0CAF\u0CB5\u0CBF\u0CB2\u0CCD\u0CB2",
  "profile.loading": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAA\u0CCD\u0CB0\u0CCA\u0CAB\u0CC8\u0CB2\u0CCD \u0CB2\u0CCB\u0CA1\u0CCD \u0C86\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "profile.loadError": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAA\u0CCD\u0CB0\u0CCA\u0CAB\u0CC8\u0CB2\u0CCD \u0CB2\u0CCB\u0CA1\u0CCD \u0C86\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2",
  "profile.displayNameLabel": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CB9\u0CC6\u0CB8\u0CB0\u0CC1",
  "profile.shopNameLabel": "\u0C85\u0C82\u0C97\u0CA1\u0CBF \u0CB9\u0CC6\u0CB8\u0CB0\u0CC1",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u0CAA\u0CCD\u0CB0\u0CCA\u0CAB\u0CC8\u0CB2\u0CCD \u0C89\u0CB3\u0CBF\u0CB8\u0CBF",
  "profile.saved": "\u0CAA\u0CCD\u0CB0\u0CCA\u0CAB\u0CC8\u0CB2\u0CCD \u0C89\u0CB3\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6",
  "profile.saveError": "\u0CAA\u0CCD\u0CB0\u0CCA\u0CAB\u0CC8\u0CB2\u0CCD \u0C89\u0CB3\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2, \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "profile.logout": "\u0CB2\u0CBE\u0C97\u0CCD \u0C94\u0C9F\u0CCD",
  "install.message": "\u0CA4\u0CCD\u0CB5\u0CB0\u0CBF\u0CA4 \u0CAA\u0CCD\u0CB0\u0CB5\u0CC7\u0CB6\u0C95\u0CCD\u0C95\u0CBE\u0C97\u0CBF KalaSetu \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB8\u0CCD\u0CA5\u0CBE\u0CAA\u0CBF\u0CB8\u0CBF",
  "install.action": "\u0CB8\u0CCD\u0CA5\u0CBE\u0CAA\u0CBF\u0CB8\u0CBF",
  "install.dismiss": "\u0CAE\u0CC1\u0C9A\u0CCD\u0C9A\u0CC1",
  "offline.message": "\u0C86\u0CAB\u0CCD\u200C\u0CB2\u0CC8\u0CA8\u0CCD \u0C86\u0C97\u0CBF\u0CA6\u0CCD\u0CA6\u0CC0\u0CB0\u0CBF, \u0C95\u0CC6\u0CB2\u0CB5\u0CC1 \u0CB5\u0CC8\u0CB6\u0CBF\u0CB7\u0CCD\u0C9F\u0CCD\u0CAF\u0C97\u0CB3\u0CC1 \u0C95\u0CC6\u0CB2\u0CB8 \u0CAE\u0CBE\u0CA1\u0CA6\u0CBF\u0CB0\u0CAC\u0CB9\u0CC1\u0CA6\u0CC1",
  "welcome.languageHint": "\u0C88 \u0CAD\u0CBE\u0CB7\u0CC6\u0CAF\u0CB2\u0CCD\u0CB2\u0CBF \u0CB8\u0C82\u0CAA\u0CC2\u0CB0\u0CCD\u0CA3 \u0C85\u0CAA\u0CCD\u0CB2\u0CBF\u0C95\u0CC7\u0CB6\u0CA8\u0CCD \u0C87\u0CB0\u0CC1\u0CA4\u0CCD\u0CA4\u0CA6\u0CC6.",
  "welcome.regionalLanguages": "\u0CAD\u0CBE\u0CB0\u0CA4\u0CC0\u0CAF \u0CAD\u0CBE\u0CB7\u0CC6\u0C97\u0CB3\u0CC1",
  "describe.localTab": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAD\u0CBE\u0CB7\u0CC6",
  "describe.placeholderLocal": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CB8\u0CCD\u0CB5\u0C82\u0CA4 \u0CAD\u0CBE\u0CB7\u0CC6\u0CAF\u0CB2\u0CCD\u0CB2\u0CBF \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB5\u0CBF\u0CB5\u0CB0\u0CBF\u0CB8\u0CBF",
  "describe.syncing": "\u0C87\u0CA8\u0CCD\u0CA8\u0CCA\u0C82\u0CA6\u0CC1 \u0CAD\u0CBE\u0CB7\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CB5\u0CC0\u0C95\u0CB0\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "describe.syncFailed": "\u0C87\u0CA8\u0CCD\u0CA8\u0CCA\u0C82\u0CA6\u0CC1 \u0CAD\u0CBE\u0CB7\u0CC6\u0CAF\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CB5\u0CC0\u0C95\u0CB0\u0CBF\u0CB8\u0CB2\u0CC1 \u0CB8\u0CBE\u0CA7\u0CCD\u0CAF\u0CB5\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2. \u0C85\u0C97\u0CA4\u0CCD\u0CAF\u0CB5\u0CBF\u0CA6\u0CCD\u0CA6\u0CB0\u0CC6 \u0CB8\u0CCD\u0CB5\u0CA4\u0C83 \u0CB8\u0C82\u0CAA\u0CBE\u0CA6\u0CBF\u0CB8\u0CBF.",
  "describe.syncHint": "\u0CB8\u0C82\u0CAA\u0CBE\u0CA6\u0CA8\u0CC6\u0C97\u0CB3\u0CC1 \u0CB8\u0CCD\u0CB5\u0CAF\u0C82\u0C9A\u0CBE\u0CB2\u0CBF\u0CA4\u0CB5\u0CBE\u0C97\u0CBF \u0C87\u0CA8\u0CCD\u0CA8\u0CCA\u0C82\u0CA6\u0CC1 \u0CAD\u0CBE\u0CB7\u0CC6\u0C97\u0CC6 \u0CA8\u0C95\u0CB2\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CB5\u0CC6.",
  "pricing.updating": "\u0CB9\u0CCA\u0CB8 \u0CB5\u0CB8\u0CCD\u0CA4\u0CC1 \u0CB5\u0CC6\u0C9A\u0CCD\u0C9A\u0C95\u0CCD\u0C95\u0CC6 \u0CA8\u0CB5\u0CC0\u0C95\u0CB0\u0CA3 \u0CA8\u0CA1\u0CC6\u0CAF\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0C95\u0CCD\u0CAF\u0CBE\u0C9F\u0CB2\u0CBE\u0C97\u0CCD \u0CB0\u0CAB\u0CCD\u0CA4\u0CC1 (ONDC \u0CAB\u0CBE\u0CB0\u0CCD\u0CAE\u0CBE\u0C9F\u0CCD)",
  "home.exportCatalogNote": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CAA\u0CCD\u0CB0\u0C95\u0C9F\u0CBF\u0CA4 \u0CAA\u0C9F\u0CCD\u0C9F\u0CBF\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 ONDC \u0CB0\u0CBF\u0C9F\u0CC7\u0CB2\u0CCD \u0C95\u0CCD\u0CAF\u0CBE\u0C9F\u0CB2\u0CBE\u0C97\u0CCD \u0CB0\u0C9A\u0CA8\u0CC6\u0C97\u0CC6 \u0CA8\u0C95\u0CCD\u0CB7\u0CC6\u0C97\u0CCA\u0CB3\u0CBF\u0CB8\u0CBF \u0CA1\u0CCC\u0CA8\u0CCD\u200C\u0CB2\u0CCB\u0CA1\u0CCD \u0CAE\u0CBE\u0CA1\u0CC1\u0CA4\u0CCD\u0CA4\u0CA6\u0CC6. \u0C8F\u0C95\u0CC0\u0C95\u0CB0\u0CA3\u0C95\u0CCD\u0C95\u0CC6 \u0CB8\u0CBF\u0CA6\u0CCD\u0CA7: \u0CA8\u0C95\u0CCD\u0CB7\u0CC6 \u0CAA\u0CC2\u0CB0\u0CCD\u0CA3\u0CB5\u0CBE\u0C97\u0CBF\u0CA6\u0CC6, \u0CA8\u0CC6\u0C9F\u0CCD\u200C\u0CB5\u0CB0\u0CCD\u0C95\u0CCD\u200C\u0CA8\u0CB2\u0CCD\u0CB2\u0CBF \u0CB2\u0CC8\u0CB5\u0CCD \u0C86\u0C97\u0CB2\u0CC1 \u0C87\u0CA8\u0CCD\u0CA8\u0CC2 ONDC \u0CA8\u0CCB\u0C82\u0CA6\u0CA3\u0CBF \u0C85\u0C97\u0CA4\u0CCD\u0CAF.",
  "home.exportOndcSingle": "\u0C88 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB0\u0CAB\u0CCD\u0CA4\u0CC1 (ONDC \u0CAB\u0CBE\u0CB0\u0CCD\u0CAE\u0CBE\u0C9F\u0CCD)",
  "profile.relocalising": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0C88 \u0CAD\u0CBE\u0CB7\u0CC6\u0C97\u0CC6 \u0CA8\u0CB5\u0CC0\u0C95\u0CB0\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "profile.relocalised": "{n} \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0C88 \u0CAD\u0CBE\u0CB7\u0CC6\u0C97\u0CC6 \u0CA8\u0CB5\u0CC0\u0C95\u0CB0\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6.",
  "profile.relocaliseFailed": "\u0C95\u0CC6\u0CB2\u0CB5\u0CC1 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CB5\u0CC0\u0C95\u0CB0\u0CBF\u0CB8\u0CB2\u0CC1 \u0CB8\u0CBE\u0CA7\u0CCD\u0CAF\u0CB5\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2. \u0CA8\u0C82\u0CA4\u0CB0 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF.",
  "marketplace.navBrowse": "\u0CAC\u0CCD\u0CB0\u0CCC\u0CB8\u0CCD",
  "marketplace.navProfile": "\u0CAA\u0CCD\u0CB0\u0CCA\u0CAB\u0CC8\u0CB2\u0CCD",
  "marketplace.browseTitle": "\u0CAE\u0CBE\u0CB0\u0CC1\u0C95\u0C9F\u0CCD\u0C9F\u0CC6",
  "marketplace.searchPlaceholder": "\u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB9\u0CC1\u0CA1\u0CC1\u0C95\u0CBF...",
  "marketplace.filtersTitle": "\u0CAB\u0CBF\u0CB2\u0CCD\u0C9F\u0CB0\u0CCD\u200C\u0C97\u0CB3\u0CC1",
  "marketplace.filtersClear": "\u0C8E\u0CB2\u0CCD\u0CB2\u0CBE \u0CA4\u0CC6\u0CB0\u0CB5\u0CC1\u0C97\u0CCA\u0CB3\u0CBF\u0CB8\u0CBF",
  "marketplace.filterAll": "\u0C8E\u0CB2\u0CCD\u0CB2\u0CBE",
  "marketplace.filterMaterial": "\u0CB5\u0CB8\u0CCD\u0CA4\u0CC1",
  "marketplace.filterRegion": "\u0CAA\u0CCD\u0CB0\u0CA6\u0CC7\u0CB6",
  "marketplace.filterPrice": "\u0CAC\u0CC6\u0CB2\u0CC6 \u0CB5\u0CCD\u0CAF\u0CBE\u0CAA\u0CCD\u0CA4\u0CBF (\u20B9)",
  "marketplace.filterPriceMin": "\u0C95\u0CA8\u0CBF\u0CB7\u0CCD\u0C9F",
  "marketplace.filterPriceMax": "\u0C97\u0CB0\u0CBF\u0CB7\u0CCD\u0CA0",
  "marketplace.sortLabel": "\u0CB5\u0CBF\u0C82\u0C97\u0CA1\u0CBF\u0CB8\u0CBF",
  "marketplace.sortNewest": "\u0CB9\u0CCA\u0CB8\u0CA6\u0CC1 \u0CAE\u0CCA\u0CA6\u0CB2\u0CBF\u0C97\u0CC6",
  "marketplace.sortPriceAsc": "\u0CAC\u0CC6\u0CB2\u0CC6: \u0C95\u0CA1\u0CBF\u0CAE\u0CC6 \u0CB0\u0CBF\u0C82\u0CA6 \u0CB9\u0CC6\u0C9A\u0CCD\u0C9A\u0CC1",
  "marketplace.sortPriceDesc": "\u0CAC\u0CC6\u0CB2\u0CC6: \u0CB9\u0CC6\u0C9A\u0CCD\u0C9A\u0CC1 \u0CB0\u0CBF\u0C82\u0CA6 \u0C95\u0CA1\u0CBF\u0CAE\u0CC6",
  "marketplace.resultCount": "{n} \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CC1 \u0C95\u0C82\u0CA1\u0CC1\u0CAC\u0C82\u0CA6\u0CBF\u0CB5\u0CC6",
  "marketplace.loadMore": "\u0C87\u0CA8\u0CCD\u0CA8\u0CB7\u0CCD\u0C9F\u0CC1 \u0CB2\u0CCB\u0CA1\u0CCD \u0CAE\u0CBE\u0CA1\u0CBF",
  "marketplace.loadError": "\u0CAE\u0CBE\u0CB0\u0CCD\u0C95\u0CC6\u0C9F\u0CCD\u200C\u0CAA\u0CCD\u0CB2\u0CC7\u0CB8\u0CCD \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB2\u0CCB\u0CA1\u0CCD \u0CAE\u0CBE\u0CA1\u0CB2\u0CC1 \u0CB8\u0CBE\u0CA7\u0CCD\u0CAF\u0CB5\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2, \u0CA6\u0CAF\u0CB5\u0CBF\u0C9F\u0CCD\u0C9F\u0CC1 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "marketplace.emptyTitle": "\u0C88 \u0CAB\u0CBF\u0CB2\u0CCD\u0C9F\u0CB0\u0CCD\u200C\u0C97\u0CB3\u0CBF\u0C97\u0CC6 \u0CAF\u0CBE\u0CB5\u0CC1\u0CA6\u0CC7 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CC1 \u0CB9\u0CCA\u0C82\u0CA6\u0CBF\u0C95\u0CC6\u0CAF\u0CBE\u0C97\u0CC1\u0CB5\u0CC1\u0CA6\u0CBF\u0CB2\u0CCD\u0CB2",
  "marketplace.emptyFiltered": "\u0CAB\u0CBF\u0CB2\u0CCD\u0C9F\u0CB0\u0CCD \u0C85\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA4\u0CC6\u0CB0\u0CB5\u0CC1\u0C97\u0CCA\u0CB3\u0CBF\u0CB8\u0CBF \u0C85\u0CA5\u0CB5\u0CBE \u0CAC\u0CC7\u0CB0\u0CC6 \u0C8F\u0CA8\u0CA8\u0CCD\u0CA8\u0CBE\u0CA6\u0CB0\u0CC2 \u0CB9\u0CC1\u0CA1\u0CC1\u0C95\u0CBF.",
  "marketplace.emptyNoProducts": "\u0C87\u0CA8\u0CCD\u0CA8\u0CC2 \u0CAF\u0CBE\u0CB5\u0CC1\u0CA6\u0CC7 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CC1 \u0CAA\u0CCD\u0CB0\u0C95\u0C9F\u0CB5\u0CBE\u0C97\u0CBF\u0CB2\u0CCD\u0CB2. \u0CAC\u0CC7\u0C97\u0CA8\u0CC6 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CB0\u0CBF\u0CB6\u0CC0\u0CB2\u0CBF\u0CB8\u0CBF.",
  "marketplace.artisanUnnamed": "KalaSetu \u0C95\u0CB2\u0CBE\u0C95\u0CBE\u0CB0",
  "marketplace.backToBrowse": "\u0CAE\u0CBE\u0CB0\u0CC1\u0C95\u0C9F\u0CCD\u0C9F\u0CC6\u0C97\u0CC6 \u0CB9\u0CBF\u0C82\u0CA4\u0CBF\u0CB0\u0CC1\u0C97\u0CBF",
  "marketplace.detailNotFoundTitle": "\u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8 \u0C95\u0C82\u0CA1\u0CC1\u0CAC\u0C82\u0CA6\u0CBF\u0CB2\u0CCD\u0CB2",
  "marketplace.detailNotFoundMessage": "\u0C88 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA4\u0CC6\u0C97\u0CC6\u0CA6\u0CC1\u0CB9\u0CBE\u0C95\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 \u0C85\u0CA5\u0CB5\u0CBE \u0C87\u0CA8\u0CCD\u0CA8\u0CBF\u0CB2\u0CCD\u0CB2.",
  "marketplace.artisanSummaryTitle": "\u0C95\u0CB2\u0CBE\u0C95\u0CBE\u0CB0\u0CB0 \u0CAC\u0C97\u0CCD\u0C97\u0CC6",
  "marketplace.artisanProductCount": "{n} \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CC1 KalaSetu \u0CA8\u0CB2\u0CCD\u0CB2\u0CBF \u0CAA\u0C9F\u0CCD\u0C9F\u0CBF\u0CAF\u0CBE\u0C97\u0CBF\u0CA6\u0CC6",
  "marketplace.inquiryTitle": "\u0C88 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0CA6\u0CB2\u0CCD\u0CB2\u0CBF \u0C86\u0CB8\u0C95\u0CCD\u0CA4\u0CBF \u0C87\u0CA6\u0CC6\u0CAF\u0CC7?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0C95\u0CB2\u0CBE\u0C95\u0CBE\u0CB0\u0CB0\u0CBF\u0C97\u0CC6 \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0C85\u0C97\u0CA4\u0CCD\u0CAF\u0CB5\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA4\u0CBF\u0CB3\u0CBF\u0CB8\u0CBF: \u0CAA\u0CCD\u0CB0\u0CAE\u0CBE\u0CA3, \u0C95\u0CB8\u0CCD\u0C9F\u0CAE\u0CC8\u0CB8\u0CCD, \u0CB5\u0CBF\u0CA4\u0CB0\u0CA3\u0CBE \u0CB8\u0CAE\u0CAF...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0CB5\u0CBF\u0C9A\u0CBE\u0CB0\u0CA3\u0CC6 \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CBF",
  "marketplace.inquirySent": "\u0CA8\u0CBF\u0CAE\u0CCD\u0CAE \u0CB5\u0CBF\u0C9A\u0CBE\u0CB0\u0CA3\u0CC6 \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6. \u0C95\u0CB2\u0CBE\u0C95\u0CBE\u0CB0\u0CBF \u0CA8\u0CBF\u0CAE\u0CCD\u0CAE\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB8\u0C82\u0CAA\u0CB0\u0CCD\u0C95\u0CBF\u0CB8\u0CC1\u0CA4\u0CCD\u0CA4\u0CBE\u0CB0\u0CC6.",
  "marketplace.inquiryError": "\u0CB5\u0CBF\u0C9A\u0CBE\u0CB0\u0CA3\u0CC6 \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2, \u0CA6\u0CAF\u0CB5\u0CBF\u0C9F\u0CCD\u0C9F\u0CC1 \u0CAE\u0CA4\u0CCD\u0CA4\u0CC6 \u0CAA\u0CCD\u0CB0\u0CAF\u0CA4\u0CCD\u0CA8\u0CBF\u0CB8\u0CBF",
  "marketplace.regionLabel": "\u0CAA\u0CCD\u0CB0\u0CA6\u0CC7\u0CB6",
  "marketplace.regionUnspecified": "\u0CA8\u0CBF\u0CB0\u0CCD\u0CA6\u0CBF\u0CB7\u0CCD\u0C9F\u0CAA\u0CA1\u0CBF\u0CB8\u0CBF\u0CB2\u0CCD\u0CB2",
  "marketplace.myInquiriesTitle": "\u0CA8\u0CA8\u0CCD\u0CA8 \u0CB5\u0CBF\u0C9A\u0CBE\u0CB0\u0CA3\u0CC6\u0C97\u0CB3\u0CC1",
  "marketplace.inquiriesLoading": "\u0CB5\u0CBF\u0C9A\u0CBE\u0CB0\u0CA3\u0CC6\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB2\u0CCB\u0CA1\u0CCD \u0CAE\u0CBE\u0CA1\u0CB2\u0CBE\u0C97\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6...",
  "marketplace.inquiriesLoadError": "\u0CB5\u0CBF\u0C9A\u0CBE\u0CB0\u0CA3\u0CC6\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB2\u0CCB\u0CA1\u0CCD \u0CAE\u0CBE\u0CA1\u0CB2\u0CC1 \u0CB8\u0CBE\u0CA7\u0CCD\u0CAF\u0CB5\u0CBE\u0C97\u0CB2\u0CBF\u0CB2\u0CCD\u0CB2",
  "marketplace.noInquiries": "\u0CA8\u0CC0\u0CB5\u0CC1 \u0C87\u0CA8\u0CCD\u0CA8\u0CC2 \u0CAF\u0CBE\u0CB5\u0CC1\u0CA6\u0CC7 \u0CB5\u0CBF\u0C9A\u0CBE\u0CB0\u0CA3\u0CC6 \u0C95\u0CB3\u0CC1\u0CB9\u0CBF\u0CB8\u0CBF\u0CB2\u0CCD\u0CB2. \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8\u0C97\u0CB3\u0CA8\u0CCD\u0CA8\u0CC1 \u0CB9\u0CC1\u0CA1\u0CC1\u0C95\u0CB2\u0CC1 \u0CAE\u0CBE\u0CB0\u0CC1\u0C95\u0C9F\u0CCD\u0C9F\u0CC6\u0C97\u0CC6 \u0CB9\u0CCB\u0C97\u0CBF.",
  "marketplace.inquiryProductRemoved": "\u0C88 \u0C89\u0CA4\u0CCD\u0CAA\u0CA8\u0CCD\u0CA8 \u0C87\u0CA8\u0CCD\u0CA8\u0CC2 \u0CB2\u0CAD\u0CCD\u0CAF\u0CB5\u0CBF\u0CB2\u0CCD\u0CB2",
  "marketplace.inquiryStatusOpen": "\u0C89\u0CA4\u0CCD\u0CA4\u0CB0\u0C95\u0CCD\u0C95\u0CBE\u0C97\u0CBF \u0C95\u0CBE\u0CAF\u0CC1\u0CA4\u0CCD\u0CA4\u0CBF\u0CA6\u0CC6",
  "marketplace.inquiryStatusClosed": "\u0CAE\u0CC1\u0C9A\u0CCD\u0C9A\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/kok.json
var kok_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0924\u0941\u092E\u091A\u0940 \u0939\u0938\u094D\u0924\u0915\u0932\u093E \u0911\u0928\u0932\u093E\u0908\u0928 \u0935\u093F\u0915\u093E, \u0938\u094B\u092A\u094D\u092F\u093E \u092A\u0926\u094D\u0927\u0924\u0940\u0928\u0947.",
  "welcome.languageLabel": "\u0924\u0941\u092E\u091A\u094B \u092D\u093E\u0937\u093E \u0928\u093F\u0935\u0921\u093E",
  "welcome.getStarted": "\u0938\u0941\u0930\u0942 \u0915\u0930\u093E",
  "language.en": "\u0907\u0902\u0917\u094D\u0930\u091C\u0940",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "\u0924\u0941\u092E\u091A\u094B \u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E \u091F\u093E\u0915\u093E",
  "email.roleQuestion": "\u0939\u093E\u0902\u0935 \u0907\u0925\u0947",
  "email.roleSell": "\u092E\u093E\u091D\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0935\u093F\u0915\u0942",
  "email.roleBuy": "\u0939\u0938\u094D\u0924\u0928\u093F\u0930\u094D\u092E\u093F\u0924 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0916\u0930\u0947\u0926\u0940",
  "email.label": "\u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E",
  "email.helper": "\u0906\u092E\u094D\u0939\u0940 \u096A \u0905\u0902\u0915\u0940 \u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u0942, \u0924\u0941\u092E\u091A\u0940 \u0913\u0933\u0916 \u092A\u091F\u0935\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940.",
  "email.invalid": "\u0935\u0948\u0927 \u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E \u091F\u093E\u0915\u093E",
  "email.sendOtp": "\u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u093E",
  "email.error": "\u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "otp.title": "\u0924\u0941\u092E\u091A\u0947\u0902 \u0908\u092E\u0947\u0932 \u092A\u0921\u0924\u093E\u0933\u093E",
  "otp.subtitle": "\u096A \u0905\u0902\u0915\u093E\u0902\u091A\u093E \u0915\u094B\u0921 \u091F\u093E\u0915\u093E, \u091C\u094B \u092A\u093E\u0920\u0935\u093F\u0932\u093E \u0917\u0947\u0932\u093E \u0906\u0939\u0947",
  "otp.emailUndelivered": "\u0908\u092E\u0947\u0932 \u092A\u093E\u0920\u0935\u0942 \u0936\u0915\u0932\u094B \u0928\u093E\u0939\u0940. \u0921\u0947\u092E\u094B \u0915\u094B\u0921\u0938\u093E\u0920\u0940 \u0924\u0941\u092E\u091A\u094D\u092F\u093E \u091F\u0940\u092E\u0932\u093E \u0935\u093F\u091A\u093E\u0930\u093E.",
  "otp.changeEmail": "\u0908\u092E\u0947\u0932 \u092C\u0926\u0932\u093E",
  "otp.verify": "\u092A\u0921\u0924\u093E\u0933\u093E",
  "otp.invalid": "\u0938\u0930\u094D\u0935 \u096A \u0905\u0902\u0915 \u091F\u093E\u0915\u093E",
  "otp.wrong": "\u091A\u0941\u0915\u0940\u091A\u093E OTP, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "otp.resend": "OTP \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u093E\u0920\u0935\u093E",
  "otp.resendIn": "OTP \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u093E\u0920\u0935\u093E {n}s \u092E\u0927\u094D\u092F\u0947",
  "otp.resendError": "OTP \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u093E\u0920\u0935\u0942 \u0936\u0915\u0932\u094B \u0928\u093E\u0939\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "camera.capture": "\u092B\u094B\u091F\u094B \u0918\u094D\u092F\u093E",
  "camera.unavailable": "\u0915\u0945\u092E\u0947\u0930\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940, \u092B\u094B\u091F\u094B \u0928\u093F\u0935\u0921\u093E",
  "camera.choosePhoto": "\u092B\u094B\u091F\u094B \u0928\u093F\u0935\u0921\u093E",
  "camera.retake": "\u092A\u0941\u0928\u094D\u0939\u093E \u0918\u094D\u092F\u093E",
  "camera.usePhoto": "\u0939\u093E \u092B\u094B\u091F\u094B \u0935\u093E\u092A\u0930\u093E",
  "camera.enhancing": "\u0924\u0941\u092E\u091A\u093E \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0924 \u0906\u0939\u0947...",
  "camera.enhanceError": "\u0924\u0941\u092E\u091A\u093E \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940",
  "camera.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928",
  "camera.before": "\u092E\u0942\u0933",
  "camera.after": "\u0938\u0941\u0927\u093E\u0930\u093F\u0924",
  "camera.compareHint": "\u0938\u094D\u0932\u093E\u0907\u0921\u0930 \u0913\u0922\u0942\u0928 \u0924\u0941\u0932\u0928\u093E \u0915\u0930\u093E",
  "camera.continue": "\u092A\u0941\u0922\u0947",
  "studio.title": "\u0924\u0941\u092E\u091A\u094B \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930",
  "studio.original": "\u092E\u0942\u0933",
  "studio.processed": "\u092A\u094D\u0930\u0915\u094D\u0930\u093F\u092F\u093E",
  "studio.removeBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u0940 \u0915\u093E\u0921\u093E",
  "studio.removingBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u0940 \u0915\u093E\u0921\u0924\u093E\u092F...",
  "studio.keepOriginalBackground": "\u092E\u0942\u0933 \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u0940 \u0920\u0947\u0935\u093E",
  "studio.backgroundWhite": "\u092A\u093E\u0902\u0922\u0930\u0947\u0902",
  "studio.backgroundNeutral": "\u0928\u0930\u092E \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0942\u0938\u0930",
  "studio.backgroundUnavailableNotice": "\u0906\u0924\u093E \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u0940 \u0915\u093E\u0921\u092A\u093E\u091A\u094B \u092A\u0930\u094D\u092F\u093E\u092F \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u092F. \u0924\u0941\u092E\u091A\u094B \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u0932\u094B \u0928\u093E\u092F.",
  "studio.backgroundTimedOutNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u0940 \u0915\u093E\u0921\u092A\u093E\u091A\u094B \u0935\u0947\u0933 \u0916\u0942\u092A \u091C\u093E\u0938\u094D\u0924 \u091C\u093E\u0932\u094B, \u092E\u094D\u0939\u0923\u0942\u0928 \u0935\u0917\u0933\u0932\u094B. \u0924\u0941\u092E\u091A\u094B \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u0932\u094B \u0928\u093E\u092F.",
  "studio.backgroundQuotaNotice": "\u0906\u0924\u093E \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u0940 \u0915\u093E\u0921\u092A\u093E\u091A\u094B \u0915\u094B\u091F\u093E \u092D\u0930\u0932\u094B. \u0924\u0941\u092E\u091A\u094B \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u0932\u094B \u0928\u093E\u092F.",
  "studio.backgroundFailedNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u0940 \u0915\u093E\u0921\u092A\u093E\u091A\u094B \u0905\u092A\u092F\u0936. \u0924\u0941\u092E\u091A\u094B \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u0932\u094B \u0928\u094D\u0939\u0940.",
  "studio.brightness": "\u0909\u091C\u093E\u0933\u094B",
  "studio.contrast": "\u0935\u093F\u0930\u094B\u0927",
  "studio.sharpen": "\u0924\u0940\u0915\u094D\u0937\u094D\u0923 \u0915\u0930\u092A",
  "studio.autoLighting": "\u0938\u094D\u0935\u092F\u0902\u091A\u0932\u093F\u0924 \u092A\u094D\u0930\u0915\u093E\u0936",
  "studio.crop": "\u0915\u091F \u0915\u0930\u092A",
  "studio.cropOriginal": "\u092E\u0942\u0933",
  "studio.cropSquare": "\u091A\u094C\u0915\u094B\u0928",
  "studio.cropPortrait": "\u0909\u092D\u094B",
  "studio.accept": "\u0939\u094D\u092F\u093E \u092B\u094B\u091F\u094B\u093E\u091A\u094B \u0935\u093E\u092A\u0930 \u0915\u0930",
  "studio.retake": "\u092A\u0941\u0928\u094D\u0939\u093E \u0918\u094D\u092F\u093E",
  "studio.finalizing": "\u0924\u0941\u092E\u091A\u0947 \u092C\u0926\u0932 \u0932\u093E\u0917\u0942 \u0915\u0930\u0924\u093E...",
  "studio.on": "\u0938\u0941\u0930\u0942",
  "studio.off": "\u092C\u0902\u0926",
  "category.title": "\u0924\u0941\u092E\u094D\u0939\u0940 \u0915\u093E\u092F \u0935\u093F\u0915\u0924 \u0906\u0939\u093E\u0924?",
  "category.continue": "\u092A\u0941\u0922\u0947",
  "category.materialQuestion": "\u0924\u0947 \u0915\u0936\u093E\u091A\u0947\u0902 \u092C\u0928\u0932\u094B? (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "category.textiles": "\u0915\u093E\u092A\u0921",
  "category.pottery": "\u092E\u093E\u0924\u0940\u091A\u0940 \u092D\u093E\u0902\u0921\u0940",
  "category.jewelry": "\u0917\u0939\u0928\u093E",
  "category.woodwork": "\u0932\u093E\u0915\u0921\u093E\u091A\u094B \u0915\u093E\u092E",
  "category.bambooCane": "\u092C\u093E\u0902\u092C\u0942 \u0935 \u0915\u093E\u0920\u0940",
  "category.other": "\u0907\u0924\u0930",
  "voice.tapToRecord": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u091A\u094B \u0935\u0930\u094D\u0923\u0928 \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u092A\u093E\u091A\u094B \u091F\u0945\u092A",
  "voice.recording": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u091A\u093E\u0932\u0942",
  "voice.stop": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u0925\u093E\u0902\u092C\u0935\u093E",
  "voice.record": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921",
  "voice.reviewRecording": "\u092A\u0941\u0928\u094D\u0939\u093E \u0910\u0915\u093E, \u092E\u0917 \u092A\u0941\u0922\u0947 \u091C\u093E \u0915\u093F\u0902\u0935\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u093E",
  "voice.reRecord": "\u092A\u0941\u0928\u094D\u0939\u093E \u0930\u0947\u0915\u0949\u0930\u094D\u0921",
  "voice.continue": "\u092A\u0941\u0922\u0947",
  "describe.transcribing": "\u0924\u0941\u092E\u091A\u094B \u0935\u0930\u094D\u0923\u0928 \u0938\u092E\u091C\u0924\u093E\u0902\u092F...",
  "describe.transcribeError": "\u0924\u0941\u092E\u091A\u094B \u0935\u0930\u094D\u0923\u0928 \u0938\u092E\u091C\u0924\u0932\u094B \u0928",
  "describe.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928",
  "describe.reviewHint": "\u092A\u0921\u0924\u093E\u0933\u0942\u0928 \u0917\u0930\u091C \u0905\u0938\u0947\u0932 \u0924\u0930 \u092C\u0926\u0932",
  "describe.fallbackNote": "\u092E\u093E\u092F\u0915\u094D\u0930\u094B\u092B\u094B\u0928 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u094D\u0939\u0947, \u0924\u0941\u092E\u091A\u094B \u0935\u0930\u094D\u0923\u0928 \u091F\u093E\u0907\u092A \u0915\u0930",
  "describe.placeholderEn": "\u0924\u0941\u092E\u091A\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0907\u0902\u0917\u094D\u0930\u091C\u0940\u0924 \u0935\u0930\u094D\u0923\u0928 \u0915\u0930",
  "describe.continue": "\u092A\u0941\u0922\u0947",
  "pricing.title": "\u0924\u0941\u092E\u091A\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0915\u093F\u0902\u092E\u0924 \u0920\u0930\u093E\u0935",
  "pricing.summaryEdit": "\u092C\u0926\u0932",
  "pricing.materialCostLabel": "\u0938\u093E\u0939\u093F\u0924\u094D\u092F \u0916\u0930\u094D\u091A",
  "pricing.materialCostHelper": "\u0915\u091A\u094D\u091A\u094D\u092F\u093E \u0938\u093E\u0939\u093F\u0924\u094D\u092F\u093E\u0935\u0930 \u0915\u093F\u0924\u0940 \u0916\u0930\u094D\u091A \u0915\u0947\u0932\u093E, \u0930\u0941\u092A\u092F\u0947 \u092E\u0927\u094D\u092F\u0947 \u091F\u093E\u0915\u093E.",
  "pricing.materialCostInvalid": "0 \u092A\u0947\u0915\u094D\u0937\u093E \u091C\u093E\u0938\u094D\u0924 \u0938\u093E\u0939\u093F\u0924\u094D\u092F \u0916\u0930\u094D\u091A \u091F\u093E\u0915\u093E",
  "pricing.getSuggestion": "\u0915\u093F\u0902\u092E\u0924 \u0938\u0941\u091A\u0935\u0923\u0940 \u0918\u094D\u092F\u093E",
  "pricing.suggestError": "\u0915\u093F\u0902\u092E\u0924 \u0938\u0941\u091A\u0935\u0923\u0940 \u092E\u093F\u0933\u093E\u0932\u0940 \u0928\u093E\u0939\u0940",
  "pricing.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928",
  "pricing.rangeLabel": "\u0938\u0941\u091A\u0935\u0932\u0947\u0932\u0940 \u0915\u093F\u0902\u092E\u0924 \u0936\u094D\u0930\u0947\u0923\u0940",
  "pricing.sellingPriceLabel": "\u0924\u0941\u092E\u091A\u0940 \u0935\u093F\u0915\u094D\u0930\u0940 \u0915\u093F\u0902\u092E\u0924",
  "pricing.sellingPriceNote": "\u0939\u0940 \u092B\u0915\u094D\u0924 \u0938\u0941\u091A\u0935\u0923\u0940 \u0906\u0939\u0947, \u0924\u0941\u092E\u094D\u0939\u0940 \u0939\u0935\u0940 \u0924\u0936\u0940 \u0915\u093F\u0902\u092E\u0924 \u0938\u0947\u091F \u0915\u0930\u0942 \u0936\u0915\u0924\u093E.",
  "pricing.sellingPriceInvalid": "0 \u092A\u0947\u0915\u094D\u0937\u093E \u091C\u093E\u0938\u094D\u0924 \u0935\u093F\u0915\u094D\u0930\u0940 \u0915\u093F\u0902\u092E\u0924 \u091F\u093E\u0915\u093E",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "pricing.publishError": "\u0924\u0941\u092E\u091A\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u091D\u093E\u0932\u0947 \u0928\u093E\u0939\u0940",
  "pricing.successTitle": "\u0924\u0941\u092E\u091A\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0906\u0924\u093E \u0932\u093E\u0907\u0935\u094D\u0939 \u0906\u0939\u0947!",
  "pricing.successMessage": "\u0916\u0930\u0947\u0926\u0940\u0926\u093E\u0930 \u0906\u0924\u093E \u0924\u0941\u092E\u091A\u094D\u092F\u093E \u0926\u0941\u0915\u093E\u0928\u093E\u0924 \u0924\u0947 \u0936\u094B\u0927\u0942 \u0936\u0915\u0924\u093E\u0924.",
  "pricing.viewShop": "\u092E\u093E\u091D\u094D\u092F\u093E \u0926\u0941\u0915\u093E\u0928\u093E\u0924 \u092A\u0939\u093E",
  "home.title": "\u092E\u093E\u091D\u0947 \u0926\u0941\u0915\u093E\u0928",
  "home.gemBannerTitle": "GeM / ONDC \u0936\u0940 \u0915\u0928\u0947\u0915\u094D\u091F \u0915\u0930\u093E",
  "home.gemBannerBadge": "\u0932\u0935\u0915\u0930\u091A \u092F\u0947\u0924 \u0906\u0939\u0947",
  "home.gemBannerMessage": "\u0939\u0940 \u090F\u0915\u0924\u094D\u0930\u0940\u0915\u0930\u0923 \u0932\u0935\u0915\u0930\u091A \u092F\u0947\u0924 \u0906\u0939\u0947.",
  "home.loading": "\u0906\u092A\u0932\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0932\u094B\u0921 \u0939\u094B\u0924 \u0906\u0939\u0947\u0924...",
  "home.loadError": "\u0906\u092A\u0932\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0932\u094B\u0921 \u0915\u0930\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940",
  "home.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "home.emptyTitle": "\u0905\u091C\u0942\u0928 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0928\u093E\u0939\u0940\u0924",
  "home.emptyMessage": "KalaSetu \u0935\u0930 \u0935\u093F\u0915\u094D\u0930\u0940 \u0938\u0941\u0930\u0942 \u0915\u0930\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940 \u0906\u092A\u0932\u0947 \u092A\u0939\u093F\u0932\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u091C\u094B\u0921\u093E.",
  "home.addFirstProduct": "\u0906\u092A\u0932\u0947 \u092A\u0939\u093F\u0932\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u091C\u094B\u0921\u093E",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u092E\u0938\u0941\u0926\u093E",
  "home.statusFailed": "\u0905\u092F\u0936\u0938\u094D\u0935\u0940",
  "home.detailCategory": "\u0935\u0930\u094D\u0917",
  "home.detailEdit": "\u0938\u0902\u092A\u093E\u0926\u0928",
  "home.detailDelete": "\u0915\u093E\u0922\u093E",
  "home.detailClose": "\u092C\u0902\u0926",
  "home.editPriceLabel": "\u0915\u093F\u0902\u092E\u0924",
  "home.editDescriptionLabel": "\u0935\u0930\u094D\u0923\u0928",
  "home.editSave": "\u092C\u0926\u0932 \u091C\u0924\u0928 \u0915\u0930\u093E",
  "home.editCancel": "\u0930\u0926\u094D\u0926 \u0915\u0930\u093E",
  "home.editPriceInvalid": "0 \u092A\u0947\u0915\u094D\u0937\u093E \u091C\u093E\u0938\u094D\u0924 \u0915\u093F\u0902\u092E\u0924 \u0926\u094D\u092F\u093E",
  "home.editDescriptionRequired": "\u0915\u0941\u0920\u0932\u094D\u092F\u093E\u0939\u0940 \u092D\u093E\u0937\u0947\u0924 \u0935\u0930\u094D\u0923\u0928 \u0930\u093F\u0915\u093E\u092E\u0947 \u0905\u0938\u0942 \u0936\u0915\u0924 \u0928\u093E\u0939\u0940",
  "home.editError": "\u0924\u0941\u092E\u091A\u0947 \u092C\u0926\u0932 \u091C\u0924\u0928 \u0915\u0930\u0942 \u0936\u0915\u0932\u0947 \u0928\u093E\u0939\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "home.deleteConfirm": "\u0939\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0939\u091F\u0935\u093E? \u0939\u0947 \u092A\u0930\u0924 \u0915\u0930\u0924\u093E \u092F\u0947\u0923\u093E\u0930 \u0928\u093E\u0939\u0940.",
  "home.deleteConfirmYes": "\u0939\u094B\u092F, \u0939\u091F\u0935\u093E",
  "home.deleteError": "\u0939\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0939\u091F\u0935\u0942 \u0936\u0915\u0932\u0947 \u0928\u093E\u0939\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "profile.emailLabel": "\u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940",
  "profile.loading": "\u0906\u092A\u0932\u093E \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u0939\u094B\u0924 \u0906\u0939\u0947...",
  "profile.loadError": "\u0906\u092A\u0932\u093E \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u0915\u0930\u0942 \u0936\u0915\u0932\u0947 \u0928\u093E\u0939\u0940",
  "profile.displayNameLabel": "\u0924\u0941\u092E\u091A\u0947 \u0928\u093E\u0935",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928\u093E\u091A\u0947 \u0928\u093E\u0935",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u091C\u0924\u0928 \u0915\u0930\u093E",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u091C\u0924\u0928 \u0915\u0947\u0932\u0947\u0902",
  "profile.saveError": "\u0924\u0941\u092E\u091A\u094B \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u091C\u0924\u0928 \u0915\u0930\u092A\u093E\u091A\u0947\u0902 \u0928\u0936\u0947, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "profile.logout": "\u092C\u093E\u0939\u0947\u0930 \u092A\u0921\u093E",
  "install.message": "\u091C\u0932\u0926 \u092A\u094D\u0930\u0935\u0947\u0936\u093E\u0938\u093E\u0920\u0940 KalaSetu \u0938\u094D\u0925\u093E\u092A\u093F\u0924 \u0915\u0930\u093E",
  "install.action": "\u0938\u094D\u0925\u093E\u092A\u093F\u0924 \u0915\u0930\u093E",
  "install.dismiss": "\u0930\u0926\u094D\u0926 \u0915\u0930\u093E",
  "offline.message": "\u0924\u0941\u092E\u094D\u0939\u0940 \u0911\u092B\u0932\u093E\u0907\u0928 \u0906\u0939\u093E\u0924, \u0915\u093E\u0939\u0940 \u0938\u0941\u0935\u093F\u0927\u093E \u0915\u093E\u092E \u0915\u0930\u092A\u093E\u091A\u0947\u0902 \u0928\u0936\u0947",
  "welcome.languageHint": "\u0938\u0902\u092A\u0942\u0930\u094D\u0923 \u0905\u0945\u092A \u0939\u094D\u092F\u093E \u092D\u093E\u0937\u0947\u0924 \u0905\u0938\u0947\u0932.",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E",
  "describe.localTab": "\u0924\u0941\u092E\u091A\u0940 \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0924\u0941\u092E\u091A\u094D\u092F\u093E \u0938\u094D\u0935\u0924\u0903\u091A\u094D\u092F\u093E \u092D\u093E\u0937\u0947\u0924 \u0924\u0941\u092E\u091A\u094D\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u091A\u0947\u0902 \u0935\u0930\u094D\u0923\u0928 \u0915\u0930\u093E",
  "describe.syncing": "\u0907\u0924\u0930 \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0915\u0930\u0924 \u0906\u0938\u093E...",
  "describe.syncFailed": "\u0907\u0924\u0930 \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0915\u0930\u092A\u093E\u091A\u0947\u0902 \u091C\u093E\u0935\u092A\u093E\u091A\u0947\u0902. \u0917\u0930\u091C \u092D\u093E\u0938\u0932\u094D\u092F\u093E\u0938 \u0924\u0941\u0902\u092F\u093E\u091A\u0947\u0902 \u0938\u094D\u0935\u0924\u0903 \u0938\u0902\u092A\u093E\u0926\u0928 \u0915\u0930\u092A\u093E\u091A\u0947\u0902.",
  "describe.syncHint": "\u0938\u0902\u092A\u093E\u0926\u0928 \u0906\u092A\u094B\u0906\u092A \u0907\u0924\u0930 \u092D\u093E\u0937\u0947\u0924 \u0915\u0949\u092A\u0940 \u0915\u0930\u092A\u093E\u091A\u0947\u0902.",
  "pricing.updating": "\u0928\u0935\u0940\u0928 \u0938\u093E\u0939\u093F\u0924\u094D\u092F \u0916\u0930\u094D\u091A\u093E\u0938\u093E\u0920\u0940 \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0930\u0924 \u0906\u0939\u094B\u0924...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u0906\u092A\u0932\u094D\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0902\u0928\u093E \u092F\u093E \u092D\u093E\u0937\u0947\u0924 \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0930\u0924 \u0906\u0939\u094B\u0924...",
  "profile.relocalised": "\u092F\u093E \u092D\u093E\u0937\u0947\u0924 {n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0902 \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u091D\u093E\u0932\u0940.",
  "profile.relocaliseFailed": "\u0915\u093E\u0939\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0902 \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0930\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940. \u0928\u0902\u0924\u0930 \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E.",
  "marketplace.navBrowse": "\u092C\u0918\u093E",
  "marketplace.navProfile": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "marketplace.browseTitle": "\u092C\u093E\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0936\u094B\u0927\u093E...",
  "marketplace.filtersTitle": "\u092B\u093F\u0932\u094D\u091F\u0930",
  "marketplace.filtersClear": "\u0938\u0917\u0933\u0947 \u0938\u093E\u092B \u0915\u0930\u093E",
  "marketplace.filterAll": "\u0938\u0917\u0933\u0947",
  "marketplace.filterMaterial": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "marketplace.filterRegion": "\u092A\u094D\u0930\u0926\u0947\u0936",
  "marketplace.filterPrice": "\u0915\u093F\u0902\u092E\u0924 \u0936\u094D\u0930\u0947\u0923\u0940 (\u20B9)",
  "marketplace.filterPriceMin": "\u0915\u093F\u092E\u093E\u0928",
  "marketplace.filterPriceMax": "\u091C\u093E\u0938\u094D\u0924",
  "marketplace.sortLabel": "\u0915\u094D\u0930\u092E\u093E\u0928\u0941\u0938\u093E\u0930",
  "marketplace.sortNewest": "\u0928\u0935\u0940\u0928\u0924\u092E \u092A\u094D\u0930\u0925\u092E",
  "marketplace.sortPriceAsc": "\u0915\u093F\u0902\u092E\u0924: \u0915\u092E\u0940 \u0924\u0947 \u091C\u093E\u0938\u094D\u0924",
  "marketplace.sortPriceDesc": "\u0915\u093F\u0902\u092E\u0924: \u091C\u093E\u0938\u094D\u0924 \u0924\u0947 \u0915\u092E\u0940",
  "marketplace.resultCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0938\u093E\u092A\u0921\u0932\u0940",
  "marketplace.loadMore": "\u0906\u0923\u0916\u0940 \u0932\u094B\u0921 \u0915\u0930\u093E",
  "marketplace.loadError": "\u092E\u093E\u0930\u094D\u0915\u0947\u091F\u092A\u094D\u0932\u0947\u0938 \u0932\u094B\u0921 \u091C\u093E\u0932\u094B \u0928\u093E, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E\u0924",
  "marketplace.emptyTitle": "\u0939\u094D\u092F\u093E \u092B\u093F\u0932\u094D\u091F\u0930\u093E\u0902\u0928\u0941\u0938\u093E\u0930 \u0915\u094B\u0923\u0924\u0947\u0939\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0928\u093E\u092F",
  "marketplace.emptyFiltered": "\u092B\u093F\u0932\u094D\u091F\u0930 \u0915\u093E\u0921\u0942\u0928 \u092C\u0918\u093E \u0915\u093F\u0902\u0935\u093E \u0926\u0941\u0938\u0930\u0947\u0902 \u0936\u094B\u0927\u093E.",
  "marketplace.emptyNoProducts": "\u0906\u091C\u0940\u092A\u0930\u094D\u092F\u0902\u0924 \u0915\u094B\u0923\u0924\u0947\u0939\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u091C\u093E\u0932\u0947\u0902 \u0928\u093E\u092F. \u0932\u0935\u0915\u0930\u091A \u092C\u0918\u093E\u0924.",
  "marketplace.artisanUnnamed": "KalaSetu \u0915\u093E\u0930\u093F\u0917\u0930",
  "marketplace.backToBrowse": "\u092C\u093E\u091C\u093E\u0930\u093E\u0915 \u092A\u0930\u0924",
  "marketplace.detailNotFoundTitle": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0938\u093E\u092A\u0921\u0932\u093E \u0928\u093E\u092F",
  "marketplace.detailNotFoundMessage": "\u0939\u094D\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0915 \u0915\u093E\u0921\u0942\u0928 \u091F\u093E\u0915\u0932\u0947\u0932\u094B \u0906\u0938\u0942 \u0936\u0915\u0924\u093E \u0935\u093E \u0906\u0924\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u092F.",
  "marketplace.artisanSummaryTitle": "\u0915\u093E\u0930\u0940\u0917\u0930\u093E\u092C\u0926\u094D\u0926\u0932",
  "marketplace.artisanProductCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0902 KalaSetu \u0935\u0930 \u0932\u093F\u0938\u094D\u091F\u0947\u0921",
  "marketplace.inquiryTitle": "\u0939\u094D\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0915 \u0906\u0935\u0921\u0924\u093E?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0915\u093E\u0930\u0940\u0917\u0930\u093E\u0915 \u0924\u0941\u092E\u0915\u093E \u0915\u093E\u092F \u0939\u0935\u0947 \u0924\u0947 \u0938\u093E\u0902\u0917\u093E: \u092A\u094D\u0930\u092E\u093E\u0923, \u0938\u093E\u0928\u0941\u0915\u0942\u0932\u0928, \u0921\u093F\u0932\u093F\u0935\u094D\u0939\u0930\u0940 \u0935\u0947\u0933...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0935\u093F\u091A\u093E\u0930 \u092A\u093E\u0920\u0935\u093E",
  "marketplace.inquirySent": "\u0924\u0941\u092E\u091A\u093E \u0935\u093F\u091A\u093E\u0930 \u092A\u093E\u0920\u0935\u0932\u093E. \u0915\u093E\u0930\u0940\u0917\u0930 \u0932\u0935\u0915\u0930 \u0938\u0902\u092A\u0930\u094D\u0915 \u0915\u0930\u0940\u0932.",
  "marketplace.inquiryError": "\u0935\u093F\u091A\u093E\u0930 \u092A\u093E\u0920\u0935\u0942\u0902\u0915 \u091C\u093E\u0932\u0947 \u0928\u093E, \u092A\u0930\u0924 \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E\u0924",
  "marketplace.regionLabel": "\u092A\u094D\u0930\u0926\u0947\u0936",
  "marketplace.regionUnspecified": "\u0928\u093F\u0930\u094D\u0926\u093F\u0937\u094D\u091F \u0928\u094D\u0939\u093E\u092F",
  "marketplace.myInquiriesTitle": "\u092E\u093E\u091D\u0947 \u092A\u094D\u0930\u0936\u094D\u0928",
  "marketplace.inquiriesLoading": "\u0924\u0941\u092E\u091A\u0947 \u092A\u094D\u0930\u0936\u094D\u0928 \u0932\u094B\u0921 \u0915\u0930\u0924\u093E...",
  "marketplace.inquiriesLoadError": "\u0924\u0941\u092E\u091A\u0947 \u092A\u094D\u0930\u0936\u094D\u0928 \u0932\u094B\u0921 \u0915\u0930\u092A\u093E\u0915 \u0928\u094D\u0939\u092F",
  "marketplace.noInquiries": "\u0924\u0941\u092E\u0940 \u0905\u091C\u0942\u0928 \u092A\u094D\u0930\u0936\u094D\u0928 \u092A\u093E\u0920\u0935\u0932\u0947 \u0928\u094D\u0939\u092F. \u092C\u093E\u091C\u093E\u0930\u093E\u0924 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0902 \u092C\u0918\u093E.",
  "marketplace.inquiryProductRemoved": "\u0939\u0947\u0902 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0906\u0924\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u094D\u0939\u092F",
  "marketplace.inquiryStatusOpen": "\u0909\u0924\u094D\u0924\u0930\u093E \u0935\u093E\u091F\u0924\u093E",
  "marketplace.inquiryStatusClosed": "\u092C\u0902\u0926",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/ks.json
var ks_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0622\u0646 \u0644\u0627\u0626\u0646 \u0622\u067E\u0768\u06CC \u06C1\u0646\u0631 \u0628\u06CC\u06A9 \u06A9\u0631\u0646\u060C \u0633\u064F\u06C1\u0644 \u0637\u0631\u06CC\u0642\u06C1.",
  "welcome.languageLabel": "\u0627\u067E\u0768\u06CC \u0632\u0628\u0627\u0646 \u0686\u064F\u0646",
  "welcome.getStarted": "\u0634\u0631\u0648\u0639 \u06A9\u0631\u0646",
  "language.en": "\u0627\u0646\u06AF\u0631\u06CC\u0632\u06CC",
  "language.hi": "\u06C1\u0646\u062F\u06CC",
  "email.title": "\u0627\u067E\u0768\u06CC \u0627\u06CC \u0645\u06CC\u0644 \u067E\u062A\u06C1 \u062F\u0631\u062C \u06A9\u0631\u0646",
  "email.roleQuestion": "\u0628\u06D2 \u06C1\u0646\u0632",
  "email.roleSell": "\u0645\u06CC\u06C1\u0655\u0646 \u0645\u0627\u0644 \u0628\u064E\u0686\u0646",
  "email.roleBuy": "\u06C1\u0627\u062A\u06BE \u0633\u0672\u0646 \u0628\u0646\u0672\u06CC \u0686\u06CC\u0632 \u0628\u06C4\u0632",
  "email.label": "\u0627\u06CC \u0645\u06CC\u0644 \u067E\u062A\u06C1",
  "email.helper": "\u06C1\u0645 \u06F4 \u06C1\u0646\u062F\u0633\u06C1 \u06A9\u0648\u0688 \u0628\u06BE\u06CC\u062C\u06CC\u06BA \u06AF\u06D2 \u0622\u067E\u0768\u06CC \u062A\u0635\u062F\u06CC\u0642 \u06A9\u0631\u0646 \u0644\u0626\u06CC",
  "email.invalid": "\u0627\u06CC\u06A9 \u062F\u0631\u0633\u062A \u0627\u06CC \u0645\u06CC\u0644 \u067E\u062A\u06C1 \u062F\u0631\u062C \u06A9\u0631\u0646",
  "email.sendOtp": "\u06A9\u0648\u0688 \u0628\u06BE\u06CC\u062C",
  "email.error": "\u06A9\u0648\u0688 \u0628\u06BE\u06CC\u062C \u0646\u06C1\u06CC \u0633\u06B3\u06CC\u060C \u0628\u0631\u0627\u0626\u06D2 \u0645\u06C1\u0631\u0628\u0627\u0646\u06CC \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u0646",
  "otp.title": "\u062A\u064F\u06C1\u0627\u0631\u06D2 \u0627\u06CC \u0645\u06CC\u0644 \u06A9\u06CC \u062A\u0635\u062F\u06CC\u0642",
  "otp.subtitle": "4 \u0639\u062F\u062F\u06CC \u06A9\u0648\u0688 \u0628\u06BE\u062C\u06CC\u0627 \u06AF\u06D3",
  "otp.emailUndelivered": "\u0627\u06CC \u0645\u06CC\u0644 \u0646\u06C1 \u0628\u06BE\u062C\u06CC\u0627 \u06AF\u06D3. \u0688\u06CC\u0645\u0648 \u06A9\u0648\u0688 \u0644\u0626\u06CC \u0627\u067E\u0646\u06D2 \u0679\u06CC\u0645 \u0633\u06D2 \u067E\u0686\u06BE\u0646.",
  "otp.changeEmail": "\u0627\u06CC \u0645\u06CC\u0644 \u0628\u062F\u0644\u0646",
  "otp.verify": "\u062A\u0635\u062F\u06CC\u0642",
  "otp.invalid": "\u0633\u0627\u0631\u06D2 4 \u0639\u062F\u062F \u0628\u06BE\u062C\u06CC\u0627 \u06AF\u06D3",
  "otp.wrong": "\u063A\u0644\u0637 OTP\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u0646",
  "otp.resend": "OTP \u062F\u0648\u0628\u0627\u0631\u06C1 \u0628\u06BE\u062C\u06CC\u0627 \u06AF\u06D3",
  "otp.resendIn": "OTP \u062F\u0648\u0628\u0627\u0631\u06C1 \u0628\u06BE\u062C\u06CC\u0627 \u06AF\u06D3 {n}s \u0645\u06CC\u06BA",
  "otp.resendError": "OTP \u062F\u0648\u0628\u0627\u0631\u06C1 \u0646\u06C1 \u0628\u06BE\u062C\u06CC\u0627 \u06AF\u06D3\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u0646",
  "camera.capture": "\u062A\u0635\u0648\u06CC\u0631 \u06A9\u064E\u067E\u0686\u0631 \u06A9\u0631\u0646",
  "camera.unavailable": "\u06A9\u06CC\u0645\u0631\u0627 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u060C \u062A\u0635\u0648\u06CC\u0631 \u0686\u0646\u0646",
  "camera.choosePhoto": "\u062A\u0635\u0648\u06CC\u0631 \u0686\u064F\u0646",
  "camera.retake": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u0686\u064F\u06A9",
  "camera.usePhoto": "\u06CC\u06C1 \u062A\u0635\u0648\u06CC\u0631 \u0627\u0633\u062A\u0639\u0645\u0627\u0644 \u06A9\u0631",
  "camera.enhancing": "\u0622\u067E \u06A9\u06CC \u062A\u0635\u0648\u06CC\u0631 \u0628\u06C1\u062A\u0631 \u06A9\u0631\u0646\u06C1...",
  "camera.enhanceError": "\u0622\u067E \u06A9\u06CC \u062A\u0635\u0648\u06CC\u0631 \u0628\u06C1\u062A\u0631 \u0646\u06C1 \u06A9\u0631 \u0633\u06B3\u06CC",
  "camera.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634",
  "camera.before": "\u0627\u0635\u0644",
  "camera.after": "\u0628\u06C1\u062A\u0631",
  "camera.compareHint": "\u0633\u0650\u0644\u0627\u0626\u0688\u0631 \u06AF\u06BE\u0633\u06CC\u0679 \u06A9\u0631 \u0645\u0648\u0627\u0632\u0646\u06C1 \u06A9\u0631",
  "camera.continue": "\u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE",
  "studio.title": "\u0627\u067E\u0646\u06C1 \u0641\u0648\u0679\u0648 \u0633\u064F\u062F\u06BE\u0627\u0631",
  "studio.original": "\u0627\u0635\u0644",
  "studio.processed": "\u067E\u0631\u0648\u0633\u06CC\u0633 \u0634\u062F\u06C1",
  "studio.removeBackground": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0624",
  "studio.removingBackground": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0646 \u0686\u06BE\u064F...",
  "studio.keepOriginalBackground": "\u0627\u0635\u0644 \u067E\u0633 \u0645\u0646\u0638\u0631 \u0631\u06A9\u06BE\u0648",
  "studio.backgroundWhite": "\u0633\u0641\u06CC\u062F",
  "studio.backgroundNeutral": "\u0646\u0631\u0645 \u06A9\u0631\u06CC\u0645",
  "studio.backgroundBlur": "\u062F\u06BE\u0646\u062F\u0644\u0627",
  "studio.backgroundUnavailableNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0648\u0646 \u06C1\u0646\u0672\u06C1 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u0627\u06C1\u06D2\u06D4 \u062A\u0648\u06C1\u0646\u062F \u0641\u0648\u0679\u0648 \u0628\u062F\u0644 \u0646\u0627\u06C1\u06D2\u06D4",
  "studio.backgroundTimedOutNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0648\u0646 \u0628\u0648\u065A\u062A \u062F\u06CC\u0631 \u0644\u06AF \u06AF\u0654\u06CC \u062A\u0627\u0645 \u0633\u06A9\u06CC\u067E \u06A9\u0631\u0646 \u06AF\u0654\u06CC\u06D4 \u062A\u0648\u06C1\u0646\u062F \u0641\u0648\u0679\u0648 \u0628\u062F\u0644 \u0646\u0627\u06C1\u06D2\u06D4",
  "studio.backgroundQuotaNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0648\u0646 \u06A9\u06CC \u06A9\u0648\u0679\u0627 \u06C1\u0646\u0672\u06C1 \u067E\u0648\u0631\u0627 \u06AF\u0654\u06CC\u06D4 \u062A\u0648\u06C1\u0646\u062F \u0641\u0648\u0679\u0648 \u0628\u062F\u0644 \u0646\u0627\u06C1\u06D2\u06D4",
  "studio.backgroundFailedNotice": "\u067E\u0686\u06BE\u0644\u0627 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0648\u0646 \u0646\u0627 \u06A9\u0627\u0645\u06CC\u0627\u0628\u06D4 \u062A\u0648\u06C1\u0646\u062F \u062A\u0635\u0648\u06CC\u0631 \u0628\u062F\u0644\u06CC\u0646 \u0646\u06C1 \u06C1\u0650\u0646\u062F\u06D4",
  "studio.brightness": "\u0686\u0645\u06A9",
  "studio.contrast": "\u062A\u0636\u0627\u062F",
  "studio.sharpen": "\u062A\u06CC\u0632 \u06A9\u0631\u0646",
  "studio.autoLighting": "\u062E\u0648\u062F\u06A9\u0627\u0631 \u0631\u0648\u0634\u0646\u06CC",
  "studio.crop": "\u06A9\u0679",
  "studio.cropOriginal": "\u0627\u0635\u0644",
  "studio.cropSquare": "\u0686\u0648\u06A9\u0648\u0631",
  "studio.cropPortrait": "\u067E\u0648\u0631\u0679\u0631\u06CC\u0679",
  "studio.accept": "\u06CC\u06C1 \u062A\u0635\u0648\u06CC\u0631 \u0627\u0633\u062A\u0639\u0645\u0627\u0644 \u06A9\u0631\u0646",
  "studio.retake": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u0644\u0648\u0627\u0646",
  "studio.finalizing": "\u062A\u0648\u06C1\u0646\u062F \u062A\u0631\u0645\u06CC\u0645\u0627\u062A \u0644\u0627\u06AF\u0648 \u06A9\u0631\u0627\u0646 \u0686\u06BE\u064F...",
  "studio.on": "\u0686\u0627\u0644\u0648",
  "studio.off": "\u0628\u0646\u062F",
  "category.title": "\u0622\u067E \u06A9\u06CC\u0627 \u0628\u06CC\u0686 \u0631\u06C1\u06D2 \u06C1\u06CC\u06BA\u061F",
  "category.continue": "\u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE",
  "category.materialQuestion": "\u06CC\u06C1 \u0686\u06BE\u064F \u06A9\u0633 \u0686\u06CC\u0632 \u06C1\u0646\u062F \u0628\u0646\u0646\u061F (\u0627\u062E\u062A\u06CC\u0627\u0631\u06CC)",
  "category.textiles": "\u06A9\u067E\u0691",
  "category.pottery": "\u0645\u0679\u06CC",
  "category.jewelry": "\u06AF\u06C1\u0646\u0627",
  "category.woodwork": "\u0644\u06A9\u0691\u06CC",
  "category.bambooCane": "\u0628\u0627\u0646\u0633 & \u06A9\u0646\u06CC",
  "category.other": "\u067B\u06CC",
  "voice.tapToRecord": "\u0627\u067E\u0646\u06D2 \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u06A9\u06CC \u062A\u0641\u0635\u06CC\u0644 \u0631\u06CC\u06A9\u0627\u0631\u0688 \u06A9\u0631\u0646\u0659\u06D2 \u0644\u0626\u06CC \u0679\u067E \u06A9\u0631\u0646\u0659\u06D2",
  "voice.recording": "\u0631\u06CC\u06A9\u0627\u0631\u0688\u0646\u06AF \u06A9\u0631\u0646\u0659\u06D2",
  "voice.stop": "\u0631\u06CC\u06A9\u0627\u0631\u0688\u0646\u06AF \u0631\u0648\u06AA",
  "voice.record": "\u0631\u06CC\u06A9\u0627\u0631\u0688",
  "voice.reviewRecording": "\u067E\u0686\u06BE\u06D2 \u0633\u0646\u0648\u060C \u067E\u06BE\u0631 \u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE\u0648 \u06CC\u0627 \u062F\u0648\u0628\u0627\u0631\u06C1 \u0631\u06CC\u06A9\u0627\u0631\u0688 \u06A9\u0631\u0646\u0659\u06D2",
  "voice.reRecord": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u0631\u06CC\u06A9\u0627\u0631\u0688",
  "voice.continue": "\u062C\u0627\u0631\u06CC",
  "describe.transcribing": "\u062A\u064F\u06C1\u0646\u0650\u06CC \u0648\u0636\u0627\u062D\u062A \u0633\u0645\u062C\u06BE\u0646\u06C1...",
  "describe.transcribeError": "\u062A\u064F\u06C1\u0646\u0650\u06CC \u0648\u0636\u0627\u062D\u062A \u0633\u0645\u062C\u06BE\u0646\u06C1 \u0646\u06BE\u0650\u06CC \u0633\u06B3\u06CC",
  "describe.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1",
  "describe.reviewHint": "\u062F\u06CC\u06A9\u06BE\u0646 \u0648 \u0627\u06CC\u0688\u0679 \u06A9\u0631\u0646 \u0627\u06AF\u0631 \u0636\u0631\u0648\u0631\u062A \u06C1\u0648",
  "describe.fallbackNote": "\u0645\u0627\u0626\u06CC\u06A9\u0631\u0648\u0641\u0648\u0646 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u06CC\u060C \u0627\u067E\u0646\u06CC \u0648\u0636\u0627\u062D\u062A \u0679\u0627\u0626\u067E \u06A9\u0631\u0646",
  "describe.placeholderEn": "\u0627\u067E\u0646\u0650\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0627\u0646\u06AF\u0644\u0634 \u0645\u06CC\u06BA \u0648\u0636\u0627\u062D\u062A \u06A9\u0631\u0646",
  "describe.continue": "\u062C\u0627\u0631\u06CC",
  "pricing.title": "\u0627\u067E\u0646\u0650\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0642\u06CC\u0645\u062A \u06A9\u0631\u0646",
  "pricing.summaryEdit": "\u0627\u06CC\u0688\u0679",
  "pricing.materialCostLabel": "\u0645\u0648\u0627\u062F \u062E\u0631\u0686",
  "pricing.materialCostHelper": "\u062E\u0627\u0645 \u0645\u0648\u0627\u062F \u067E\u0631 \u062E\u0631\u0686 \u06A9\u06CC\u062A\u06C1 \u0631\u0648\u067E\u06CC\u06C1 \u0645\u06CC\u06BA \u062F\u0627\u062E\u0644 \u06A9\u0631\u0646",
  "pricing.materialCostInvalid": "0 \u06A9\u0627\u0646 \u0648\u064F\u0686\u0646 \u0645\u0648\u0627\u062F \u062E\u0631\u0686 \u062F\u0627\u062E\u0644 \u06A9\u0631\u0646",
  "pricing.getSuggestion": "\u0642\u06CC\u0645\u062A \u062A\u062C\u0648\u06CC\u0632 \u06A9\u0631\u0646",
  "pricing.suggestError": "\u0642\u06CC\u0645\u062A \u062A\u062C\u0648\u06CC\u0632 \u0646\u06C1 \u06A9\u0631 \u0633\u06B3\u0646",
  "pricing.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1",
  "pricing.rangeLabel": "\u0642\u06CC\u0645\u062A \u0631\u06CC\u0646\u062C \u062A\u062C\u0648\u06CC\u0632",
  "pricing.sellingPriceLabel": "\u062A\u064F\u06C1\u0646\u062F\u06C1 \u0628\u06CC\u0686\u0646 \u0642\u06CC\u0645\u062A",
  "pricing.sellingPriceNote": "\u06CC\u06C1 \u0627\u06CC\u06A9 \u062A\u062C\u0648\u06CC\u0632 \u06C1\u06D2\u060C \u062A\u064F\u06C1\u0646\u062F\u06C1 \u06C1\u0650\u0631 \u0642\u06CC\u0645\u062A \u0633\u06CC\u0679 \u06A9\u0631\u0646 \u0633\u06A9\u062F\u06D2 \u0622.",
  "pricing.sellingPriceInvalid": "0 \u06A9\u0627\u0646 \u0648\u064F\u0686\u0646 \u0628\u06CC\u0686\u0646 \u0642\u06CC\u0645\u062A \u062F\u0627\u062E\u0644 \u06A9\u0631\u0646",
  "pricing.publish": "\u067E\u0628\u0644\u0634",
  "pricing.publishError": "\u062A\u064F\u06C1\u0646\u062F\u06C1 \u067E\u0631\u0627\u0688\u06A9\u0679 \u067E\u0628\u0644\u0634 \u0646\u06C1 \u06A9\u0631 \u0633\u06B3\u0646",
  "pricing.successTitle": "\u062A\u064F\u06C1\u0646\u062F\u06C1 \u067E\u0631\u0627\u0688\u06A9\u0679 \u0644\u0627\u0626\u06CC\u0648 \u0622!",
  "pricing.successMessage": "\u062E\u0631\u06CC\u062F\u0627\u0631 \u06C1\u064F\u0646 \u062A\u064F\u06C1\u0646\u062F\u06C1 \u062F\u06A9\u0627\u0646 \u0645\u06CC\u06BA \u06CC\u06C1 \u0688\u06BE\u0648\u0646\u0688 \u0633\u06B3\u0646.",
  "pricing.viewShop": "\u0645\u06CC \u0634\u0627\u067E \u0645\u06CC\u06BA \u062F\u06CC\u06A9\u06BE\u0648",
  "home.title": "\u0645\u06CC \u0634\u0627\u067E",
  "home.gemBannerTitle": "GeM / ONDC \u0633\u0627\u0646 \u06B3\u0646\u068D\u0648",
  "home.gemBannerBadge": "\u062C\u0644\u062F\u064A \u0622\u0648\u0659\u0646",
  "home.gemBannerMessage": "\u06CC\u06C1 \u0627\u0646\u0679\u06CC\u06AF\u0631\u06CC\u0634\u0646 \u062C\u0644\u062F\u06CC \u0622\u0648\u0659\u0646 \u06C1\u06D2",
  "home.loading": "\u0622\u067E \u06A9\u06D2 \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0644\u0648\u0688 \u06C1\u0648 \u0631\u06C1\u06D2 \u06C1\u06CC\u06BA...",
  "home.loadError": "\u0622\u067E \u06A9\u06D2 \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0644\u0648\u0688 \u0646\u06C1 \u06C1\u0648 \u0633\u06A9\u06D2",
  "home.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634",
  "home.emptyTitle": "\u0627\u0628\u06BE\u06CC \u06A9\u0648\u0626\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0646\u06C1\u06CC\u06BA",
  "home.emptyMessage": "KalaSetu \u067E\u0631 \u0628\u06CC\u0686\u0646 \u0634\u0631\u0648\u0639 \u06A9\u0631\u0646 \u0644\u0626\u06CC \u067E\u06C1\u0644\u0627 \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0634\u0627\u0645\u0644 \u06A9\u0631\u0648",
  "home.addFirstProduct": "\u067E\u06C1\u0644\u0627 \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0634\u0627\u0645\u0644 \u06A9\u0631\u0648",
  "home.statusPublished": "\u0627\u0634\u0627\u0639\u062A \u0634\u062F\u06C1",
  "home.statusDraft": "\u0688\u0631\u0627\u0641\u0679",
  "home.statusFailed": "\u0646\u0627\u06A9\u0627\u0645",
  "home.detailCategory": "\u0632\u0645\u0631\u06C1",
  "home.detailEdit": "\u062A\u0628\u062F\u06CC\u0644",
  "home.detailDelete": "\u062D\u0630\u0641",
  "home.detailClose": "\u0628\u0646\u062F",
  "home.editPriceLabel": "\u0642\u06CC\u0645\u062A",
  "home.editDescriptionLabel": "\u062A\u0641\u0635\u06CC\u0644",
  "home.editSave": "\u0645\u062D\u0641\u0648\u0638 \u06A9\u0631\u0646",
  "home.editCancel": "\u0645\u0646\u0633\u0648\u062E",
  "home.editPriceInvalid": "0 \u06A9\u0627\u0646 \u0648\u0688\u06BE \u0642\u06CC\u0645\u062A \u062F\u0627\u062E\u0644 \u06A9\u0631\u0646",
  "home.editDescriptionRequired": "\u062A\u0641\u0635\u06CC\u0644 \u067B\u06C1 \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u062E\u0627\u0644\u06CC \u0646\u06C1 \u06C1\u0648",
  "home.editError": "\u062A\u064F\u06C1\u0646\u062F\u06D2 \u062A\u0628\u062F\u06CC\u0644\u06CC\u0627\u06BA \u0645\u062D\u0641\u0648\u0638 \u0646\u06C1\u06CC \u06C1\u0648\u0626\u06CC\u0627\u06BA\u060C \u0628\u0631\u0627\u0626\u06D2 \u0645\u06C1\u0631\u0628\u0627\u0646\u06CC \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "home.deleteConfirm": "\u0627\u06CC\u06C1\u06C1 \u067E\u0631\u0627\u0688\u06A9\u0679 \u0645\u0679\u0627\u0624\u061F \u0627\u06CC\u06C1\u06C1 \u0648\u0627\u067E\u0633 \u0646\u06C1\u06CC \u06C1\u0648 \u0633\u06A9\u062F\u06D2\u06D4",
  "home.deleteConfirmYes": "\u06C1\u0627\u06BA\u060C \u0645\u0679\u0627\u0624",
  "home.deleteError": "\u0627\u06CC\u06C1\u06C1 \u067E\u0631\u0627\u0688\u06A9\u0679 \u0645\u0679\u0627\u0646 \u0646\u06C1\u06CC \u06C1\u0648\u0626\u06CC\u0627\u06BA\u060C \u0628\u0631\u0627\u0626\u06D2 \u0645\u06C1\u0631\u0628\u0627\u0646\u06CC \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "profile.title": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644",
  "profile.emailLabel": "\u0627\u06CC \u0645\u06CC\u0644 \u067E\u062A\u06C1",
  "profile.emailUnknown": "\u0645\u062A\u0648\u0641\u0631 \u0646\u06C1\u06CC",
  "profile.loading": "\u062A\u064F\u06C1\u0646\u062F\u06D2 \u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0644\u0648\u0688 \u06C1\u0648 \u0631\u06CC\u0627 \u06C1\u06D2\u2026",
  "profile.loadError": "\u062A\u064F\u06C1\u0646\u062F\u06D2 \u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0644\u0648\u0688 \u0646\u06C1\u06CC \u06C1\u0648\u0626\u06CC\u0627\u06BA",
  "profile.displayNameLabel": "\u062A\u064F\u06C1\u0646\u062F\u06D2 \u0646\u0627\u06BA",
  "profile.shopNameLabel": "\u062F\u06A9\u0627\u0646 \u0646\u0627\u06BA",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638 \u06A9\u0631\u0646",
  "profile.saved": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638",
  "profile.saveError": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0628\u0686\u0627\u0646 \u0646\u06BE\u0659\u06CC\u0659\u0646\u060C \u0645\u06C1\u0631\u0628\u0627\u0646\u06CC \u06A9\u0631\u0646\u0659\u06CC\u0659 \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u0646\u0659\u06CC\u0659",
  "profile.logout": "\u0644\u0627\u06AF \u0622\u0624\u0679",
  "install.message": "\u06A9\u0627\u0644\u0627 \u0633\u0650\u062A\u0648 \u0646\u0635\u0628 \u06A9\u0631\u0646\u0659\u06CC\u0659 \u062A\u06CC\u0632\u06CC\u0659 \u0633\u0659\u0631\u0659\u06CC\u0659\u0646\u0659\u06CC\u0659",
  "install.action": "\u0646\u0635\u0628 \u06A9\u0631\u0646\u0659\u06CC\u0659",
  "install.dismiss": "\u0628\u0646\u062F \u06A9\u0631\u0646\u0659\u06CC\u0659",
  "offline.message": "\u062A\u064F\u06C1\u0659\u06CC \u0622\u0641\u0644\u0627\u0626\u0646 \u0622\u06BE\u0659\u06CC\u060C \u06A9\u0659\u0686\u06BE \u0641\u06CC\u0686\u0631\u0632 \u06A9\u0627\u0645 \u0646\u06C1 \u06A9\u0631\u0646\u0659\u06CC\u0659",
  "welcome.languageHint": "\u0633\u0627\u0631\u0659\u06CC \u0627\u06CC\u067E \u0627\u06CC\u06C1\u0659 \u0632\u0628\u0659\u06CC\u0659 \u0645\u06CC\u06BA \u06C1\u0648\u0646\u0659\u06CC\u0659",
  "welcome.regionalLanguages": "\u06C1\u0646\u062F\u0648\u0633\u062A\u0627\u0646\u06CC \u0632\u0628\u0659\u06CC\u0659",
  "describe.localTab": "\u062A\u064F\u06C1\u0659\u06CC \u0632\u0628\u0659\u06CC\u0659",
  "describe.placeholderLocal": "\u062A\u064F\u06C1\u0659\u06CC \u067E\u0631\u0627\u0688\u06A9\u0679 \u0632\u0628\u0659\u06CC\u0659 \u0645\u06CC\u06BA \u0628\u06CC\u0627\u0646 \u06A9\u0631\u0646\u0659\u06CC\u0659",
  "describe.syncing": "\u067B\u06CC \u0632\u0628\u0627\u0646 \u0627\u067E \u0688\u06CC\u0679 \u06A9\u0631\u0646\u06C1...",
  "describe.syncFailed": "\u067B\u06CC \u0632\u0628\u0627\u0646 \u0627\u067E \u0688\u06CC\u0679 \u0646\u06C1 \u06A9\u0631 \u0633\u06B3\u06CC. \u0627\u06AF\u0631 \u0636\u0631\u0648\u0631\u062A \u06C1\u0648 \u062A\u0648 \u062E\u0648\u062F \u0627\u06CC\u0688\u0679 \u06A9\u0631\u0646\u06C1.",
  "describe.syncHint": "\u062A\u0628\u062F\u06CC\u0644\u06CC\u0627\u06BA \u067B\u06CC \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u062E\u0648\u062F \u0628\u062E\u0648\u062F \u0646\u0642\u0644 \u06A9\u0631\u0646\u06C1.",
  "pricing.updating": "\u0646\u0648\u0627\u06BA \u0645\u0648\u0627\u062F \u062E\u0631\u0686 \u0644\u0627\u0621\u0650 \u0627\u067E\u068A\u064A\u067D\u0646\u06AF...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u062A\u064F\u0633\u0651\u06CC\u0631\u0650\u062A\u0650\u06A9\u0650\u06CC \u0633\u064F\u062A\u0650\u06A9\u0650\u06CC \u0632\u064F\u0628\u0651\u06CC \u0633\u064F\u062A\u0650\u06A9\u0650\u06CC...",
  "profile.relocalised": "\u062A\u064F\u0633\u0651\u06CC\u0631\u0650\u062A\u0650\u06A9\u0650\u06CC {n} \u0633\u064F\u062A\u0650\u06A9\u0650\u06CC \u0632\u064F\u0628\u0651\u06CC \u0633\u064F\u062A\u0650\u06A9\u0650\u06CC.",
  "profile.relocaliseFailed": "\u06A9\u0686\u06BE \u0633\u064F\u062A\u0650\u06A9\u0650\u06CC \u062A\u064F\u0633\u0651\u06CC\u0631\u0650\u062A\u0650\u06A9\u0650\u06CC \u0646\u064E\u06C1\u0650\u06CC \u0633\u064F\u062A\u0650\u06A9\u0650\u06CC. \u0628\u0639\u062F\u0650\u06CC \u0633\u064F\u062A\u0650\u06A9\u0650\u06CC \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u0646.",
  "marketplace.navBrowse": "\u062F\u06CC\u06A9\u06BE\u0646",
  "marketplace.navProfile": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644",
  "marketplace.browseTitle": "\u0645\u0627\u0631\u06A9\u06CC\u0679",
  "marketplace.searchPlaceholder": "\u067E\u0631\u0648\u0688\u06A9\u0679\u0633 \u0698\u06BE\u0646\u062F...",
  "marketplace.filtersTitle": "\u0641\u0644\u0679\u0631\u0632",
  "marketplace.filtersClear": "\u062A\u0645\u0627\u0645 \u0635\u0627\u0641 \u06A9\u0631\u0646",
  "marketplace.filterAll": "\u062A\u0645\u0627\u0645",
  "marketplace.filterMaterial": "\u0645\u0648\u0627\u062F",
  "marketplace.filterRegion": "\u0639\u0644\u0627\u0642\u06C1",
  "marketplace.filterPrice": "\u0642\u06CC\u0645\u062A \u062D\u062F (\u20B9)",
  "marketplace.filterPriceMin": "\u06A9\u0645",
  "marketplace.filterPriceMax": "\u0632\u06CC\u0627\u062F\u06C1",
  "marketplace.sortLabel": "\u062A\u0631\u062A\u06CC\u0628 \u06A9\u0631\u0646",
  "marketplace.sortNewest": "\u0646\u0648\u0627\u06BA \u067E\u06C1\u0644",
  "marketplace.sortPriceAsc": "\u0642\u06CC\u0645\u062A: \u06AF\u06BE\u0679 \u062A\u0648\u06BA \u0648\u0627\u062F\u06BE",
  "marketplace.sortPriceDesc": "\u0642\u06CC\u0645\u062A: \u0648\u0627\u062F\u06BE \u062A\u0648\u06BA \u06AF\u06BE\u0679",
  "marketplace.resultCount": "{n} \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0645\u0644\u0646",
  "marketplace.loadMore": "\u0645\u0632\u06CC\u062F \u0644\u0648\u0688",
  "marketplace.loadError": "\u0645\u0627\u0631\u06A9\u06CC\u0679 \u067E\u0644\u06CC\u0633 \u0644\u0648\u0688 \u0646\u06C1 \u06C1\u0646\u062F\u060C \u062F\u0648\u0628\u0627\u0631 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u0646",
  "marketplace.emptyTitle": "\u06CC\u06C1 \u0641\u0644\u0679\u0631 \u0633\u06C2\u0646 \u06A9\u0648\u0626\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0646\u06C1 \u0645\u0644\u0646",
  "marketplace.emptyFiltered": "\u0641\u0644\u0679\u0631 \u0635\u0627\u0641 \u06A9\u0631\u0646 \u06CC\u0627 \u06C1\u0646\u062F\u0655\u0631 \u06A9\u064F\u0686\u06BE \u0627\u0648\u0631 \u062A\u0644\u0627\u0634 \u06A9\u0631\u0646",
  "marketplace.emptyNoProducts": "\u06C1\u0646\u0648\u0632 \u06A9\u0648\u0626\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0634\u0627\u0626\u0639 \u0646\u06C1 \u06C1\u0646\u062F\u06D4 \u0698\u0644\u0650\u062F \u0648\u0627\u067E\u0633 \u0622\u06CC\u0648",
  "marketplace.artisanUnnamed": "KalaSetu \u06A9\u0627\u0631\u06CC\u06AF\u0631",
  "marketplace.backToBrowse": "\u0645\u0627\u0631\u06A9\u06CC\u0679 \u067E\u06CC\u0679\u06BE \u0648\u0627\u067E\u0633",
  "marketplace.detailNotFoundTitle": "\u067E\u0631\u0648\u0688\u06A9\u0679 \u0646\u06C1 \u0645\u0644\u0646",
  "marketplace.detailNotFoundMessage": "\u06CC\u06C1 \u067E\u0631\u0648\u0688\u06A9\u0679 \u06C1\u0679\u0627\u0626\u06CC \u06AF\u0654\u06CC \u06C1\u0646\u062F \u06CC\u0627 \u06C1\u0646\u06C1 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1 \u0686\u06BE\u064F",
  "marketplace.artisanSummaryTitle": "\u06C1\u0646\u0631 \u0645\u0646\u062F \u0628\u0627\u0631\u06D2",
  "marketplace.artisanProductCount": "{n} \u067E\u0631\u0648\u0688\u06A9\u0679 \u06A9\u0627\u0644\u0627\u0633\u06CC\u062A\u064F \u067E\u06CC\u0679\u06BE \u0644\u0633\u0679 \u06A9\u0631\u0646",
  "marketplace.inquiryTitle": "\u06CC\u06C1 \u067E\u0631\u0648\u0688\u06A9\u0679 \u0633\u064F\u0646\u062F \u062F\u0644\u0686\u0633\u067E\u06CC \u0686\u06BE\u064F\u061F",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u06A9\u0631\u0627\u0641\u0679 \u06A9\u0627\u0631\u0646 \u0633\u064F\u0646\u062F \u0628\u06CC\u0627\u06BA \u06A9\u0631\u0646 \u06A9\u06C1 \u062A\u064F\u06C1\u0646\u062F \u06A9\u06CC\u0627 \u0636\u0631\u0648\u0631\u062A \u0686\u06BE\u064F: \u0645\u0642\u062F\u0627\u0631\u060C \u062A\u062E\u0635\u06CC\u0635\u060C \u0688\u06CC\u0644\u06CC\u0648\u0631\u06CC \u0679\u0627\u0626\u0645 \u0644\u0627\u0626\u0646...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u067E\u0648\u0686\u06BE \u06AF\u0686\u06BE \u0628\u06BE\u06CC\u0698",
  "marketplace.inquirySent": "\u062A\u064F\u06C1\u0646\u062F \u067E\u0648\u0686\u06BE \u06AF\u0686\u06BE \u0628\u06BE\u06CC\u0698 \u06AF\u0654\u06CC \u06C1\u0646\u062F\u06D4 \u06A9\u0631\u0627\u0641\u0679 \u06A9\u0627\u0631\u0646 \u062A\u064F\u06C1\u0646\u062F \u0633\u064F\u0646\u062F \u0631\u0627\u0628\u0637\u06C1 \u06A9\u0631\u0646\u06D4",
  "marketplace.inquiryError": "\u067E\u0648\u0686\u06BE \u06AF\u0686\u06BE \u0628\u06BE\u06CC\u0698 \u0646\u06C1 \u06C1\u0646\u062F\u060C \u0645\u06C1\u0631\u0628\u0627\u0646\u06CC \u06A9\u0631 \u06A9\u06D2 \u062F\u0648\u0628\u0627\u0631 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u0646",
  "marketplace.regionLabel": "\u0639\u0644\u0627\u0642\u06C1",
  "marketplace.regionUnspecified": "\u063A\u06CC\u0631 \u0645\u062A\u0639\u06CC\u0646",
  "marketplace.myInquiriesTitle": "\u0645\u06CC\u0631\u06CC \u0627\u0633\u062A\u0641\u0633\u0627\u0631",
  "marketplace.inquiriesLoading": "\u062A\u0648\u06C1\u0646\u062F \u067E\u0648\u0686\u06BE \u06AF\u0686\u06BE \u0644\u0648\u0688 \u06A9\u0631\u0627\u0646 \u06C1\u0646\u062F...",
  "marketplace.inquiriesLoadError": "\u062A\u0648\u06C1\u0646\u062F \u067E\u0648\u0686\u06BE \u06AF\u0686\u06BE \u0644\u0648\u0688 \u0646\u06C1 \u06A9\u0631\u0646 \u06C1\u0646\u062F",
  "marketplace.noInquiries": "\u062A\u0648\u06C1\u0646\u062F \u06C1\u0646\u0648\u0632 \u06A9\u064F\u0686\u06BE \u067E\u0648\u0686\u06BE \u06AF\u0686\u06BE \u0646\u06C1 \u0628\u06BE\u06CC\u0698\u0646\u06D4 \u0645\u0627\u0631\u06A9\u06CC\u0679 \u0633\u064F\u0646\u062F \u067E\u0631\u0648\u0688\u06A9\u0679 \u0628\u0631\u0627\u0624\u0632 \u06A9\u0631\u0646 \u06C1\u0646\u062F\u06D4",
  "marketplace.inquiryProductRemoved": "\u06CC\u06C1 \u067E\u0631\u0648\u0688\u06A9\u0679 \u06C1\u0646\u0648\u0632 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1 \u0686\u06BE\u064F",
  "marketplace.inquiryStatusOpen": "\u062C\u0648\u0627\u0628 \u0627\u0646\u062A\u0638\u0627\u0631\u06CC",
  "marketplace.inquiryStatusClosed": "\u0628\u0646\u062F",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/mai.json
var mai_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0905\u092A\u0928 \u0939\u0938\u094D\u0924\u0936\u093F\u0932\u094D\u092A \u0911\u0928\u0932\u093E\u0907\u0928 \u092C\u0947\u091A\u0942, \u0938\u0939\u091C \u0924\u0930\u093F\u0915\u0947 \u0938\u0901.",
  "welcome.languageLabel": "\u0905\u092A\u0928 \u092D\u093E\u0937\u093E \u091A\u0941\u0928\u0942",
  "welcome.getStarted": "\u0936\u0941\u0930\u0942 \u0915\u0930\u0942",
  "language.en": "\u0905\u0902\u0917\u094D\u0930\u0947\u091C\u0940",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "\u0905\u092A\u0928 \u0908\u092E\u0947\u0932 \u092A\u0924\u093E \u0926\u093F\u092F",
  "email.roleQuestion": "\u0939\u092E \u090F\u0924\u090F \u091B\u0940",
  "email.roleSell": "\u0939\u092E\u0930 \u0938\u093E\u092E\u093E\u0928 \u092C\u0947\u091A\u0942",
  "email.roleBuy": "\u0939\u0938\u094D\u0924\u0928\u093F\u0930\u094D\u092E\u093F\u0924 \u0938\u093E\u092E\u093E\u0928 \u0915\u093F\u0928\u0942",
  "email.label": "\u0908\u092E\u0947\u0932 \u092A\u0924\u093E",
  "email.helper": "\u0939\u092E 4 \u0905\u0902\u0915\u094B\u0902 \u0915\u094B\u0921 \u092A\u0920\u093E\u092F\u092C \u091C\u0947 \u0938\u0901 \u092A\u0941\u0937\u094D\u091F\u093F \u0939\u094B\u092F \u091C\u0947 \u0905\u0939\u093E\u0901 \u0938\u094D\u0935\u092F\u0902 \u091B\u0940.",
  "email.invalid": "\u0938\u0939\u0940 \u0908\u092E\u0947\u0932 \u092A\u0924\u093E \u0926\u093F\u092F",
  "email.sendOtp": "\u0915\u094B\u0921 \u092A\u0920\u093E\u0909",
  "email.error": "\u0915\u094B\u0921 \u092A\u0920\u093E\u0913\u0932 \u0928\u0939\u093F \u0917\u0947\u0932, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "otp.title": "\u0905\u092A\u0928 \u0908\u092E\u0947\u0932 \u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u0942",
  "otp.subtitle": "4 \u0905\u0902\u0915\u0930 \u0915\u094B\u0921 \u091C\u0947 \u092D\u0947\u091C\u0932 \u0917\u0947\u0932 \u0905\u091B\u093F, \u0913 \u0926\u0930\u094D\u091C \u0915\u0930\u0942",
  "otp.emailUndelivered": "\u0939\u092E \u0908\u092E\u0947\u0932 \u0928\u0939\u093F \u092A\u0920\u093E \u0938\u0915\u0932\u0939\u0941\u0901\u0964 \u0905\u092A\u0928 \u091F\u0940\u092E \u0938\u0901 \u0921\u0947\u092E\u094B \u0915\u094B\u0921 \u092A\u0941\u091B\u0942\u0964",
  "otp.changeEmail": "\u0908\u092E\u0947\u0932 \u092C\u0926\u0932\u0942",
  "otp.verify": "\u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u0942",
  "otp.invalid": "\u0938\u092D\u0940 4 \u0905\u0902\u0915\u0930 \u0926\u0930\u094D\u091C \u0915\u0930\u0942",
  "otp.wrong": "\u0917\u0932\u0924 OTP, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "otp.resend": "OTP \u0926\u094B\u092C\u093E\u0930\u093E \u092A\u0920\u093E\u0909",
  "otp.resendIn": "OTP \u0926\u094B\u092C\u093E\u0930\u093E \u092A\u0920\u093E\u0909 {n}s \u092E\u0947\u0902",
  "otp.resendError": "OTP \u0926\u094B\u092C\u093E\u0930\u093E \u092A\u0920\u093E \u0928\u0939\u093F \u0938\u0915\u0932, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "camera.capture": "\u092B\u094B\u091F\u094B \u0916\u0940\u0902\u091A\u0942",
  "camera.unavailable": "\u0915\u0948\u092E\u0930\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u093F \u0905\u091B\u093F, \u090F\u0915\u091F\u093E \u092B\u094B\u091F\u094B \u091A\u0941\u0928\u0942\u0964",
  "camera.choosePhoto": "\u092B\u094B\u091F\u094B \u091A\u0941\u0928\u0942",
  "camera.retake": "\u092B\u0947\u0930 \u0932\u0947\u092C",
  "camera.usePhoto": "\u0908 \u092B\u094B\u091F\u094B \u0909\u092A\u092F\u094B\u0917 \u0915\u0930\u0942",
  "camera.enhancing": "\u0906\u092A\u0915 \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u093F \u0930\u0939\u0932 \u091B\u0940...",
  "camera.enhanceError": "\u0906\u092A\u0915 \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u093F \u0928\u0939\u093F \u0938\u0915\u0932",
  "camera.retry": "\u092B\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "camera.before": "\u092E\u0942\u0932",
  "camera.after": "\u0938\u0941\u0927\u093E\u0930\u0932",
  "camera.compareHint": "\u0924\u0941\u0932\u0928\u093E \u0915\u0930\u092C\u093E\u0915 \u0932\u0947\u0932 \u0938\u094D\u0932\u093E\u0907\u0921\u0930 \u0916\u0940\u0902\u091A\u0942",
  "camera.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u0942",
  "studio.title": "\u0905\u092A\u0928 \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0942",
  "studio.original": "\u092E\u0942\u0932",
  "studio.processed": "\u092A\u094D\u0930\u0938\u0902\u0938\u094D\u0915\u0943\u0924",
  "studio.removeBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0909",
  "studio.removingBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0909 \u0930\u0939\u0932 \u0905\u091B\u093F...",
  "studio.keepOriginalBackground": "\u092E\u0942\u0932 \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0930\u0916\u0942",
  "studio.backgroundWhite": "\u0938\u092B\u0947\u0926",
  "studio.backgroundNeutral": "\u0928\u0930\u092E \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0941\u0902\u0927\u0932\u093E",
  "studio.backgroundUnavailableNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092C\u0948 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0948 \u0905\u091B\u093F\u0964 \u0905\u0939\u093E\u0901\u0915 \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u0939\u0932\u0964",
  "studio.backgroundTimedOutNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092C\u0948 \u092E\u0947\u0902 \u092C\u0939\u0941\u0924 \u0938\u092E\u092F \u0932\u0917\u0932, \u090F\u0939\u0940 \u0915\u093E\u0930\u0923 \u091B\u094B\u0921\u093C\u0932 \u0917\u0947\u0932\u0964 \u0905\u0939\u093E\u0901\u0915 \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u0939\u0932\u0964",
  "studio.backgroundQuotaNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092C\u0948 \u0915\u0947 \u0915\u094B\u091F\u093E \u092D\u0930\u093F \u0917\u0947\u0932 \u0905\u091B\u093F\u0964 \u0905\u0939\u093E\u0901\u0915 \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u0939\u0932\u0964",
  "studio.backgroundFailedNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u092C\u092F \u092E\u0947 \u0935\u093F\u092B\u0932\u0964 \u0905\u0939\u093E\u0901\u0915 \u092B\u094B\u091F\u094B \u092C\u0926\u0932\u0932 \u0928\u0939\u093F \u0905\u091B\u093F\u0964",
  "studio.brightness": "\u091A\u092E\u0915",
  "studio.contrast": "\u0935\u093F\u0930\u094B\u0927",
  "studio.sharpen": "\u0924\u0940\u0916\u0930",
  "studio.autoLighting": "\u0911\u091F\u094B \u0932\u093E\u0907\u091F\u093F\u0902\u0917",
  "studio.crop": "\u0915\u091F",
  "studio.cropOriginal": "\u092E\u0942\u0932",
  "studio.cropSquare": "\u0935\u0930\u094D\u0917",
  "studio.cropPortrait": "\u092A\u094B\u0930\u094D\u091F\u094D\u0930\u0947\u091F",
  "studio.accept": "\u090F\u0939\u093F \u092B\u094B\u091F\u094B \u0915\u0947 \u0909\u092A\u092F\u094B\u0917 \u0915\u0930\u0942",
  "studio.retake": "\u092B\u0947\u0930 \u0932\u0947\u092C",
  "studio.finalizing": "\u0938\u0902\u092A\u093E\u0926\u0928 \u0932\u093E\u0917\u0942 \u0915 \u0930\u0939\u0932 \u091B\u0940...",
  "studio.on": "\u091A\u093E\u0932\u0942",
  "studio.off": "\u092C\u0928\u094D\u0926",
  "category.title": "\u0915\u093F\u090F\u0915 \u092C\u0947\u091A \u0930\u0939\u0932 \u091B\u0940?",
  "category.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u0942",
  "category.materialQuestion": "\u0908 \u0915' \u092C\u0928\u0932 \u0905\u091B\u093F? (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "category.textiles": "\u0915\u092A\u0921\u093C\u093E",
  "category.pottery": "\u092E\u093E\u091F\u0940",
  "category.jewelry": "\u0917\u0939\u0928\u093E",
  "category.woodwork": "\u0932\u0915\u0921\u093C\u0940",
  "category.bambooCane": "\u092C\u093E\u0901\u0938 \u0906 \u0915\u093E\u0920",
  "category.other": "\u0905\u0928\u094D\u092F",
  "voice.tapToRecord": "\u0905\u092A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926\u0915 \u0935\u0930\u094D\u0923\u0928 \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u092C\u093E\u0915 \u0932\u0947\u0932 \u091F\u094D\u092F\u093E\u092A \u0915\u0930\u0942",
  "voice.recording": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917...",
  "voice.stop": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u0930\u094B\u0915\u0942",
  "voice.record": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921",
  "voice.reviewRecording": "\u0938\u0941\u0928\u0942, \u092B\u0947\u0930 \u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u0942 \u0905\u0925\u0935\u093E \u092A\u0941\u0928\u0903 \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0942",
  "voice.reRecord": "\u092A\u0941\u0928\u0903 \u0930\u0947\u0915\u0949\u0930\u094D\u0921",
  "voice.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u0942",
  "describe.transcribing": "\u0905\u092A\u0928 \u0935\u093F\u0935\u0930\u0923 \u092C\u0941\u091D\u093F \u0930\u0939\u0932 \u091B\u0940...",
  "describe.transcribeError": "\u0905\u092A\u0928 \u0935\u093F\u0935\u0930\u0923 \u092C\u0941\u091D\u093E \u0928\u0939\u093F \u0938\u0915\u0932",
  "describe.retry": "\u092B\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "describe.reviewHint": "\u0906\u0935\u0936\u094D\u092F\u0915 \u0939\u094B\u090F \u0924' \u0938\u092E\u0940\u0915\u094D\u0937\u093E \u0906 \u0938\u0902\u092A\u093E\u0926\u0928 \u0915\u0930\u0942",
  "describe.fallbackNote": "\u092E\u093E\u0907\u0915\u094D\u0930\u094B\u092B\u094B\u0928 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u093F \u0905\u091B\u093F, \u0924' \u0905\u092A\u0928 \u0935\u093F\u0935\u0930\u0923 \u091F\u093E\u0907\u092A \u0915\u0930\u0942",
  "describe.placeholderEn": "\u0905\u092A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926\u0915 \u0935\u0930\u094D\u0923\u0928 \u0905\u0902\u0917\u094D\u0930\u0947\u091C\u0940 \u092E\u0947\u0902 \u0915\u0930\u0942",
  "describe.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u0942",
  "pricing.title": "\u0905\u092A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926\u0915 \u092E\u0942\u0932\u094D\u092F \u0924\u092F \u0915\u0930\u0942",
  "pricing.summaryEdit": "\u0938\u0902\u092A\u093E\u0926\u0928",
  "pricing.materialCostLabel": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924",
  "pricing.materialCostHelper": "\u0915\u091A\u094D\u091A\u093E \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u092A\u0930 \u0916\u0930\u094D\u091A \u0915\u090F\u0932 \u0930\u093E\u0936\u093F, \u0930\u0941\u092A\u0948\u092F\u093E \u092E\u0947\u0902 \u0926\u0930\u094D\u091C \u0915\u0930\u0942",
  "pricing.materialCostInvalid": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924 0 \u0938\u0901 \u092C\u0947\u0938\u0940 \u0926\u0930\u094D\u091C \u0915\u0930\u0942",
  "pricing.getSuggestion": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935 \u092A\u094D\u0930\u093E\u092A\u094D\u0924 \u0915\u0930\u0942",
  "pricing.suggestError": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935 \u092A\u094D\u0930\u093E\u092A\u094D\u0924 \u0928\u0939\u093F \u092D' \u0938\u0915\u0932",
  "pricing.retry": "\u092B\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "pricing.rangeLabel": "\u0938\u0941\u091D\u093E\u0935\u093F\u0924 \u092E\u0942\u0932\u094D\u092F \u0938\u0940\u092E\u093E",
  "pricing.sellingPriceLabel": "\u0906\u092A\u0928 \u092C\u093F\u0915\u094D\u0930\u0940 \u092E\u0942\u0932\u094D\u092F",
  "pricing.sellingPriceNote": "\u0908 \u0938\u0941\u091D\u093E\u0935 \u092E\u093E\u0924\u094D\u0930 \u0905\u091B\u093F, \u0905\u0939\u093E\u0901 \u092E\u0928\u092A\u0938\u0902\u0926 \u092E\u0942\u0932\u094D\u092F \u0938\u0947\u091F \u0915' \u0938\u0915\u0948 \u091B\u0940\u0964",
  "pricing.sellingPriceInvalid": "\u092C\u093F\u0915\u094D\u0930\u0940 \u092E\u0942\u0932\u094D\u092F 0 \u0938\u0901 \u092C\u0947\u0938\u0940 \u0926\u0930\u094D\u091C \u0915\u0930\u0942",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0915\u0930\u0942",
  "pricing.publishError": "\u0905\u0939\u093E\u0901\u0915 \u0909\u0924\u094D\u092A\u093E\u0926 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0928\u0939\u093F \u092D' \u0938\u0915\u0932",
  "pricing.successTitle": "\u0905\u0939\u093E\u0901\u0915 \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u093E\u0907\u0935 \u092D' \u0917\u0947\u0932!",
  "pricing.successMessage": "\u0916\u0930\u0940\u0926\u0926\u093E\u0930 \u0906\u092C \u0905\u0939\u093E\u0901\u0915 \u0926\u0942\u0915\u093E\u0928 \u092E\u0947\u0902 \u090F\u0915\u0930\u093E \u092D\u0947\u091F \u0938\u0915\u0948\u0924 \u091B\u0925\u093F\u0964",
  "pricing.viewShop": "\u092E\u094B\u0930 \u0926\u0942\u0915\u093E\u0928 \u092E\u0947\u0902 \u0926\u0947\u0916\u0942",
  "home.title": "\u092E\u094B\u0930 \u0926\u0942\u0915\u093E\u0928",
  "home.gemBannerTitle": "GeM / ONDC \u0938\u0901 \u091C\u0941\u0921\u093C\u0942",
  "home.gemBannerBadge": "\u091C\u0932\u094D\u0926\u0947 \u0906\u092C\u093F \u0930\u0939\u0932 \u0905\u091B\u093F",
  "home.gemBannerMessage": "\u0908 \u090F\u0915\u0940\u0915\u0930\u0923 \u091C\u0932\u094D\u0926\u0947 \u0906\u092C\u093F \u0930\u0939\u0932 \u0905\u091B\u093F.",
  "home.loading": "\u0905\u092A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u094B\u0921 \u092D' \u0930\u0939\u0932 \u0905\u091B\u093F...",
  "home.loadError": "\u0905\u092A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926 \u0932\u094B\u0921 \u0928\u0939\u093F \u092D' \u0938\u0915\u0932",
  "home.retry": "\u092B\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "home.emptyTitle": "\u0905\u0939\u093F\u0928\u093E \u0915\u093F\u091B\u0941 \u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0939\u093F",
  "home.emptyMessage": "KalaSetu \u092A\u0930 \u092C\u0947\u091A\u092C\u093E\u0915 \u0906\u0930\u092E\u094D\u092D \u0915\u0930\u092C\u093E\u0915 \u0932\u0947\u0932 \u092A\u0939\u093F\u0932 \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u094B\u0921\u093C\u0942.",
  "home.addFirstProduct": "\u092A\u0939\u093F\u0932 \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u094B\u0921\u093C\u0942",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u092E\u0938\u094C\u0926\u093E",
  "home.statusFailed": "\u0905\u0938\u092B\u0932",
  "home.detailCategory": "\u0936\u094D\u0930\u0947\u0923\u0940",
  "home.detailEdit": "\u0938\u0902\u092A\u093E\u0926\u093F\u0924",
  "home.detailDelete": "\u0939\u091F\u093E\u0909",
  "home.detailClose": "\u092C\u0928\u094D\u0926",
  "home.editPriceLabel": "\u092E\u0942\u0932\u094D\u092F",
  "home.editDescriptionLabel": "\u0935\u093F\u0935\u0930\u0923",
  "home.editSave": "\u092C\u0926\u0932\u093E\u0935 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924",
  "home.editCancel": "\u0930\u0926\u094D\u0926",
  "home.editPriceInvalid": "0 \u0938\u0901 \u092C\u0947\u0938\u0940 \u092E\u0942\u0932\u094D\u092F \u0926\u0930\u094D\u091C \u0915\u0930\u0942",
  "home.editDescriptionRequired": "\u0915\u0941\u0928\u094B \u092D\u093E\u0937\u093E \u092E\u0947 \u0935\u093F\u0935\u0930\u0923 \u0916\u093E\u0932\u0940 \u0928\u0939\u093F \u0930\u0939\u093F \u0938\u0915\u0948\u0924",
  "home.editError": "\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u0938\u0939\u0947\u091C \u0928\u0939\u093F \u092D' \u0938\u0915\u0932, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "home.deleteConfirm": "\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u0939\u091F\u093E\u0909? \u0908 \u092B\u0947\u0930 \u0938\u0901 \u0928\u0939\u093F \u0939\u094B\u092F\u0924",
  "home.deleteConfirmYes": "\u0939\u0901, \u0939\u091F\u093E\u0909",
  "home.deleteError": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0939\u091F\u093E\u0913 \u0928\u0939\u093F \u092D' \u0938\u0915\u0932, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932",
  "profile.emailLabel": "\u0908\u092E\u0947\u0932 \u092A\u0924\u093E",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u093F",
  "profile.loading": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0932\u094B\u0921 \u092D' \u0930\u0939\u0932 \u0905\u091B\u093F...",
  "profile.loadError": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0932\u094B\u0921 \u0928\u0939\u093F \u092D' \u0938\u0915\u0932",
  "profile.displayNameLabel": "\u0905\u092A\u0928 \u0928\u093E\u092E",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928\u0915 \u0928\u093E\u092E",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0939\u0947\u091C\u0942",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924 \u092D' \u0917\u0947\u0932",
  "profile.saveError": "\u0905\u092A\u0928 \u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924 \u0928\u0939\u093F \u092D' \u0938\u0915\u0932, \u092B\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "profile.logout": "\u092C\u093E\u0939\u0930 \u0928\u093F\u0915\u0932\u0942",
  "install.message": "\u091C\u0932\u094D\u0926\u0940 \u092A\u0939\u0941\u0901\u091A \u0932\u0947\u0932 KalaSetu \u0938\u094D\u0925\u093E\u092A\u093F\u0924 \u0915\u0930\u0942",
  "install.action": "\u0938\u094D\u0925\u093E\u092A\u093F\u0924 \u0915\u0930\u0942",
  "install.dismiss": "\u0930\u0926\u094D\u0926 \u0915\u0930\u0942",
  "offline.message": "\u0905\u0939\u093E\u0901 \u0911\u092B\u0932\u093E\u0907\u0928 \u091B\u0940, \u0915\u093F\u091B\u0941 \u0938\u0941\u0935\u093F\u0927\u093E \u0915\u093E\u091C \u0928\u0939\u093F \u0915\u0930\u093F \u0938\u0915\u0948\u0924 \u0905\u091B\u093F",
  "welcome.languageHint": "\u092A\u0942\u0930\u093E \u090F\u092A \u090F\u0939\u093F \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0939\u094B\u092F\u0924",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E",
  "describe.localTab": "\u0905\u092A\u0928 \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0905\u092A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926 \u0915\u0947\u0901 \u0905\u092A\u0928 \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0935\u0930\u094D\u0923\u0928 \u0915\u0930\u0942",
  "describe.syncing": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u092D' \u0930\u0939\u0932 \u0905\u091B\u093F...",
  "describe.syncFailed": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0928\u0939\u093F \u092D' \u0938\u0915\u0932\u0964 \u091C\u093C\u0930\u0942\u0930\u0924 \u0939\u094B\u090F \u0924' \u0938\u094D\u0935\u092F\u0902 \u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u0942\u0964",
  "describe.syncHint": "\u0938\u0902\u092A\u093E\u0926\u0928 \u0938\u094D\u0935\u0924\u0903 \u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u092E\u0947\u0902 \u0915\u0949\u092A\u0940 \u092D' \u091C\u093E\u092F\u0924\u0964",
  "pricing.updating": "\u0928\u0935\u0940\u0928 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924\u0915 \u0932\u0947\u0932 \u0905\u092A\u0921\u0947\u091F \u092D' \u0930\u0939\u0932 \u0905\u091B\u093F...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u0905\u092A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926 \u0938\u092D \u0915\u0947\u0901 \u090F\u0939\u093F \u092D\u093E\u0937\u093E \u092E\u0947 \u0905\u092A\u0921\u0947\u091F \u0915 \u0930\u0939\u0932 \u091B\u0940...",
  "profile.relocalised": "{n} \u0909\u0924\u094D\u092A\u093E\u0926 \u0938\u092D \u0915\u0947\u0901 \u090F\u0939\u093F \u092D\u093E\u0937\u093E \u092E\u0947 \u0905\u092A\u0921\u0947\u091F \u0915\u090F\u0932 \u0917\u0947\u0932\u0964",
  "profile.relocaliseFailed": "\u0915\u093F\u091B\u0941 \u0909\u0924\u094D\u092A\u093E\u0926 \u0905\u092A\u0921\u0947\u091F \u0928\u0939\u093F \u092D' \u0938\u0915\u0932\u0964 \u092B\u0947\u0930 \u0938\u0901 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942\u0964",
  "marketplace.navBrowse": "\u092C\u094D\u0930\u093E\u0909\u091C\u093C",
  "marketplace.navProfile": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932",
  "marketplace.browseTitle": "\u092C\u093E\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u094B\u091C\u0942...",
  "marketplace.filtersTitle": "\u092B\u093C\u093F\u0932\u094D\u091F\u0930",
  "marketplace.filtersClear": "\u0938\u092C \u0938\u093E\u092B \u0915\u0930\u0942",
  "marketplace.filterAll": "\u0938\u092C",
  "marketplace.filterMaterial": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "marketplace.filterRegion": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.filterPrice": "\u0915\u0940\u092E\u0924 \u0938\u0940\u092E\u093E (\u20B9)",
  "marketplace.filterPriceMin": "\u0928\u094D\u092F\u0942\u0928\u0924\u092E",
  "marketplace.filterPriceMax": "\u0905\u0927\u093F\u0915\u0924\u092E",
  "marketplace.sortLabel": "\u0915\u094D\u0930\u092E \u0905\u0928\u0941\u0938\u093E\u0930",
  "marketplace.sortNewest": "\u0928\u0935\u0940\u0928\u0924\u092E \u092A\u0939\u093F\u0928\u0947",
  "marketplace.sortPriceAsc": "\u0915\u0940\u092E\u0924: \u0915\u092E \u0938\u0901 \u0905\u0927\u093F\u0915",
  "marketplace.sortPriceDesc": "\u0915\u0940\u092E\u0924: \u0905\u0927\u093F\u0915 \u0938\u0901 \u0915\u092E",
  "marketplace.resultCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926 \u092D\u0947\u091F\u0932",
  "marketplace.loadMore": "\u0906\u0909\u0930 \u0932\u094B\u0921 \u0915\u0930\u0942",
  "marketplace.loadError": "\u092C\u093E\u091C\u093E\u0930 \u0932\u094B\u0921 \u0928\u0939\u093F \u092D' \u0938\u0915\u0932, \u0915\u0943\u092A\u092F\u093E \u092B\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "marketplace.emptyTitle": "\u090F\u0939\u093F \u092B\u093F\u0932\u094D\u091F\u0930 \u0938\u0901 \u0915\u094B\u0928\u094B \u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0939\u093F \u092D\u0947\u091F\u0932",
  "marketplace.emptyFiltered": "\u092B\u093F\u0932\u094D\u091F\u0930 \u0939\u091F\u093E\u0909 \u092F\u093E \u0926\u094B\u0938\u0930 \u0915\u093F\u091B\u0941 \u0916\u094B\u091C\u0942\u0964",
  "marketplace.emptyNoProducts": "\u0905\u092D\u0940 \u0924\u0915 \u0915\u094B\u0928\u094B \u0909\u0924\u094D\u092A\u093E\u0926 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0928\u0939\u093F \u092D\u0947\u0932 \u0905\u091B\u093F\u0964 \u0936\u0940\u0918\u094D\u0930 \u0926\u0947\u0916\u0942\u0964",
  "marketplace.artisanUnnamed": "KalaSetu \u0915\u093E\u0930\u0940\u0917\u0930",
  "marketplace.backToBrowse": "\u092C\u093E\u091C\u093E\u0930 \u092A\u0930 \u0935\u093E\u092A\u0938",
  "marketplace.detailNotFoundTitle": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0928\u0939\u093F \u092D\u0947\u091F\u0932",
  "marketplace.detailNotFoundMessage": "\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u0939\u091F\u093E\u092F\u0932 \u0917\u0947\u0932 \u0939\u094B\u0907 \u0938\u0915\u0948\u0924 \u0905\u091B\u093F \u092F\u093E \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u093F \u0905\u091B\u093F\u0964",
  "marketplace.artisanSummaryTitle": "\u0915\u093E\u0930\u0940\u0917\u0930\u0915 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902",
  "marketplace.artisanProductCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926 KalaSetu \u092A\u0930 \u0938\u0942\u091A\u0940\u092C\u0926\u094D\u0927",
  "marketplace.inquiryTitle": "\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u092E\u0947\u0902 \u0930\u0941\u091A\u093F \u0905\u091B\u093F?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0915\u093E\u0930\u0940\u0917\u0930 \u0915\u0947\u0901 \u092C\u0924\u093E\u0909 \u091C\u0947 \u0905\u0939\u093E\u0901 \u0915\u0940 \u091A\u093E\u0939\u0940: \u092E\u093E\u0924\u094D\u0930\u093E, \u0905\u0928\u0941\u0915\u0942\u0932\u0928, \u0921\u093F\u0932\u093F\u0935\u0930\u0940 \u0938\u092E\u092F...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u092A\u0942\u091B\u0924\u093E\u091B \u092D\u0947\u091C\u0942",
  "marketplace.inquirySent": "\u0905\u0939\u093E\u0901\u0915 \u092A\u0942\u091B\u0924\u093E\u091B \u092D\u0947\u091C\u0932 \u0917\u0947\u0932 \u0905\u091B\u093F\u0964 \u0915\u093E\u0930\u0940\u0917\u0930 \u0936\u0940\u0918\u094D\u0930 \u0938\u0902\u092A\u0930\u094D\u0915 \u0915\u0930\u0925\u093F\u0928\u0964",
  "marketplace.inquiryError": "\u092A\u0942\u091B\u0924\u093E\u091B \u092D\u0947\u091C\u093F \u0928\u0939\u093F \u0938\u0915\u0932, \u0915\u0943\u092A\u092F\u093E \u092B\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0942",
  "marketplace.regionLabel": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.regionUnspecified": "\u0928\u093F\u0930\u094D\u0926\u093F\u0937\u094D\u091F \u0928\u0939\u093F",
  "marketplace.myInquiriesTitle": "\u0939\u092E\u0930 \u092A\u0942\u091B\u0924\u093E\u091B",
  "marketplace.inquiriesLoading": "\u0905\u092A\u0928 \u092A\u0942\u091B\u0924\u093E\u091B \u0932\u094B\u0921 \u0915' \u0930\u0939\u0932 \u091B\u0940...",
  "marketplace.inquiriesLoadError": "\u0905\u092A\u0928 \u092A\u0942\u091B\u0924\u093E\u091B \u0932\u094B\u0921 \u0928\u0939\u093F \u0915' \u0938\u0915\u0932",
  "marketplace.noInquiries": "\u0905\u0939\u093E\u0902 \u090F\u0916\u0928 \u0927\u0930\u093F \u0915\u094B\u0928\u094B \u092A\u0942\u091B\u0924\u093E\u091B \u0928\u0939\u093F \u092A\u0920\u0947\u0932\u0939\u0941\u0901\u0964 \u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u094B\u091C\u092F \u0932\u0947\u0932 \u092E\u093E\u0930\u094D\u0915\u0947\u091F\u092A\u094D\u0932\u0947\u0938 \u0926\u0947\u0916\u0942\u0964",
  "marketplace.inquiryProductRemoved": "\u0908 \u0909\u0924\u094D\u092A\u093E\u0926 \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u0939\u093F \u0905\u091B\u093F",
  "marketplace.inquiryStatusOpen": "\u091C\u0935\u093E\u092C\u0915 \u092A\u094D\u0930\u0924\u0940\u0915\u094D\u0937\u093E",
  "marketplace.inquiryStatusClosed": "\u092C\u0902\u0926",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/ml.json
var ml_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D15\u0D30\u0D15\u0D57\u0D36\u0D32\u0D19\u0D4D\u0D19\u0D7E \u0D13\u0D7A\u0D32\u0D48\u0D28\u0D3F\u0D7D, \u0D0E\u0D33\u0D41\u0D2A\u0D4D\u0D2A\u0D24\u0D4D\u0D24\u0D3F\u0D7D \u0D35\u0D3F\u0D31\u0D4D\u0D31\u0D34\u0D3F\u0D15\u0D4D\u0D15\u0D42.",
  "welcome.languageLabel": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2D\u0D3E\u0D37 \u0D24\u0D3F\u0D30\u0D1E\u0D4D\u0D1E\u0D46\u0D1F\u0D41\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "welcome.getStarted": "\u0D06\u0D30\u0D02\u0D2D\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "language.en": "\u0D07\u0D02\u0D17\u0D4D\u0D32\u0D40\u0D37\u0D4D",
  "language.hi": "\u0D39\u0D3F\u0D28\u0D4D\u0D26\u0D3F",
  "email.title": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D07\u0D2E\u0D46\u0D2F\u0D3F\u0D7D \u0D35\u0D3F\u0D32\u0D3E\u0D38\u0D02 \u0D28\u0D7D\u0D15\u0D41\u0D15",
  "email.roleQuestion": "\u0D1E\u0D3E\u0D7B \u0D07\u0D35\u0D3F\u0D1F\u0D46",
  "email.roleSell": "\u0D0E\u0D28\u0D4D\u0D31\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D35\u0D3F\u0D7D\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "email.roleBuy": "\u0D15\u0D48\u0D24\u0D4D\u0D24\u0D4A\u0D34\u0D3F\u0D7D \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D35\u0D3E\u0D19\u0D4D\u0D19\u0D41\u0D15",
  "email.label": "\u0D07\u0D2E\u0D46\u0D2F\u0D3F\u0D7D \u0D35\u0D3F\u0D32\u0D3E\u0D38\u0D02",
  "email.helper": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D3E\u0D23\u0D46\u0D28\u0D4D\u0D28\u0D4D \u0D09\u0D31\u0D2A\u0D4D\u0D2A\u0D3E\u0D15\u0D4D\u0D15\u0D3E\u0D7B 4 \u0D05\u0D15\u0D4D\u0D15 \u0D15\u0D4B\u0D21\u0D4D \u0D1E\u0D19\u0D4D\u0D19\u0D7E \u0D05\u0D2F\u0D15\u0D4D\u0D15\u0D41\u0D02.",
  "email.invalid": "\u0D36\u0D30\u0D3F\u0D2F\u0D3E\u0D2F \u0D07\u0D2E\u0D46\u0D2F\u0D3F\u0D7D \u0D35\u0D3F\u0D32\u0D3E\u0D38\u0D02 \u0D28\u0D7D\u0D15\u0D41\u0D15",
  "email.sendOtp": "\u0D15\u0D4B\u0D21\u0D4D \u0D05\u0D2F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "email.error": "\u0D15\u0D4B\u0D21\u0D4D \u0D05\u0D2F\u0D2F\u0D4D\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32, \u0D26\u0D2F\u0D35\u0D3E\u0D2F\u0D3F \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "otp.title": "\u0D07\u0D2E\u0D46\u0D2F\u0D3F\u0D7D \u0D38\u0D4D\u0D25\u0D3F\u0D30\u0D40\u0D15\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "otp.subtitle": "\u0D05\u0D2F\u0D1A\u0D4D\u0D1A 4 \u0D05\u0D15\u0D4D\u0D15 \u0D15\u0D4B\u0D21\u0D4D \u0D28\u0D7D\u0D15\u0D41\u0D15",
  "otp.emailUndelivered": "\u0D07\u0D2E\u0D46\u0D2F\u0D3F\u0D7D \u0D05\u0D2F\u0D2F\u0D4D\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32. \u0D21\u0D46\u0D2E\u0D4B \u0D15\u0D4B\u0D21\u0D3F\u0D28\u0D3E\u0D2F\u0D3F \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D1F\u0D40\u0D2E\u0D3F\u0D28\u0D46 \u0D1A\u0D4B\u0D26\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15.",
  "otp.changeEmail": "\u0D07\u0D2E\u0D46\u0D2F\u0D3F\u0D7D \u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D41\u0D15",
  "otp.verify": "\u0D38\u0D4D\u0D25\u0D3F\u0D30\u0D40\u0D15\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "otp.invalid": "\u0D0E\u0D32\u0D4D\u0D32\u0D3E 4 \u0D05\u0D15\u0D4D\u0D15\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D02 \u0D28\u0D7D\u0D15\u0D41\u0D15",
  "otp.wrong": "\u0D24\u0D46\u0D31\u0D4D\u0D31\u0D3E\u0D2F OTP, \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "otp.resend": "OTP \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D05\u0D2F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "otp.resendIn": "OTP {n} \u0D38\u0D46\u0D15\u0D4D\u0D15\u0D7B\u0D21\u0D3F\u0D7D \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D05\u0D2F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "otp.resendError": "OTP \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D05\u0D2F\u0D2F\u0D4D\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32, \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "camera.capture": "\u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D0E\u0D1F\u0D41\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "camera.unavailable": "\u0D15\u0D4D\u0D2F\u0D3E\u0D2E\u0D31 \u0D32\u0D2D\u0D4D\u0D2F\u0D2E\u0D32\u0D4D\u0D32, \u0D2A\u0D15\u0D30\u0D02 \u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D24\u0D3F\u0D30\u0D1E\u0D4D\u0D1E\u0D46\u0D1F\u0D41\u0D15\u0D4D\u0D15\u0D41\u0D15.",
  "camera.choosePhoto": "\u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D24\u0D3F\u0D30\u0D1E\u0D4D\u0D1E\u0D46\u0D1F\u0D41\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "camera.retake": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D0E\u0D1F\u0D41\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "camera.usePhoto": "\u0D08 \u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D09\u0D2A\u0D2F\u0D4B\u0D17\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "camera.enhancing": "\u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D2E\u0D46\u0D1A\u0D4D\u0D1A\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D41\u0D24\u0D4D\u0D24\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "camera.enhanceError": "\u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D2E\u0D46\u0D1A\u0D4D\u0D1A\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D41\u0D24\u0D4D\u0D24\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32",
  "camera.retry": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "camera.before": "\u0D2E\u0D42\u0D32",
  "camera.after": "\u0D2E\u0D46\u0D1A\u0D4D\u0D1A\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D41\u0D24\u0D4D\u0D24\u0D3F\u0D2F",
  "camera.compareHint": "\u0D24\u0D42\u0D15\u0D4D\u0D15\u0D3F \u0D24\u0D3E\u0D30\u0D24\u0D2E\u0D4D\u0D2F\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D38\u0D4D\u0D32\u0D48\u0D21\u0D7C \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "camera.continue": "\u0D24\u0D41\u0D1F\u0D30\u0D41\u0D15",
  "studio.title": "\u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D2E\u0D46\u0D1A\u0D4D\u0D1A\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D41\u0D24\u0D4D\u0D24\u0D41\u0D15",
  "studio.original": "\u0D05\u0D38\u0D7D",
  "studio.processed": "\u0D2A\u0D4D\u0D30\u0D4B\u0D38\u0D38\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D24",
  "studio.removeBackground": "\u0D2A\u0D36\u0D4D\u0D1A\u0D3E\u0D24\u0D4D\u0D24\u0D32\u0D02 \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15",
  "studio.removingBackground": "\u0D2A\u0D36\u0D4D\u0D1A\u0D3E\u0D24\u0D4D\u0D24\u0D32\u0D02 \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "studio.keepOriginalBackground": "\u0D05\u0D38\u0D7D \u0D2A\u0D36\u0D4D\u0D1A\u0D3E\u0D24\u0D4D\u0D24\u0D32\u0D02 \u0D28\u0D3F\u0D32\u0D28\u0D3F\u0D7C\u0D24\u0D4D\u0D24\u0D41\u0D15",
  "studio.backgroundWhite": "\u0D35\u0D46\u0D33\u0D41\u0D2A\u0D4D\u0D2A\u0D4D",
  "studio.backgroundNeutral": "\u0D2E\u0D43\u0D26\u0D41\u0D35\u0D3E\u0D2F \u0D15\u0D4D\u0D30\u0D40\u0D02",
  "studio.backgroundBlur": "\u0D2E\u0D19\u0D4D\u0D19\u0D7D",
  "studio.backgroundUnavailableNotice": "\u0D2A\u0D36\u0D4D\u0D1A\u0D3E\u0D24\u0D4D\u0D24\u0D32\u0D02 \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D7D \u0D07\u0D2A\u0D4D\u0D2A\u0D4B\u0D7E \u0D32\u0D2D\u0D4D\u0D2F\u0D2E\u0D32\u0D4D\u0D32. \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D2E\u0D3F\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D46 \u0D24\u0D41\u0D1F\u0D30\u0D41\u0D28\u0D4D\u0D28\u0D41.",
  "studio.backgroundTimedOutNotice": "\u0D2A\u0D36\u0D4D\u0D1A\u0D3E\u0D24\u0D4D\u0D24\u0D32\u0D02 \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D38\u0D2E\u0D2F\u0D02 \u0D05\u0D27\u0D3F\u0D15\u0D02 \u0D0E\u0D1F\u0D41\u0D24\u0D4D\u0D24\u0D41, \u0D05\u0D24\u0D3F\u0D28\u0D3E\u0D7D \u0D12\u0D34\u0D3F\u0D35\u0D3E\u0D15\u0D4D\u0D15\u0D3F. \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D2E\u0D3F\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D46 \u0D24\u0D41\u0D1F\u0D30\u0D41\u0D28\u0D4D\u0D28\u0D41.",
  "studio.backgroundQuotaNotice": "\u0D2A\u0D36\u0D4D\u0D1A\u0D3E\u0D24\u0D4D\u0D24\u0D32\u0D02 \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D28\u0D41\u0D33\u0D4D\u0D33 \u0D2A\u0D30\u0D3F\u0D27\u0D3F \u0D24\u0D3F\u0D15\u0D1E\u0D4D\u0D1E\u0D41. \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D2E\u0D3F\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D46 \u0D24\u0D41\u0D1F\u0D30\u0D41\u0D28\u0D4D\u0D28\u0D41.",
  "studio.backgroundFailedNotice": "\u0D2A\u0D36\u0D4D\u0D1A\u0D3E\u0D24\u0D4D\u0D24\u0D32 \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D2A\u0D30\u0D3E\u0D1C\u0D2F\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D4D\u0D1F\u0D41. \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D2E\u0D3F\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D46 \u0D24\u0D41\u0D1F\u0D30\u0D41\u0D28\u0D4D\u0D28\u0D41.",
  "studio.brightness": "\u0D2A\u0D4D\u0D30\u0D15\u0D3E\u0D36\u0D02",
  "studio.contrast": "\u0D35\u0D4D\u0D2F\u0D24\u0D4D\u0D2F\u0D3E\u0D38\u0D02",
  "studio.sharpen": "\u0D2E\u0D41\u0D31\u0D41\u0D15\u0D46",
  "studio.autoLighting": "\u0D38\u0D4D\u0D35\u0D2F\u0D2A\u0D4D\u0D30\u0D15\u0D3E\u0D36\u0D02",
  "studio.crop": "\u0D15\u0D41\u0D31\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "studio.cropOriginal": "\u0D2E\u0D42\u0D32",
  "studio.cropSquare": "\u0D1A\u0D24\u0D41\u0D30\u0D02",
  "studio.cropPortrait": "\u0D2A\u0D4B\u0D7C\u0D1F\u0D4D\u0D30\u0D46\u0D2F\u0D3F\u0D31\u0D4D\u0D31\u0D4D",
  "studio.accept": "\u0D08 \u0D2B\u0D4B\u0D1F\u0D4D\u0D1F\u0D4B \u0D09\u0D2A\u0D2F\u0D4B\u0D17\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "studio.retake": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D0E\u0D1F\u0D41\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "studio.finalizing": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D24\u0D3F\u0D30\u0D41\u0D24\u0D4D\u0D24\u0D32\u0D41\u0D15\u0D7E \u0D2A\u0D4D\u0D30\u0D2F\u0D4B\u0D17\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "studio.on": "\u0D13\u0D7A",
  "studio.off": "\u0D13\u0D2B\u0D4D",
  "category.title": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D7E \u0D0E\u0D28\u0D4D\u0D24\u0D3E\u0D23\u0D4D \u0D35\u0D3F\u0D31\u0D4D\u0D31\u0D34\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D28\u0D4D\u0D28\u0D24\u0D4D?",
  "category.continue": "\u0D24\u0D41\u0D1F\u0D30\u0D41\u0D15",
  "category.materialQuestion": "\u0D07\u0D24\u0D4D \u0D0E\u0D28\u0D4D\u0D24\u0D3E\u0D23\u0D4D \u0D28\u0D3F\u0D7C\u0D2E\u0D4D\u0D2E\u0D3F\u0D1A\u0D4D\u0D1A\u0D24\u0D4D? (\u0D10\u0D1A\u0D4D\u0D1B\u0D3F\u0D15\u0D02)",
  "category.textiles": "\u0D35\u0D38\u0D4D\u0D24\u0D4D\u0D30\u0D19\u0D4D\u0D19\u0D7E",
  "category.pottery": "\u0D2E\u0D23\u0D4D\u0D23\u0D41\u0D2A\u0D3E\u0D24\u0D4D\u0D30\u0D02",
  "category.jewelry": "\u0D06\u0D2D\u0D30\u0D23\u0D19\u0D4D\u0D19\u0D7E",
  "category.woodwork": "\u0D2E\u0D30\u0D02\u0D2A\u0D23\u0D3F",
  "category.bambooCane": "\u0D2E\u0D41\u0D33\u0D2F\u0D41\u0D02 \u0D1A\u0D42\u0D30\u0D32\u0D41\u0D02",
  "category.other": "\u0D2E\u0D31\u0D4D\u0D31\u0D41\u0D33\u0D4D\u0D33\u0D35",
  "voice.tapToRecord": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D24\u0D4D\u0D24\u0D3F\u0D28\u0D4D\u0D31\u0D46 \u0D35\u0D3F\u0D35\u0D30\u0D23\u0D02 \u0D31\u0D46\u0D15\u0D4D\u0D15\u0D4B\u0D7C\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D24\u0D1F\u0D4D\u0D1F\u0D41\u0D15",
  "voice.recording": "\u0D31\u0D46\u0D15\u0D4D\u0D15\u0D4B\u0D7C\u0D21\u0D3F\u0D02\u0D17\u0D4D...",
  "voice.stop": "\u0D31\u0D46\u0D15\u0D4D\u0D15\u0D4B\u0D7C\u0D21\u0D3F\u0D02\u0D17\u0D4D \u0D28\u0D3F\u0D7C\u0D24\u0D4D\u0D24\u0D41\u0D15",
  "voice.record": "\u0D31\u0D46\u0D15\u0D4D\u0D15\u0D4B\u0D7C\u0D21\u0D4D",
  "voice.reviewRecording": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D15\u0D47\u0D7E\u0D15\u0D4D\u0D15\u0D41\u0D15, \u0D2A\u0D3F\u0D28\u0D4D\u0D28\u0D46 \u0D24\u0D41\u0D1F\u0D30\u0D41\u0D15 \u0D05\u0D32\u0D4D\u0D32\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D7D \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D31\u0D46\u0D15\u0D4D\u0D15\u0D4B\u0D7C\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15.",
  "voice.reRecord": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D31\u0D46\u0D15\u0D4D\u0D15\u0D4B\u0D7C\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15",
  "voice.continue": "\u0D24\u0D41\u0D1F\u0D30\u0D41\u0D15",
  "describe.transcribing": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D35\u0D3F\u0D35\u0D30\u0D23\u0D02 \u0D2E\u0D28\u0D38\u0D4D\u0D38\u0D3F\u0D32\u0D3E\u0D15\u0D4D\u0D15\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "describe.transcribeError": "\u0D35\u0D3F\u0D35\u0D30\u0D23\u0D02 \u0D2E\u0D28\u0D38\u0D4D\u0D38\u0D3F\u0D32\u0D3E\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32",
  "describe.retry": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "describe.reviewHint": "\u0D06\u0D35\u0D36\u0D4D\u0D2F\u0D2E\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D7D \u0D2A\u0D30\u0D3F\u0D36\u0D4B\u0D27\u0D3F\u0D1A\u0D4D\u0D1A\u0D4D \u0D24\u0D3F\u0D30\u0D41\u0D24\u0D4D\u0D24\u0D41\u0D15",
  "describe.fallbackNote": "\u0D2E\u0D48\u0D15\u0D4D\u0D30\u0D4B\u0D2B\u0D4B\u0D7A \u0D32\u0D2D\u0D4D\u0D2F\u0D2E\u0D32\u0D4D\u0D32, \u0D05\u0D24\u0D3F\u0D28\u0D4D\u0D31\u0D46 \u0D2A\u0D15\u0D30\u0D02 \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D35\u0D3F\u0D35\u0D30\u0D23\u0D02 \u0D1F\u0D48\u0D2A\u0D4D\u0D2A\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15.",
  "describe.placeholderEn": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D07\u0D02\u0D17\u0D4D\u0D32\u0D40\u0D37\u0D3F\u0D7D \u0D35\u0D3F\u0D35\u0D30\u0D23\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15",
  "describe.continue": "\u0D24\u0D41\u0D1F\u0D30\u0D41\u0D15",
  "pricing.title": "\u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D24\u0D4D\u0D24\u0D3F\u0D28\u0D4D\u0D31\u0D46 \u0D35\u0D3F\u0D32 \u0D28\u0D3F\u0D36\u0D4D\u0D1A\u0D2F\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "pricing.summaryEdit": "\u0D24\u0D3F\u0D30\u0D41\u0D24\u0D4D\u0D24\u0D41\u0D15",
  "pricing.materialCostLabel": "\u0D35\u0D38\u0D4D\u0D24\u0D41 \u0D1A\u0D46\u0D32\u0D35\u0D4D",
  "pricing.materialCostHelper": "\u0D31\u0D42\u0D2A\u0D4D\u0D2A\u0D3F\u0D15\u0D33\u0D3F\u0D7D \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D7E \u0D1A\u0D46\u0D32\u0D35\u0D34\u0D3F\u0D1A\u0D4D\u0D1A \u0D2E\u0D57\u0D32\u0D3F\u0D15 \u0D35\u0D38\u0D4D\u0D24\u0D41\u0D15\u0D4D\u0D15\u0D33\u0D41\u0D1F\u0D46 \u0D24\u0D41\u0D15 \u0D28\u0D7D\u0D15\u0D41\u0D15.",
  "pricing.materialCostInvalid": "\u0D2A\u0D42\u0D1C\u0D4D\u0D2F\u0D02\u0D15\u0D4D\u0D15\u0D3E\u0D7E \u0D15\u0D42\u0D1F\u0D41\u0D24\u0D32\u0D41\u0D33\u0D4D\u0D33 \u0D35\u0D38\u0D4D\u0D24\u0D41 \u0D1A\u0D46\u0D32\u0D35\u0D4D \u0D28\u0D7D\u0D15\u0D41\u0D15",
  "pricing.getSuggestion": "\u0D35\u0D3F\u0D32 \u0D28\u0D3F\u0D7C\u0D26\u0D4D\u0D26\u0D47\u0D36\u0D02 \u0D28\u0D47\u0D1F\u0D41\u0D15",
  "pricing.suggestError": "\u0D35\u0D3F\u0D32 \u0D28\u0D3F\u0D7C\u0D26\u0D4D\u0D26\u0D47\u0D36\u0D02 \u0D32\u0D2D\u0D4D\u0D2F\u0D2E\u0D3E\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32",
  "pricing.retry": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "pricing.rangeLabel": "\u0D28\u0D3F\u0D7C\u0D26\u0D4D\u0D26\u0D47\u0D36\u0D3F\u0D1A\u0D4D\u0D1A \u0D35\u0D3F\u0D32 \u0D2A\u0D30\u0D3F\u0D27\u0D3F",
  "pricing.sellingPriceLabel": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D35\u0D3F\u0D31\u0D4D\u0D31\u0D41\u0D35\u0D30\u0D35\u0D3F\u0D28\u0D4D\u0D31\u0D46 \u0D35\u0D3F\u0D32",
  "pricing.sellingPriceNote": "\u0D07\u0D24\u0D4D \u0D12\u0D30\u0D41 \u0D28\u0D3F\u0D7C\u0D26\u0D4D\u0D26\u0D47\u0D36\u0D02 \u0D2E\u0D3E\u0D24\u0D4D\u0D30\u0D2E\u0D3E\u0D23\u0D4D, \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D7E\u0D15\u0D4D\u0D15\u0D4D \u0D07\u0D37\u0D4D\u0D1F\u0D2E\u0D41\u0D33\u0D4D\u0D33 \u0D35\u0D3F\u0D32 \u0D0F\u0D24\u0D4D \u0D35\u0D47\u0D23\u0D2E\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D32\u0D41\u0D02 \u0D38\u0D1C\u0D4D\u0D1C\u0D2E\u0D3E\u0D15\u0D4D\u0D15\u0D3E\u0D02.",
  "pricing.sellingPriceInvalid": "\u0D2A\u0D42\u0D1C\u0D4D\u0D2F\u0D02\u0D15\u0D4D\u0D15\u0D3E\u0D7E \u0D15\u0D42\u0D1F\u0D41\u0D24\u0D32\u0D41\u0D33\u0D4D\u0D33 \u0D35\u0D3F\u0D31\u0D4D\u0D31\u0D41\u0D35\u0D30\u0D35\u0D3F\u0D28\u0D4D\u0D31\u0D46 \u0D35\u0D3F\u0D32 \u0D28\u0D7D\u0D15\u0D41\u0D15",
  "pricing.publish": "\u0D2A\u0D4D\u0D30\u0D38\u0D3F\u0D26\u0D4D\u0D27\u0D40\u0D15\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "pricing.publishError": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D2A\u0D4D\u0D30\u0D38\u0D3F\u0D26\u0D4D\u0D27\u0D40\u0D15\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32",
  "pricing.successTitle": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D07\u0D2A\u0D4D\u0D2A\u0D4B\u0D7E \u0D32\u0D48\u0D35\u0D3E\u0D23\u0D4D!",
  "pricing.successMessage": "\u0D35\u0D3E\u0D19\u0D4D\u0D19\u0D41\u0D28\u0D4D\u0D28\u0D35\u0D7C \u0D07\u0D2A\u0D4D\u0D2A\u0D4B\u0D7E \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D15\u0D1F\u0D2F\u0D3F\u0D7D \u0D07\u0D24\u0D4D \u0D15\u0D23\u0D4D\u0D1F\u0D46\u0D24\u0D4D\u0D24\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D2F\u0D41\u0D02.",
  "pricing.viewShop": "\u0D0E\u0D28\u0D4D\u0D31\u0D46 \u0D15\u0D1F\u0D2F\u0D3F\u0D7D \u0D15\u0D3E\u0D23\u0D41\u0D15",
  "home.title": "\u0D0E\u0D28\u0D4D\u0D31\u0D46 \u0D15\u0D1F",
  "home.gemBannerTitle": "GeM / ONDC-\u0D2F\u0D41\u0D2E\u0D3E\u0D2F\u0D3F \u0D2C\u0D28\u0D4D\u0D27\u0D3F\u0D2A\u0D4D\u0D2A\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.gemBannerBadge": "\u0D35\u0D47\u0D17\u0D02 \u0D35\u0D30\u0D41\u0D28\u0D4D\u0D28\u0D41",
  "home.gemBannerMessage": "\u0D08 \u0D38\u0D02\u0D2F\u0D4B\u0D1C\u0D28\u0D02 \u0D35\u0D47\u0D17\u0D02 \u0D35\u0D30\u0D41\u0D28\u0D4D\u0D28\u0D41.",
  "home.loading": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "home.loadError": "\u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32",
  "home.retry": "\u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.emptyTitle": "\u0D07\u0D24\u0D41\u0D35\u0D30\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D33\u0D3F\u0D32\u0D4D\u0D32",
  "home.emptyMessage": "KalaSetu-\u0D2F\u0D3F\u0D7D \u0D35\u0D3F\u0D7D\u0D2A\u0D4D\u0D2A\u0D28 \u0D06\u0D30\u0D02\u0D2D\u0D3F\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D06\u0D26\u0D4D\u0D2F \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D1A\u0D47\u0D7C\u0D15\u0D4D\u0D15\u0D41\u0D15.",
  "home.addFirstProduct": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D06\u0D26\u0D4D\u0D2F \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D1A\u0D47\u0D7C\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.statusPublished": "\u0D2A\u0D4D\u0D30\u0D38\u0D3F\u0D26\u0D4D\u0D27\u0D40\u0D15\u0D30\u0D3F\u0D1A\u0D4D\u0D1A\u0D41",
  "home.statusDraft": "\u0D21\u0D4D\u0D30\u0D3E\u0D2B\u0D4D\u0D31\u0D4D\u0D31\u0D4D",
  "home.statusFailed": "\u0D2A\u0D30\u0D3E\u0D1C\u0D2F\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D4D\u0D1F\u0D41",
  "home.detailCategory": "\u0D35\u0D3F\u0D2D\u0D3E\u0D17\u0D02",
  "home.detailEdit": "\u0D24\u0D3F\u0D30\u0D41\u0D24\u0D4D\u0D24\u0D41\u0D15",
  "home.detailDelete": "\u0D07\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D3E\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.detailClose": "\u0D05\u0D1F\u0D2F\u0D4D\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.editPriceLabel": "\u0D35\u0D3F\u0D32",
  "home.editDescriptionLabel": "\u0D35\u0D3F\u0D35\u0D30\u0D23\u0D02",
  "home.editSave": "\u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D19\u0D4D\u0D19\u0D7E \u0D38\u0D02\u0D30\u0D15\u0D4D\u0D37\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.editCancel": "\u0D31\u0D26\u0D4D\u0D26\u0D3E\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.editPriceInvalid": "0-\u0D28\u0D47\u0D15\u0D4D\u0D15\u0D3E\u0D7E \u0D15\u0D42\u0D1F\u0D41\u0D24\u0D32\u0D41\u0D33\u0D4D\u0D33 \u0D35\u0D3F\u0D32 \u0D28\u0D7D\u0D15\u0D41\u0D15",
  "home.editDescriptionRequired": "\u0D35\u0D3F\u0D35\u0D30\u0D23\u0D02 \u0D0F\u0D24\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D32\u0D41\u0D02 \u0D2D\u0D3E\u0D37\u0D2F\u0D3F\u0D7D \u0D36\u0D42\u0D28\u0D4D\u0D2F\u0D2E\u0D3E\u0D15\u0D3E\u0D7B \u0D2A\u0D3E\u0D1F\u0D3F\u0D32\u0D4D\u0D32",
  "home.editError": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D19\u0D4D\u0D19\u0D7E \u0D38\u0D02\u0D30\u0D15\u0D4D\u0D37\u0D3F\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32, \u0D26\u0D2F\u0D35\u0D3E\u0D2F\u0D3F \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.deleteConfirm": "\u0D08 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D07\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D3E\u0D15\u0D4D\u0D15\u0D23\u0D4B? \u0D07\u0D24\u0D4D \u0D24\u0D3F\u0D30\u0D3F\u0D15\u0D46 \u0D15\u0D4A\u0D23\u0D4D\u0D1F\u0D41\u0D35\u0D30\u0D3E\u0D7B \u0D38\u0D3E\u0D27\u0D3F\u0D15\u0D4D\u0D15\u0D3F\u0D32\u0D4D\u0D32.",
  "home.deleteConfirmYes": "\u0D05\u0D24\u0D46, \u0D07\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D3E\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "home.deleteError": "\u0D08 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D07\u0D32\u0D4D\u0D32\u0D3E\u0D24\u0D3E\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32, \u0D26\u0D2F\u0D35\u0D3E\u0D2F\u0D3F \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "profile.title": "\u0D2A\u0D4D\u0D30\u0D4A\u0D2B\u0D48\u0D7D",
  "profile.emailLabel": "\u0D07\u0D2E\u0D46\u0D2F\u0D3F\u0D7D \u0D35\u0D3F\u0D32\u0D3E\u0D38\u0D02",
  "profile.emailUnknown": "\u0D32\u0D2D\u0D4D\u0D2F\u0D2E\u0D32\u0D4D\u0D32",
  "profile.loading": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2A\u0D4D\u0D30\u0D4A\u0D2B\u0D48\u0D7D \u0D32\u0D4B\u0D21\u0D41\u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "profile.loadError": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2A\u0D4D\u0D30\u0D4A\u0D2B\u0D48\u0D7D \u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32",
  "profile.displayNameLabel": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2A\u0D47\u0D30\u0D4D",
  "profile.shopNameLabel": "\u0D15\u0D1F\u0D2F\u0D41\u0D1F\u0D46 \u0D2A\u0D47\u0D30\u0D4D",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u0D2A\u0D4D\u0D30\u0D4A\u0D2B\u0D48\u0D7D \u0D38\u0D02\u0D30\u0D15\u0D4D\u0D37\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "profile.saved": "\u0D2A\u0D4D\u0D30\u0D4A\u0D2B\u0D48\u0D7D \u0D38\u0D02\u0D30\u0D15\u0D4D\u0D37\u0D3F\u0D1A\u0D4D\u0D1A\u0D41",
  "profile.saveError": "\u0D2A\u0D4D\u0D30\u0D4A\u0D2B\u0D48\u0D7D \u0D38\u0D02\u0D30\u0D15\u0D4D\u0D37\u0D3F\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32, \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "profile.logout": "\u0D32\u0D4B\u0D17\u0D4D \u0D14\u0D1F\u0D4D\u0D1F\u0D4D",
  "install.message": "\u0D35\u0D47\u0D17\u0D24\u0D4D\u0D24\u0D3F\u0D7D \u0D09\u0D2A\u0D2F\u0D4B\u0D17\u0D3F\u0D15\u0D4D\u0D15\u0D3E\u0D7B KalaSetu \u0D07\u0D7B\u0D38\u0D4D\u0D31\u0D4D\u0D31\u0D3E\u0D7E \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D42",
  "install.action": "\u0D07\u0D7B\u0D38\u0D4D\u0D31\u0D4D\u0D31\u0D3E\u0D7E",
  "install.dismiss": "\u0D05\u0D35\u0D17\u0D23\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "offline.message": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D7E \u0D13\u0D2B\u0D4D\u200C\u0D32\u0D48\u0D7B \u0D06\u0D23\u0D4D, \u0D1A\u0D3F\u0D32 \u0D2B\u0D40\u0D1A\u0D4D\u0D1A\u0D31\u0D41\u0D15\u0D7E \u0D2A\u0D4D\u0D30\u0D35\u0D7C\u0D24\u0D4D\u0D24\u0D3F\u0D15\u0D4D\u0D15\u0D3F\u0D32\u0D4D\u0D32",
  "welcome.languageHint": "\u0D2E\u0D41\u0D34\u0D41\u0D35\u0D7B \u0D06\u0D2A\u0D4D\u0D2A\u0D4D \u0D08 \u0D2D\u0D3E\u0D37\u0D2F\u0D3F\u0D7D \u0D06\u0D2F\u0D3F\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D02.",
  "welcome.regionalLanguages": "\u0D07\u0D28\u0D4D\u0D24\u0D4D\u0D2F\u0D7B \u0D2D\u0D3E\u0D37\u0D15\u0D7E",
  "describe.localTab": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2D\u0D3E\u0D37",
  "describe.placeholderLocal": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D38\u0D4D\u0D35\u0D28\u0D4D\u0D24\u0D02 \u0D2D\u0D3E\u0D37\u0D2F\u0D3F\u0D7D \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D35\u0D3F\u0D35\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "describe.syncing": "\u0D2E\u0D31\u0D4D\u0D31\u0D4A\u0D30\u0D41 \u0D2D\u0D3E\u0D37 \u0D05\u0D2A\u0D4D\u200C\u0D21\u0D47\u0D31\u0D4D\u0D31\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "describe.syncFailed": "\u0D2E\u0D31\u0D4D\u0D31\u0D4A\u0D30\u0D41 \u0D2D\u0D3E\u0D37 \u0D05\u0D2A\u0D4D\u200C\u0D21\u0D47\u0D31\u0D4D\u0D31\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32. \u0D06\u0D35\u0D36\u0D4D\u0D2F\u0D2E\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D7D \u0D38\u0D4D\u0D35\u0D2F\u0D02 \u0D24\u0D3F\u0D30\u0D41\u0D24\u0D4D\u0D24\u0D41\u0D15.",
  "describe.syncHint": "\u0D24\u0D3F\u0D30\u0D41\u0D24\u0D4D\u0D24\u0D32\u0D41\u0D15\u0D7E \u0D38\u0D4D\u0D35\u0D2F\u0D02 \u0D2E\u0D31\u0D4D\u0D31\u0D4A\u0D30\u0D41 \u0D2D\u0D3E\u0D37\u0D2F\u0D3F\u0D32\u0D47\u0D15\u0D4D\u0D15\u0D4D \u0D2A\u0D15\u0D7C\u0D24\u0D4D\u0D24\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D41\u0D02.",
  "pricing.updating": "\u0D2A\u0D41\u0D24\u0D3F\u0D2F \u0D35\u0D38\u0D4D\u0D24\u0D41 \u0D1A\u0D46\u0D32\u0D35\u0D3F\u0D28\u0D3E\u0D2F\u0D3F \u0D05\u0D2A\u0D4D\u200C\u0D21\u0D47\u0D31\u0D4D\u0D31\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0D15\u0D3E\u0D31\u0D4D\u0D31\u0D32\u0D4B\u0D17\u0D4D \u0D0E\u0D15\u0D4D\u0D38\u0D4D\u0D2A\u0D4B\u0D7C\u0D1F\u0D4D\u0D1F\u0D4D (ONDC \u0D2B\u0D4B\u0D7C\u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D4D)",
  "home.exportCatalogNote": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D2A\u0D4D\u0D30\u0D38\u0D3F\u0D26\u0D4D\u0D27\u0D40\u0D15\u0D30\u0D3F\u0D1A\u0D4D\u0D1A \u0D32\u0D3F\u0D38\u0D4D\u0D31\u0D4D\u0D31\u0D3F\u0D02\u0D17\u0D41\u0D15\u0D7E ONDC \u0D31\u0D40\u0D1F\u0D4D\u0D1F\u0D46\u0D2F\u0D3F\u0D7D \u0D15\u0D3E\u0D31\u0D4D\u0D31\u0D32\u0D4B\u0D17\u0D4D \u0D18\u0D1F\u0D28\u0D2F\u0D3F\u0D32\u0D47\u0D15\u0D4D\u0D15\u0D4D \u0D2E\u0D3E\u0D2A\u0D4D\u0D2A\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D24\u0D4D \u0D21\u0D57\u0D7A\u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41. \u0D07\u0D28\u0D4D\u0D31\u0D17\u0D4D\u0D30\u0D47\u0D37\u0D7B-\u0D31\u0D46\u0D21\u0D3F: \u0D2E\u0D3E\u0D2A\u0D4D\u0D2A\u0D3F\u0D02\u0D17\u0D4D \u0D2A\u0D42\u0D7C\u0D24\u0D4D\u0D24\u0D3F\u0D2F\u0D3E\u0D2F\u0D3F, \u0D28\u0D46\u0D31\u0D4D\u0D31\u0D4D\u0D35\u0D7C\u0D15\u0D4D\u0D15\u0D3F\u0D7D \u0D32\u0D48\u0D35\u0D4D \u0D06\u0D15\u0D3E\u0D7B ONDC \u0D30\u0D1C\u0D3F\u0D38\u0D4D\u0D1F\u0D4D\u0D30\u0D47\u0D37\u0D7B \u0D06\u0D35\u0D36\u0D4D\u0D2F\u0D2E\u0D3E\u0D23\u0D4D.",
  "home.exportOndcSingle": "\u0D08 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D0E\u0D15\u0D4D\u0D38\u0D4D\u0D2A\u0D4B\u0D7C\u0D1F\u0D4D\u0D1F\u0D4D (ONDC \u0D2B\u0D4B\u0D7C\u0D2E\u0D3E\u0D31\u0D4D\u0D31\u0D4D)",
  "profile.relocalising": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D08 \u0D2D\u0D3E\u0D37\u0D2F\u0D3F\u0D32\u0D47\u0D15\u0D4D\u0D15\u0D4D \u0D05\u0D2A\u0D4D\u0D21\u0D47\u0D31\u0D4D\u0D31\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "profile.relocalised": "\u0D08 \u0D2D\u0D3E\u0D37\u0D2F\u0D3F\u0D32\u0D47\u0D15\u0D4D\u0D15\u0D4D {n} \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D05\u0D2A\u0D4D\u0D21\u0D47\u0D31\u0D4D\u0D31\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D24\u0D41.",
  "profile.relocaliseFailed": "\u0D1A\u0D3F\u0D32 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D05\u0D2A\u0D4D\u0D21\u0D47\u0D31\u0D4D\u0D31\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32. \u0D2A\u0D3F\u0D28\u0D4D\u0D28\u0D40\u0D1F\u0D4D \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15.",
  "marketplace.navBrowse": "\u0D2C\u0D4D\u0D30\u0D57\u0D38\u0D4D",
  "marketplace.navProfile": "\u0D2A\u0D4D\u0D30\u0D4A\u0D2B\u0D48\u0D7D",
  "marketplace.browseTitle": "\u0D2E\u0D3E\u0D7C\u0D15\u0D4D\u0D15\u0D31\u0D4D\u0D31\u0D4D\u200C\u0D2A\u0D4D\u0D32\u0D47\u0D38\u0D4D",
  "marketplace.searchPlaceholder": "\u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D24\u0D3F\u0D30\u0D2F\u0D41\u0D15...",
  "marketplace.filtersTitle": "\u0D2B\u0D3F\u0D7D\u0D1F\u0D4D\u0D1F\u0D31\u0D41\u0D15\u0D7E",
  "marketplace.filtersClear": "\u0D0E\u0D32\u0D4D\u0D32\u0D3E\u0D02 \u0D2E\u0D3E\u0D2F\u0D4D\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "marketplace.filterAll": "\u0D0E\u0D32\u0D4D\u0D32\u0D3E\u0D02",
  "marketplace.filterMaterial": "\u0D35\u0D38\u0D4D\u0D24\u0D41",
  "marketplace.filterRegion": "\u0D2A\u0D4D\u0D30\u0D26\u0D47\u0D36\u0D02",
  "marketplace.filterPrice": "\u0D35\u0D3F\u0D32 \u0D2A\u0D30\u0D3F\u0D27\u0D3F (\u20B9)",
  "marketplace.filterPriceMin": "\u0D15\u0D41\u0D31\u0D1E\u0D4D\u0D1E\u0D24\u0D4D",
  "marketplace.filterPriceMax": "\u0D2A\u0D30\u0D2E\u0D3E\u0D35\u0D27\u0D3F",
  "marketplace.sortLabel": "\u0D15\u0D4D\u0D30\u0D2E\u0D02",
  "marketplace.sortNewest": "\u0D2A\u0D41\u0D24\u0D3F\u0D2F\u0D24\u0D4D \u0D06\u0D26\u0D4D\u0D2F\u0D02",
  "marketplace.sortPriceAsc": "\u0D35\u0D3F\u0D32: \u0D15\u0D41\u0D31\u0D1E\u0D4D\u0D1E\u0D24\u0D4D \u0D2E\u0D41\u0D24\u0D7D \u0D09\u0D2F\u0D7C\u0D28\u0D4D\u0D28\u0D24\u0D4D \u0D35\u0D30\u0D46",
  "marketplace.sortPriceDesc": "\u0D35\u0D3F\u0D32: \u0D09\u0D2F\u0D7C\u0D28\u0D4D\u0D28\u0D24\u0D4D \u0D2E\u0D41\u0D24\u0D7D \u0D15\u0D41\u0D31\u0D1E\u0D4D\u0D1E\u0D24\u0D4D \u0D35\u0D30\u0D46",
  "marketplace.resultCount": "{n} \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D15\u0D23\u0D4D\u0D1F\u0D46\u0D24\u0D4D\u0D24\u0D3F",
  "marketplace.loadMore": "\u0D15\u0D42\u0D1F\u0D41\u0D24\u0D7D \u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15",
  "marketplace.loadError": "\u0D2E\u0D3E\u0D7C\u0D15\u0D4D\u0D15\u0D31\u0D4D\u0D31\u0D4D\u200C\u0D2A\u0D4D\u0D32\u0D47\u0D38\u0D4D \u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32, \u0D26\u0D2F\u0D35\u0D3E\u0D2F\u0D3F \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "marketplace.emptyTitle": "\u0D08 \u0D2B\u0D3F\u0D7D\u0D1F\u0D4D\u0D1F\u0D31\u0D41\u0D15\u0D7E\u0D15\u0D4D\u0D15\u0D4D \u0D2F\u0D4B\u0D1C\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D28\u0D4D\u0D28 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D33\u0D3F\u0D32\u0D4D\u0D32",
  "marketplace.emptyFiltered": "\u0D12\u0D30\u0D41 \u0D2B\u0D3F\u0D7D\u0D1F\u0D4D\u0D1F\u0D7C \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15\u0D2F\u0D4B \u0D2E\u0D31\u0D4D\u0D31\u0D4A\u0D28\u0D4D\u0D28\u0D3F\u0D28\u0D3E\u0D2F\u0D3F \u0D24\u0D3F\u0D30\u0D2F\u0D41\u0D15\u0D2F\u0D4B \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D15.",
  "marketplace.emptyNoProducts": "\u0D07\u0D24\u0D41\u0D35\u0D30\u0D46 \u0D0F\u0D24\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D32\u0D41\u0D02 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D2A\u0D4D\u0D30\u0D38\u0D3F\u0D26\u0D4D\u0D27\u0D40\u0D15\u0D30\u0D3F\u0D1A\u0D4D\u0D1A\u0D3F\u0D1F\u0D4D\u0D1F\u0D3F\u0D32\u0D4D\u0D32. \u0D09\u0D1F\u0D7B \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D2A\u0D30\u0D3F\u0D36\u0D4B\u0D27\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15.",
  "marketplace.artisanUnnamed": "KalaSetu \u0D15\u0D48\u0D24\u0D4D\u0D24\u0D4A\u0D34\u0D3F\u0D32\u0D3E\u0D33\u0D3F",
  "marketplace.backToBrowse": "\u0D2E\u0D3E\u0D7C\u0D15\u0D4D\u0D15\u0D31\u0D4D\u0D31\u0D4D\u0D2A\u0D4D\u0D32\u0D47\u0D38\u0D3F\u0D32\u0D47\u0D15\u0D4D\u0D15\u0D4D \u0D2E\u0D1F\u0D19\u0D4D\u0D19\u0D41\u0D15",
  "marketplace.detailNotFoundTitle": "\u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D15\u0D23\u0D4D\u0D1F\u0D46\u0D24\u0D4D\u0D24\u0D3E\u0D28\u0D3E\u0D2F\u0D3F\u0D32\u0D4D\u0D32",
  "marketplace.detailNotFoundMessage": "\u0D08 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D28\u0D40\u0D15\u0D4D\u0D15\u0D02 \u0D1A\u0D46\u0D2F\u0D4D\u0D24\u0D3F\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D3E\u0D02 \u0D05\u0D32\u0D4D\u0D32\u0D46\u0D19\u0D4D\u0D15\u0D3F\u0D7D \u0D07\u0D28\u0D3F \u0D32\u0D2D\u0D4D\u0D2F\u0D2E\u0D32\u0D4D\u0D32.",
  "marketplace.artisanSummaryTitle": "\u0D15\u0D3E\u0D7C\u0D17\u0D3F\u0D15\u0D28\u0D46\u0D15\u0D4D\u0D15\u0D41\u0D31\u0D3F\u0D1A\u0D4D\u0D1A\u0D4D",
  "marketplace.artisanProductCount": "KalaSetu-\u0D2F\u0D3F\u0D7D {n} \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E",
  "marketplace.inquiryTitle": "\u0D08 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D24\u0D4D\u0D24\u0D3F\u0D7D \u0D24\u0D3E\u0D7D\u0D2A\u0D4D\u0D2A\u0D30\u0D4D\u0D2F\u0D2E\u0D41\u0D23\u0D4D\u0D1F\u0D4B?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0D15\u0D3E\u0D7C\u0D17\u0D3F\u0D15\u0D28\u0D4D \u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D7E\u0D15\u0D4D\u0D15\u0D4D \u0D35\u0D47\u0D23\u0D4D\u0D1F\u0D24\u0D4D \u0D2A\u0D31\u0D2F\u0D42: \u0D05\u0D33\u0D35\u0D4D, \u0D07\u0D37\u0D4D\u0D1F\u0D3E\u0D28\u0D41\u0D38\u0D30\u0D23\u0D02, \u0D21\u0D46\u0D32\u0D3F\u0D35\u0D31\u0D3F \u0D38\u0D2E\u0D2F\u0D02...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0D05\u0D2D\u0D4D\u0D2F\u0D7C\u0D24\u0D4D\u0D25\u0D28 \u0D05\u0D2F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "marketplace.inquirySent": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D05\u0D2D\u0D4D\u0D2F\u0D7C\u0D24\u0D4D\u0D25\u0D28 \u0D05\u0D2F\u0D1A\u0D4D\u0D1A\u0D41. \u0D15\u0D3E\u0D7C\u0D17\u0D3F\u0D15\u0D7B \u0D09\u0D1F\u0D7B \u0D2C\u0D28\u0D4D\u0D27\u0D2A\u0D4D\u0D2A\u0D46\u0D1F\u0D41\u0D02.",
  "marketplace.inquiryError": "\u0D05\u0D2D\u0D4D\u0D2F\u0D7C\u0D24\u0D4D\u0D25\u0D28 \u0D05\u0D2F\u0D2F\u0D4D\u0D15\u0D4D\u0D15\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32, \u0D35\u0D40\u0D23\u0D4D\u0D1F\u0D41\u0D02 \u0D36\u0D4D\u0D30\u0D2E\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D15",
  "marketplace.regionLabel": "\u0D2A\u0D4D\u0D30\u0D26\u0D47\u0D36\u0D02",
  "marketplace.regionUnspecified": "\u0D28\u0D3F\u0D7C\u0D26\u0D4D\u0D26\u0D47\u0D36\u0D3F\u0D1A\u0D4D\u0D1A\u0D3F\u0D1F\u0D4D\u0D1F\u0D3F\u0D32\u0D4D\u0D32",
  "marketplace.myInquiriesTitle": "\u0D0E\u0D28\u0D4D\u0D31\u0D46 \u0D05\u0D28\u0D4D\u0D35\u0D47\u0D37\u0D23\u0D19\u0D4D\u0D19\u0D7E",
  "marketplace.inquiriesLoading": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D05\u0D28\u0D4D\u0D35\u0D47\u0D37\u0D23\u0D19\u0D4D\u0D19\u0D7E \u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D41\u0D28\u0D4D\u0D28\u0D41...",
  "marketplace.inquiriesLoadError": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D33\u0D41\u0D1F\u0D46 \u0D05\u0D28\u0D4D\u0D35\u0D47\u0D37\u0D23\u0D19\u0D4D\u0D19\u0D7E \u0D32\u0D4B\u0D21\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D3E\u0D7B \u0D15\u0D34\u0D3F\u0D1E\u0D4D\u0D1E\u0D3F\u0D32\u0D4D\u0D32",
  "marketplace.noInquiries": "\u0D28\u0D3F\u0D19\u0D4D\u0D19\u0D7E \u0D07\u0D24\u0D41\u0D35\u0D30\u0D46 \u0D1A\u0D4B\u0D26\u0D28\u0D15\u0D7E \u0D05\u0D2F\u0D1A\u0D4D\u0D1A\u0D3F\u0D1F\u0D4D\u0D1F\u0D3F\u0D32\u0D4D\u0D32. \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D19\u0D4D\u0D19\u0D7E \u0D15\u0D23\u0D4D\u0D1F\u0D46\u0D24\u0D4D\u0D24\u0D3E\u0D7B \u0D2E\u0D3E\u0D7C\u0D15\u0D4D\u0D15\u0D31\u0D4D\u0D31\u0D4D\u200C\u0D2A\u0D4D\u0D32\u0D47\u0D38\u0D4D \u0D2C\u0D4D\u0D30\u0D57\u0D38\u0D4D \u0D1A\u0D46\u0D2F\u0D4D\u0D2F\u0D42.",
  "marketplace.inquiryProductRemoved": "\u0D08 \u0D09\u0D7D\u0D2A\u0D4D\u0D2A\u0D28\u0D4D\u0D28\u0D02 \u0D07\u0D28\u0D3F \u0D32\u0D2D\u0D4D\u0D2F\u0D2E\u0D32\u0D4D\u0D32",
  "marketplace.inquiryStatusOpen": "\u0D2E\u0D31\u0D41\u0D2A\u0D1F\u0D3F \u0D15\u0D3E\u0D24\u0D4D\u0D24\u0D3F\u0D30\u0D3F\u0D15\u0D4D\u0D15\u0D41\u0D28\u0D4D\u0D28\u0D41",
  "marketplace.inquiryStatusClosed": "\u0D05\u0D1F\u0D1E\u0D4D\u0D1E\u0D41",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/mni.json
var mni_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\uABC8\uABE8\uABDD\uABC5\uABE3\uABDF\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "welcome.languageLabel": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "welcome.getStarted": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "language.en": "English",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "email.roleQuestion": "\uABC3\uABE4 \uABCA\uABD5\uABE4 \uABCD\uABDF\uABD5",
  "email.roleSell": "\uABC3\uABE4 \uABCA\uABD5\uABE4 \uABCA\uABE4\uABE1\uABD5\uABE4",
  "email.roleBuy": "\uABCA\uABE7\uABD4\uABE4\uABE1 \uABCA\uABE4\uABE1\uABD5\uABE4 \uABCA\uABD5\uABE4",
  "email.label": "\uABD1\uABC3\uABC1\uABE8\uABE1",
  "email.helper": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "email.invalid": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "email.sendOtp": "\uABD1\uABC3\uABC1\uABE8\uABE1",
  "email.error": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "otp.title": "\uABC8\uABE8\uABD4\uABE3\uABDF \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.subtitle": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE8\uABDD\uABC5\uABE4\uABD5 4 \uABC4\uABE8\uABDD\uABC5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.emailUndelivered": "\uABC8\uABE8\uABD4\uABE3\uABDF \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1\uABEB \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.changeEmail": "\uABC8\uABE8\uABD4\uABE3\uABDF \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.verify": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.invalid": "4 \uABC4\uABE8\uABDD\uABC5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.wrong": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1, \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.resend": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "otp.resendIn": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 {n}s",
  "otp.resendError": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1, \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "camera.capture": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "camera.unavailable": "\uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1, \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1 \uABC4\uABE5\uABE1\uABD5\uABE4\uABE1",
  "camera.choosePhoto": "\u099B\u09AC\u09BF \u09AC\u09BE\u099B\u09AC\u09BE",
  "camera.retake": "\u09AA\u09C1\u09A8: \u099B\u09AC\u09BF \u09A4\u09CD\u09B0\u09BE",
  "camera.usePhoto": "\u098F\u0987 \u099B\u09AC\u09BF \u09AC\u09CD\u09AF\u09AC\u09B9\u09BE\u09B0\u09AC\u09BE",
  "camera.enhancing": "\u0986\u09AA\u09A8\u09BE\u09B0 \u099B\u09AC\u09BF \u0989\u09A8\u09CD\u09A8\u09A4 \u0995\u09B0\u09BF\u09AC\u09BE...",
  "camera.enhanceError": "\u0986\u09AA\u09A8\u09BE\u09B0 \u099B\u09AC\u09BF \u0989\u09A8\u09CD\u09A8\u09A4 \u09A8\u09A4\u09CD\u09A4\u09C7",
  "camera.retry": "\u09AA\u09C1\u09A8: \u099A\u09C7\u09B7\u09CD\u099F\u09BE",
  "camera.before": "\u09AE\u09C2\u09B2",
  "camera.after": "\u0989\u09A8\u09CD\u09A8\u09A4",
  "camera.compareHint": "\u09A4\u09C1\u09B2\u09A8\u09BE \u0995\u09B0\u09AC\u09BE\u0996\u09A4 \u09B8\u09CD\u09B2\u09BE\u0987\u09A1 \u099F\u09BE\u09A8\u09BE",
  "camera.continue": "\u099A\u09B2\u09C1\u09AC\u09BE",
  "studio.title": "Enhance your photo",
  "studio.original": "Original",
  "studio.processed": "Processed",
  "studio.removeBackground": "Remove background",
  "studio.removingBackground": "Removing background...",
  "studio.keepOriginalBackground": "Keep original background",
  "studio.backgroundWhite": "White",
  "studio.backgroundNeutral": "Soft cream",
  "studio.backgroundBlur": "Blur",
  "studio.backgroundUnavailableNotice": "Background removal is not available right now. Your photo is unchanged.",
  "studio.backgroundTimedOutNotice": "Background removal took too long and was skipped. Your photo is unchanged.",
  "studio.backgroundQuotaNotice": "Background removal quota reached for now. Your photo is unchanged.",
  "studio.backgroundFailedNotice": "\uABC4\uABC7\uABDA\uABE8\uABC3\uABE4 \uABC3\uABE8\uABC1\uABE4\uABD5\uABE5 \uABCD\uABE7\uABD7\uABD4\uABD5\uABE5\u0964 \uABC5\uABE7\uABD2\uABE4 \uABD0\uABC7\uABE3 \uABCD\uABE7\uABD7\uABD4\uABD5\uABE5 \uABC5\uABE7\uABD7\uABD4\uABE5\u0964",
  "studio.brightness": "\uABD1\uABC2\uABE7",
  "studio.contrast": "\uABD5\uABE4\uABD4\uABE3\uABCF",
  "studio.sharpen": "\uABC7\uABE4\uABDB\uABC1\uABC5",
  "studio.autoLighting": "\uABD1\uABC7\uABE3 \uABD1\uABC2\uABE7",
  "studio.crop": "\uABC0\uABE5\uABC7",
  "studio.cropOriginal": "\uABC3\uABE8\uABDC",
  "studio.cropSquare": "\uABD5\uABD4\uABD2",
  "studio.cropPortrait": "\uABCE\uABC2\uABDD\uABD5",
  "studio.accept": "\uABCF\uABCD\uABE5 \uABD0\uABC7\uABE3 \uABCD\uABE7\uABD5\uABE4",
  "studio.retake": "\uABC4\uABE8\uABC5\uABD4\uABE5\uABCF \uABC7\uABE7",
  "studio.finalizing": "\uABC5\uABE7\uABD2\uABE4 \uABCF\uABD7\uABE4\uABC7\uABC1 \uA34D\uABD4\uABE4\uABD5\uABD2\uABE4...",
  "studio.on": "\uABD1\uABE3\uABDF",
  "studio.off": "\uABD1\uABD0",
  "category.title": "\u0986\u09AA\u09A8\u09BF \u0995\u09BF \u09AC\u09BF\u0995\u09CD\u09B0\u09BF \u0995\u09B0\u09AC\u09BE?",
  "category.continue": "\u099A\u09B2\u09C1\u09AC\u09BE",
  "category.materialQuestion": "\uABC3\uABC1\uABE4 \uABCA\uABE7\uABD5\uABE4 \uABCD\uABDF\uABD5\uABE4? (\uABD1\uABE3\uABDE\uABC1\uABE4\uABDF)",
  "category.textiles": "\uABC8\uABE8\uABDD\uABC5\uABE3\uABDF",
  "category.pottery": "\uABD1\uABC7\uABE6\uABDC",
  "category.jewelry": "\uABC3\uABC7\uABDD",
  "category.woodwork": "\uABCA\uABE5\uABD2\uABE4\uABC1\uABE4\uABCC\uABE6",
  "category.bambooCane": "\uABCA\uABE5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABC3\uABC1\uABE8",
  "category.other": "\uABD1\uABC3\uABC1\uABE8",
  "voice.tapToRecord": "\uABCA\uABE5\uABD2\uABE4\uABC1\uABE4\uABCC\uABE6 \uABC4\uABE5\uABCE\uABD5 \uABC2\uABE9\uABC4 \uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8",
  "voice.recording": "\uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8...",
  "voice.stop": "\uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4",
  "voice.record": "\uABC2\uABE9\uABC4",
  "voice.reviewRecording": "\uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4, \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8",
  "voice.reRecord": "\uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8",
  "voice.continue": "\uABC8\uABE8\uABD4\uABE3\uABDF",
  "describe.transcribing": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABE1\uABD5...",
  "describe.transcribeError": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB \uABC8\uABE8\uABDD\uABC5\uABE4",
  "describe.retry": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB",
  "describe.reviewHint": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB \uABC8\uABE8\uABDD\uABC5\uABE4",
  "describe.fallbackNote": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB \uABC8\uABE8\uABDD\uABC5\uABE4",
  "describe.placeholderEn": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB",
  "describe.continue": "\uABC8\uABE8\uABD4\uABE3\uABDF",
  "pricing.title": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB",
  "pricing.summaryEdit": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB",
  "pricing.materialCostLabel": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB",
  "pricing.materialCostHelper": "\uABD1\uABC3\uABE9\uABC7\uABE4\uABE1\uABD2\uABE4 \uABC2\uABE9\uABD6\uABE4\uABEB",
  "pricing.materialCostInvalid": "\uABC3\uABC7\uABDD \uABC6\uABE8\uABDD \uABC0\uABD4\uABE4 \uABC2\uABE9 \uABC2\uABE3\uABDF \uABC4\uABE5\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4 \uABC2\uABE9",
  "pricing.getSuggestion": "\uABC6\uABE8\uABDD \uABC4\uABE5\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABC4\uABE5\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4",
  "pricing.suggestError": "\uABC6\uABE8\uABDD \uABC4\uABE5\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABE3\uABDF\uABD5 \uABD1\uABE3\uABDF\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABE3\uABDF\uABD5",
  "pricing.retry": "\uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4",
  "pricing.rangeLabel": "\uABC6\uABE8\uABDD \uABC4\uABE5\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4",
  "pricing.sellingPriceLabel": "\uABC5\uABE4\uABE1\uABD5 \uABC6\uABE8\uABDD",
  "pricing.sellingPriceNote": "\uABC5\uABE4\uABE1\uABD5 \uABC6\uABE8\uABDD \uABD1\uABC3\uABC1\uABE8 \uABC4\uABE5\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABE3\uABDF\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABE3\uABDF\uABD5",
  "pricing.sellingPriceInvalid": "\uABC5\uABE4\uABE1\uABD5 \uABC6\uABE8\uABDD \uABC0\uABD4\uABE4 \uABC2\uABE9 \uABC2\uABE3\uABDF \uABC4\uABE5\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABC2\uABE9\uABC4",
  "pricing.publish": "\uABC5\uABE4\uABE1\uABD5",
  "pricing.publishError": "\uABC5\uABE4\uABE1\uABD5 \uABC6\uABE8\uABDD \uABD1\uABC3\uABC1\uABE8 \uABC5\uABE4\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABE3\uABDF\uABD5",
  "pricing.successTitle": "\uABC5\uABE4\uABE1\uABD5 \uABC6\uABE8\uABDD \uABD1\uABC3\uABC1\uABE8 \uABC5\uABE4\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABE3\uABDF\uABD5",
  "pricing.successMessage": "\uABC5\uABE4\uABE1\uABD5 \uABC6\uABE8\uABDD \uABD1\uABC3\uABC1\uABE8 \uABC5\uABE4\uABE1\uABD5 \uABD1\uABC3\uABC1\uABE8 \uABD1\uABE3\uABDF\uABD5",
  "pricing.viewShop": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD\uABD2\uABE4 \uABC2\uABE9\uABD6\uABC5\uABD5",
  "home.title": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD",
  "home.gemBannerTitle": "GeM / ONDC \uABD2\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABC2\uABE9\uABD6\uABC5\uABD5",
  "home.gemBannerBadge": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABC2\uABE9\uABD6\uABC5\uABD5",
  "home.gemBannerMessage": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABC2\uABE9\uABD6\uABC5\uABD5\uABD2\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABC2\uABE9\uABD6\uABC5\uABD5\uABC5\uABE4\uABEB",
  "home.loading": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABC2\uABE9\uABD6\uABC5\uABD5...",
  "home.loadError": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABC2\uABE9\uABD6\uABC5\uABD5 \uABD1\uABE3\uABCF\uABD5",
  "home.retry": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABC2\uABE9\uABD6\uABC5\uABD5",
  "home.emptyTitle": "\uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABD1\uABE3\uABCF\uABD5",
  "home.emptyMessage": "KalaSetu \uABD2\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABC2\uABE9\uABD6\uABC5\uABD5 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABC2\uABE9\uABD6\uABC5\uABD5\uABC5\uABE4\uABEB",
  "home.addFirstProduct": "\uABD1\uABC3\uABE9\uABC0\uABE4 \uABD1\uABC3\uABE9\uABC4\uABE8\uABDD \uABC2\uABE9\uABD6\uABC5\uABD5",
  "home.statusPublished": "\uABC2\uABE9\uABD6\uABC5\uABD5",
  "home.statusDraft": "\uABC8\uABE8\uABDD\uABD5",
  "home.statusFailed": "\uABD1\uABE3\uABCF\uABD5",
  "home.detailCategory": "\uABC2\uABE9\uABC4\uABE5\uABCE\uABD5",
  "home.detailEdit": "\uABC4\uABE5\uABCE\uABD5",
  "home.detailDelete": "\uABC2\uABE5\uABE1\uABD5",
  "home.detailClose": "\uABC2\uABE3\uABDF\uABD5",
  "home.editPriceLabel": "\uABC2\uABE9\uABC4\uABE5\uABCE\uABD5",
  "home.editDescriptionLabel": "\uABC3\uABC7\uABDD\uABD7\uABE3\uABC0\uABE4\uABCC\uABE5",
  "home.editSave": "\uABC2\uABE5\uABE1\uABD5",
  "home.editCancel": "\uABC2\uABE3\uABDF\uABD5",
  "home.editPriceInvalid": "\uABC0\uABD4\uABE4\uABE0\uABC5\uABD5 \uABC2\uABE9\uABC4\uABE5\uABCE\uABD5 \uABC2\uABE3\uABDF\uABD5",
  "home.editDescriptionRequired": "\uABC3\uABC7\uABDD\uABD7\uABE3\uABC0\uABE4\uABCC\uABE5 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABC8\uABE8\uABDD\uABD5",
  "home.editError": "\uABC8\uABE8\uABD4\uABE3\uABDF\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4 \uABD1\uABE3\uABDF\uABD5\uABE4 \uABD1\uABE3\uABDF\uABD5\uABE4, \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4",
  "home.deleteConfirm": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4? \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4 \uABD1\uABE3\uABDF\uABD5\uABE4",
  "home.deleteConfirmYes": "\uABD1\uABC3\uABC1\uABE8\uABE1, \uABD1\uABE3\uABDF\uABD5\uABE4",
  "home.deleteError": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4 \uABD1\uABE3\uABDF\uABD5\uABE4, \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4",
  "profile.title": "\uABC3\uABC5\uABE4\uABC4\uABE8\uABD4",
  "profile.emailLabel": "\uABC3\uABC5\uABE4\uABC4\uABE8\uABD4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "profile.emailUnknown": "\uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4",
  "profile.loading": "\uABC3\uABC5\uABE4\uABC4\uABE8\uABD4 \uABD1\uABC3\uABC1\uABE8\uABE1...",
  "profile.loadError": "\uABC3\uABC5\uABE4\uABC4\uABE8\uABD4 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABE3\uABDF\uABD5\uABE4",
  "profile.displayNameLabel": "\uABC3\uABC5\uABE4\uABC4\uABE8\uABD4",
  "profile.shopNameLabel": "\uABC3\uABC5\uABE4\uABC4\uABE8\uABD4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\uABC3\uABC5\uABE4\uABC4\uABE8\uABD4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "profile.saved": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "profile.saveError": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "profile.logout": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "install.message": "KalaSetu \uABC2\uABE9\uABD6\uABE4\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "install.action": "\uABC2\uABE9\uABD6\uABE4\uABE1",
  "install.dismiss": "\uABD1\uABC3\uABC1\uABE8\uABE1",
  "offline.message": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "welcome.languageHint": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "welcome.regionalLanguages": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "describe.localTab": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "describe.placeholderLocal": "\uABC8\uABE8\uABDD\uABC1\uABE4\uABE1 \uABC2\uABE3\uABDF\uABD5\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1",
  "describe.syncing": "\uABC8\uABE8\uABDD\uABC5\uABE8\uABE1 \uABC2\uABE9\uABC4\uABE5\uABE1\uABD5...",
  "describe.syncFailed": "\uABC8\uABE8\uABDD\uABC5\uABE8\uABE1 \uABC2\uABE9\uABC4\uABE5\uABE1\uABD2\uABE4\uABEB \uABD1\uABC3\uABC1\uABE8\uABE1 \uABC8\uABE8\uABDD\uABC5\uABE8\uABE1 \uABC2\uABE9\uABC4\uABE5\uABE1\uABD2\uABE4\uABEB",
  "describe.syncHint": "\uABC8\uABE8\uABDD\uABC5\uABE8\uABE1 \uABC2\uABE9\uABC4\uABE5\uABE1\uABD2\uABE4\uABEB",
  "pricing.updating": "\uABC5\uABE4\uABDF\uABD7\uABE4 \uABC2\uABE4\uABD7\uABE4 \uABC2\uABE4\uABD7\uABE4 \uABD1 \uABD1\uABE4 \uABD1\uABE4\uABD5\uABE4 \uABD1\uABE4\uABD5\uABE4",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\uABC3\uABC5\uABE8\uABE1\uABD2\uABE4 \uABD1\uABC3\uABC1\uABE8\uABE1\uABC5 \uABC4\uABE5\uABCE\uABC5\uABD5...",
  "profile.relocalised": "{n} \uABD1\uABC3\uABC1\uABE8\uABE1\uABC5 \uABC4\uABE5\uABCE\uABC5\uABD5\uABC5\uABE4\uABEB",
  "profile.relocaliseFailed": "\uABD1\uABC3\uABC1\uABE8\uABE1\uABC5 \uABC4\uABE5\uABCE\uABD5\uABD2\uABE4 \uABD1\uABE3\uABCF\uABC5\uABD5\uABE4\uABEB \uABC0\uABEA\uABC2\uABE9 \uABD1\uABC3\uABC1\uABE8\uABE1\uABC5 \uABC4\uABE5\uABCE\uABC5\uABD5\uABEB",
  "marketplace.navBrowse": "\uABCA\uABE6\uABDD\uABD5",
  "marketplace.navProfile": "\uABC4\uABED\uABD4\uABE3\uABD0\uABE5\uABCF\uABDC",
  "marketplace.browseTitle": "\uABC3\uABD4\uABC6\uABE4 \uABCA\uABE6\uABDF",
  "marketplace.searchPlaceholder": "\uABC1\uABE6\uABD4\uABC6 \uABCA\uABE6\uABDF\uABD5...",
  "marketplace.filtersTitle": "\uABCA\uABE6\uABDF\uABD5\uABE4",
  "marketplace.filtersClear": "\uABCA\uABE7\uABD5\uABE4 \uABCA\uABE6\uABDF\uABD5",
  "marketplace.filterAll": "\uABCA\uABE6\uABDF\uABD5",
  "marketplace.filterMaterial": "\uABCA\uABE7\uABD5",
  "marketplace.filterRegion": "\uABCA\uABE7\uABD5 \uABCA\uABE6\uABDF",
  "marketplace.filterPrice": "\uABCA\uABE7\uABD5\uABE4 \uABCA\uABE6\uABDF (\u20B9)",
  "marketplace.filterPriceMin": "\uABC3\uABE4\uABC5",
  "marketplace.filterPriceMax": "\uABC3\uABE6\uABDB\uABC1",
  "marketplace.sortLabel": "\uABC1\uABE3\uABD4\uABE0 \uABC7\uABE7",
  "marketplace.sortNewest": "\uABC5\uABE8\uABCA\uABE4 \uABCA\uABD5\uABE4",
  "marketplace.sortPriceAsc": "\uABC2\uABE5\uABCF: \uABCA\uABD5\uABE4 \uABCA\uABD4\uABE4",
  "marketplace.sortPriceDesc": "\uABC2\uABE5\uABCF: \uABCA\uABD4\uABE4 \uABCA\uABD5\uABE4",
  "marketplace.resultCount": "{n} \uABCA\uABD5\uABE4 \uABC1\uABE4\uABDF\uABD5",
  "marketplace.loadMore": "\uABCA\uABD5\uABE4 \uABCD\uABE7",
  "marketplace.loadError": "\uABCA\uABD5\uABE4 \uABCD\uABE7 \uABC8\uABE8\uABDF\uABC5\uABE4, \uABCA\uABE6\uABDB\uABC7\uABE4 \uABCA\uABE7\uABD4\uABE4\uABD5\uABE4",
  "marketplace.emptyTitle": "\uABCA\uABD5\uABE4 \uABC1\uABE4\uABDF\uABD5 \uABCA\uABD5\uABE4 \uABCA\uABE7\uABD4\uABE4\uABD5\uABE4",
  "marketplace.emptyFiltered": "\uABCA\uABD5\uABE4 \uABCA\uABE7\uABD4\uABE4\uABD5\uABE4 \uABCA\uABD5\uABE4 \uABCA\uABE7\uABD4\uABE4\uABD5\uABE4 \uABCD\uABE7\uABD4\uABE4\uABD5\uABE4.",
  "marketplace.emptyNoProducts": "\uABCA\uABD5\uABE4 \uABC1\uABE4\uABDF\uABD5 \uABCA\uABE7\uABD4\uABE4\uABD5\uABE4 \uABCD\uABE7\uABD4\uABE4\uABD5\uABE4. \uABCA\uABD5\uABE4 \uABCD\uABE7\uABD4\uABE4\uABD5\uABE4 \uABCD\uABE7\uABD4\uABE4\uABD5\uABE4.",
  "marketplace.artisanUnnamed": "KalaSetu \uABCA\uABD5\uABE4 \uABCA\uABE7\uABD4\uABE4\uABD5\uABE4",
  "marketplace.backToBrowse": "\uABC3\uABD4\uABC6\uABE4 \uABCA\uABD5\uABE4",
  "marketplace.detailNotFoundTitle": "\uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4",
  "marketplace.detailNotFoundMessage": "\uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4 \uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4 \uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4",
  "marketplace.artisanSummaryTitle": "\uABCA\uABD5\uABE4\uABC1\uABE4 \uABCA\uABD5\uABE4 \uABCA\uABD5",
  "marketplace.artisanProductCount": "{n} \uABCA\uABD5\uABE4\uABC1\uABE4\uABC7\uABD5\uABE4 KalaSetu \uABCA\uABD5\uABE4",
  "marketplace.inquiryTitle": "\uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4 \uABCA\uABD5\uABE4?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\uABCA\uABD5\uABE4\uABC1\uABE4 \uABCD\uABE7\uABD4\uABE4 \uABCA\uABD5\uABE4 \uABCD\uABE7\uABD4\uABE4: \uABCA\uABD5\uABE4, \uABCA\uABD5\uABE4, \uABCA\uABD5\uABE4...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4",
  "marketplace.inquirySent": "\uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4 \uABCA\uABD5\uABE4. \uABCA\uABD5\uABE4\uABC1\uABE4 \uABCA\uABD5\uABE4 \uABCD\uABE7\uABD4\uABE4.",
  "marketplace.inquiryError": "\uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4 \uABCA\uABD5\uABE4 \uABCD\uABE7\uABD4\uABE4, \uABCA\uABD5 \uABCD\uABE7\uABD4\uABE4 \uABCA\uABD5\uABE4.",
  "marketplace.regionLabel": "\uABCA\uABD5\uABE4",
  "marketplace.regionUnspecified": "\uABCA\uABE7\uABD4\uABE4 \uABCD\uABDF\uABD5\uABE4",
  "marketplace.myInquiriesTitle": "\uABCA\uABD5\uABE4 \uABCA\uABD5\uABE4",
  "marketplace.inquiriesLoading": "\uABC2\uABE3\uABDD\uABD5\uABE4 \uABC5\uABE4 \uABCA\uABD5\uABE4...",
  "marketplace.inquiriesLoadError": "\uABC5\uABE4 \uABCA\uABD5\uABE4 \uABC2\uABE3\uABDD\uABD5\uABE4 \uA351\uABC1\uABE4",
  "marketplace.noInquiries": "\uABC5\uABE4 \uABCA\uABD5\uABE4 \uA351\uABC1\uABE4 \uA351\uABC1\uABE4. \uABC3\uABD4\uABC0\uABE6\uABE0 \uABCA\uABD5\uABE4 \uA351\uABC1\uABE4 \uA351\uABC1\uABE4.",
  "marketplace.inquiryProductRemoved": "\uABCA\uABD5\uABE4 \uABCD\uABDF\uABD5\uABE4 \uA351\uABC1\uABE4",
  "marketplace.inquiryStatusOpen": "\uABCD\uABDF\uABD5\uABE4 \uABCA\uABD5\uABE4",
  "marketplace.inquiryStatusClosed": "\uABCD\uABDF\uABD5\uABE4 \uA351\uABC1\uABE4",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/mr.json
var mr_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0924\u0941\u092E\u091A\u093E \u0939\u0938\u094D\u0924\u0915\u0932\u093E \u0911\u0928\u0932\u093E\u0907\u0928, \u0938\u094B\u092A\u094D\u092F\u093E \u092A\u0926\u094D\u0927\u0924\u0940\u0928\u0947 \u0935\u093F\u0915\u093E",
  "welcome.languageLabel": "\u0924\u0941\u092E\u091A\u0940 \u092D\u093E\u0937\u093E \u0928\u093F\u0935\u0921\u093E",
  "welcome.getStarted": "\u0938\u0941\u0930\u0942 \u0915\u0930\u093E",
  "language.en": "\u0907\u0902\u0917\u094D\u0930\u091C\u0940",
  "language.hi": "\u0939\u093F\u0902\u0926\u0940",
  "email.title": "\u0924\u0941\u092E\u091A\u093E \u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E \u091F\u093E\u0915\u093E",
  "email.roleQuestion": "\u092E\u0940 \u0907\u0925\u0947 \u0906\u0939\u0947",
  "email.roleSell": "\u092E\u093E\u091D\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0935\u093F\u0915\u093E",
  "email.roleBuy": "\u0939\u0938\u094D\u0924\u0928\u093F\u0930\u094D\u092E\u093F\u0924 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0916\u0930\u0947\u0926\u0940 \u0915\u0930\u093E",
  "email.label": "\u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E",
  "email.helper": "\u0906\u092E\u094D\u0939\u0940 \u0924\u0941\u092E\u094D\u0939\u093E\u0932\u093E \u096A \u0905\u0902\u0915\u0940 \u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u0942, \u0924\u0941\u092E\u091A\u0940 \u0913\u0933\u0916 \u092A\u0921\u0924\u093E\u0933\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940.",
  "email.invalid": "\u0935\u0948\u0927 \u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E \u091F\u093E\u0915\u093E",
  "email.sendOtp": "\u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u093E",
  "email.error": "\u0915\u094B\u0921 \u092A\u093E\u0920\u0935\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "otp.title": "\u0908\u092E\u0947\u0932 \u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u093E",
  "otp.subtitle": "\u092A\u093E\u0920\u0935\u0932\u0947\u0932\u093E \u096A-\u0905\u0902\u0915\u0940 \u0915\u094B\u0921 \u091F\u093E\u0915\u093E",
  "otp.emailUndelivered": "\u0908\u092E\u0947\u0932 \u092A\u093E\u0920\u0935\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940. \u0921\u0947\u092E\u094B \u0915\u094B\u0921\u0938\u093E\u0920\u0940 \u0924\u0941\u092E\u091A\u094D\u092F\u093E \u091F\u0940\u092E\u0932\u093E \u0935\u093F\u091A\u093E\u0930\u093E.",
  "otp.changeEmail": "\u0908\u092E\u0947\u0932 \u092C\u0926\u0932\u093E",
  "otp.verify": "\u0938\u0924\u094D\u092F\u093E\u092A\u093F\u0924 \u0915\u0930\u093E",
  "otp.invalid": "\u0938\u0930\u094D\u0935 \u096A \u0905\u0902\u0915 \u091F\u093E\u0915\u093E",
  "otp.wrong": "\u091A\u0941\u0915\u0940\u091A\u093E OTP, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "otp.resend": "OTP \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u093E\u0920\u0935\u093E",
  "otp.resendIn": "OTP {n}s \u092E\u0927\u094D\u092F\u0947 \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u093E\u0920\u0935\u093E",
  "otp.resendError": "OTP \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u093E\u0920\u0935\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "camera.capture": "\u092B\u094B\u091F\u094B \u0918\u094D\u092F\u093E",
  "camera.unavailable": "\u0915\u0945\u092E\u0947\u0930\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940, \u0924\u094D\u092F\u093E\u0910\u0935\u091C\u0940 \u092B\u094B\u091F\u094B \u0928\u093F\u0935\u0921\u093E",
  "camera.choosePhoto": "\u092B\u094B\u091F\u094B \u0928\u093F\u0935\u0921\u093E",
  "camera.retake": "\u092A\u0941\u0928\u094D\u0939\u093E \u0918\u094D\u092F\u093E",
  "camera.usePhoto": "\u0939\u093E \u092B\u094B\u091F\u094B \u0935\u093E\u092A\u0930\u093E",
  "camera.enhancing": "\u0924\u0941\u092E\u091A\u093E \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u093F\u0924 \u0939\u094B\u0924 \u0906\u0939\u0947...",
  "camera.enhanceError": "\u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940",
  "camera.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "camera.before": "\u092E\u0942\u0933",
  "camera.after": "\u0938\u0941\u0927\u093E\u0930\u093F\u0924",
  "camera.compareHint": "\u0924\u0941\u0932\u0928\u093E \u0915\u0930\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940 \u0938\u094D\u0932\u093E\u092F\u0921\u0930 \u0913\u0922\u093E",
  "camera.continue": "\u092A\u0941\u0922\u0947",
  "studio.title": "\u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u093F\u0924 \u0915\u0930\u093E",
  "studio.original": "\u092E\u0942\u0933",
  "studio.processed": "\u092A\u094D\u0930\u0915\u094D\u0930\u093F\u092F\u093E \u0915\u0947\u0932\u0947\u0932\u0947",
  "studio.removeBackground": "\u092A\u093E\u0930\u094D\u0936\u094D\u0935\u092D\u0942\u092E\u0940 \u0915\u093E\u0922\u093E",
  "studio.removingBackground": "\u092A\u093E\u0930\u094D\u0936\u094D\u0935\u092D\u0942\u092E\u0940 \u0915\u093E\u0922\u0924 \u0906\u0939\u0947...",
  "studio.keepOriginalBackground": "\u092E\u0942\u0933 \u092A\u093E\u0930\u094D\u0936\u094D\u0935\u092D\u0942\u092E\u0940 \u0920\u0947\u0935\u093E",
  "studio.backgroundWhite": "\u092A\u093E\u0902\u0922\u0930\u093E",
  "studio.backgroundNeutral": "\u092E\u090A \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0942\u0938\u0930",
  "studio.backgroundUnavailableNotice": "\u092A\u093E\u0930\u094D\u0936\u094D\u0935\u092D\u0942\u092E\u0940 \u0915\u093E\u0922\u0923\u0947 \u0938\u0927\u094D\u092F\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940. \u0924\u0941\u092E\u091A\u0940 \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u093E\u0939\u0940\u0932.",
  "studio.backgroundTimedOutNotice": "\u092A\u093E\u0930\u094D\u0936\u094D\u0935\u092D\u0942\u092E\u0940 \u0915\u093E\u0922\u0923\u094D\u092F\u093E\u0938 \u0916\u0942\u092A \u0935\u0947\u0933 \u0932\u093E\u0917\u0932\u093E \u0906\u0923\u093F \u0924\u0947 \u0935\u0917\u0933\u0932\u0947 \u0917\u0947\u0932\u0947. \u0924\u0941\u092E\u091A\u0940 \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u093E\u0939\u0940\u0932.",
  "studio.backgroundQuotaNotice": "\u092A\u093E\u0930\u094D\u0936\u094D\u0935\u092D\u0942\u092E\u0940 \u0915\u093E\u0922\u0923\u094D\u092F\u093E\u091A\u0940 \u092E\u0930\u094D\u092F\u093E\u0926\u093E \u092A\u094B\u0939\u094B\u091A\u0932\u0940 \u0906\u0939\u0947. \u0924\u0941\u092E\u091A\u0940 \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u093E\u0939\u0940\u0932.",
  "studio.backgroundFailedNotice": "\u092C\u0945\u0915\u0917\u094D\u0930\u093E\u0909\u0902\u0921 \u0915\u093E\u0922\u0923\u0947 \u0905\u092F\u0936\u0938\u094D\u0935\u0940. \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u093E\u0939\u093F\u0932\u093E.",
  "studio.brightness": "\u092A\u094D\u0930\u0915\u093E\u0936\u0924\u093E",
  "studio.contrast": "\u0935\u093F\u0930\u094B\u0927",
  "studio.sharpen": "\u0924\u0940\u0915\u094D\u0937\u094D\u0923 \u0915\u0930\u093E",
  "studio.autoLighting": "\u0938\u094D\u0935\u092F\u0902\u091A\u0932\u093F\u0924 \u092A\u094D\u0930\u0915\u093E\u0936",
  "studio.crop": "\u0915\u094D\u0930\u0949\u092A",
  "studio.cropOriginal": "\u092E\u0942\u0933",
  "studio.cropSquare": "\u091A\u094C\u0930\u0938",
  "studio.cropPortrait": "\u0909\u092D\u093E",
  "studio.accept": "\u0939\u0940 \u092B\u094B\u091F\u094B \u0935\u093E\u092A\u0930\u093E",
  "studio.retake": "\u092A\u0941\u0928\u094D\u0939\u093E \u0918\u094D\u092F\u093E",
  "studio.finalizing": "\u0924\u0941\u092E\u091A\u0947 \u092C\u0926\u0932 \u0932\u093E\u0917\u0942 \u0939\u094B\u0924 \u0906\u0939\u0947\u0924...",
  "studio.on": "\u091A\u093E\u0932\u0942",
  "studio.off": "\u092C\u0902\u0926",
  "category.title": "\u0924\u0941\u092E\u094D\u0939\u0940 \u0915\u093E\u092F \u0935\u093F\u0915\u0924 \u0906\u0939\u093E\u0924?",
  "category.continue": "\u092A\u0941\u0922\u0947",
  "category.materialQuestion": "\u0939\u0947 \u0915\u0936\u093E\u092A\u093E\u0938\u0942\u0928 \u092C\u0928\u0932\u0947\u0932\u0947 \u0906\u0939\u0947? (\u092A\u0930\u094D\u092F\u093E\u092F\u0940)",
  "category.textiles": "\u0915\u093E\u092A\u0921",
  "category.pottery": "\u092E\u093E\u0924\u0940\u091A\u0947 \u092D\u093E\u0902\u0921\u0940",
  "category.jewelry": "\u0926\u093E\u0917\u093F\u0928\u0947",
  "category.woodwork": "\u0932\u093E\u0915\u0921\u0940 \u0915\u093E\u092E",
  "category.bambooCane": "\u092C\u093E\u0902\u092C\u0942 \u0935 \u0935\u0947\u0924",
  "category.other": "\u0907\u0924\u0930",
  "voice.tapToRecord": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u091A\u0947 \u0935\u0930\u094D\u0923\u0928 \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940 \u091F\u0945\u092A \u0915\u0930\u093E",
  "voice.recording": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917...",
  "voice.stop": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0902\u0917 \u0925\u093E\u0902\u092C\u0935\u093E",
  "voice.record": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u093E",
  "voice.reviewRecording": "\u0910\u0915\u093E, \u0928\u0902\u0924\u0930 \u092A\u0941\u0922\u0947 \u091C\u093E \u0915\u093F\u0902\u0935\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u093E.",
  "voice.reRecord": "\u092A\u0941\u0928\u094D\u0939\u093E \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u093E",
  "voice.continue": "\u092A\u0941\u0922\u0947",
  "describe.transcribing": "\u0924\u0941\u092E\u091A\u0947 \u0935\u0930\u094D\u0923\u0928 \u0938\u092E\u091C\u0924 \u0906\u0939\u0947...",
  "describe.transcribeError": "\u0924\u0941\u092E\u091A\u0947 \u0935\u0930\u094D\u0923\u0928 \u0938\u092E\u091C\u0932\u0947 \u0928\u093E\u0939\u0940",
  "describe.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928",
  "describe.reviewHint": "\u0906\u0935\u0936\u094D\u092F\u0915 \u0905\u0938\u0932\u094D\u092F\u093E\u0938 \u092A\u0941\u0928\u0930\u093E\u0935\u0932\u094B\u0915\u0928 \u0935 \u0938\u0902\u092A\u093E\u0926\u0928 \u0915\u0930\u093E",
  "describe.fallbackNote": "\u092E\u093E\u092F\u0915\u094D\u0930\u094B\u092B\u094B\u0928 \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940, \u0924\u094D\u092F\u093E\u0910\u0935\u091C\u0940 \u0935\u0930\u094D\u0923\u0928 \u091F\u093E\u0907\u092A \u0915\u0930\u093E.",
  "describe.placeholderEn": "\u0924\u0941\u092E\u091A\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0907\u0902\u0917\u094D\u0930\u091C\u0940\u0924 \u0935\u0930\u094D\u0923\u0928 \u0915\u0930\u093E",
  "describe.continue": "\u092A\u0941\u0922\u0947",
  "pricing.title": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u091A\u0940 \u0915\u093F\u0902\u092E\u0924 \u0920\u0930\u0935\u093E",
  "pricing.summaryEdit": "\u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u093E",
  "pricing.materialCostLabel": "\u0938\u093E\u0939\u093F\u0924\u094D\u092F \u0916\u0930\u094D\u091A",
  "pricing.materialCostHelper": "\u0930\u0941\u092A\u092F\u093E\u0902\u0924 \u0915\u091A\u094D\u091A\u094D\u092F\u093E \u092E\u093E\u0932\u093E\u0935\u0930 \u0924\u0941\u092E\u094D\u0939\u0940 \u0915\u093F\u0924\u0940 \u0916\u0930\u094D\u091A \u0915\u0947\u0932\u093E \u0924\u0947 \u091F\u093E\u0915\u093E.",
  "pricing.materialCostInvalid": "\u0936\u0942\u0928\u094D\u092F\u093E\u092A\u0947\u0915\u094D\u0937\u093E \u091C\u093E\u0938\u094D\u0924 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0916\u0930\u094D\u091A \u091F\u093E\u0915\u093E.",
  "pricing.getSuggestion": "\u0915\u093F\u0902\u092E\u0924 \u0938\u0941\u091A\u0935\u093E",
  "pricing.suggestError": "\u0915\u093F\u0902\u092E\u0924 \u0938\u0941\u091A\u0935\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940",
  "pricing.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "pricing.rangeLabel": "\u0938\u0941\u091A\u0935\u0932\u0947\u0932\u0940 \u0915\u093F\u0902\u092E\u0924 \u0936\u094D\u0930\u0947\u0923\u0940",
  "pricing.sellingPriceLabel": "\u0924\u0941\u092E\u091A\u0940 \u0935\u093F\u0915\u094D\u0930\u0940 \u0915\u093F\u0902\u092E\u0924",
  "pricing.sellingPriceNote": "\u0939\u0940 \u092B\u0915\u094D\u0924 \u0938\u0941\u091A\u0928\u093E \u0906\u0939\u0947, \u0924\u0941\u092E\u094D\u0939\u0940 \u0939\u0935\u0940 \u0924\u0940 \u0915\u093F\u0902\u092E\u0924 \u0920\u0930\u0935\u0942 \u0936\u0915\u0924\u093E.",
  "pricing.sellingPriceInvalid": "\u0936\u0942\u0928\u094D\u092F\u093E\u092A\u0947\u0915\u094D\u0937\u093E \u091C\u093E\u0938\u094D\u0924 \u0935\u093F\u0915\u094D\u0930\u0940 \u0915\u093F\u0902\u092E\u0924 \u091F\u093E\u0915\u093E.",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0915\u0930\u093E",
  "pricing.publishError": "\u0924\u0941\u092E\u091A\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0915\u0930\u0924\u093E \u0906\u0932\u0947 \u0928\u093E\u0939\u0940",
  "pricing.successTitle": "\u0924\u0941\u092E\u091A\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0906\u0924\u093E \u0932\u093E\u0907\u0935\u094D\u0939 \u0906\u0939\u0947!",
  "pricing.successMessage": "\u0916\u0930\u0947\u0926\u0940\u0926\u093E\u0930 \u0906\u0924\u093E \u0924\u0941\u092E\u091A\u094D\u092F\u093E \u0926\u0941\u0915\u093E\u0928\u093E\u0924 \u0924\u0947 \u0936\u094B\u0927\u0942 \u0936\u0915\u0924\u0940\u0932.",
  "pricing.viewShop": "\u092E\u093E\u091D\u094D\u092F\u093E \u0926\u0941\u0915\u093E\u0928\u093E\u0924 \u092A\u0939\u093E",
  "home.title": "\u092E\u093E\u091D\u0947 \u0926\u0941\u0915\u093E\u0928",
  "home.gemBannerTitle": "GeM / ONDC \u0936\u0940 \u0915\u0928\u0947\u0915\u094D\u091F \u0915\u0930\u093E",
  "home.gemBannerBadge": "\u0932\u0935\u0915\u0930\u091A",
  "home.gemBannerMessage": "\u0939\u0940 \u090F\u0915\u0924\u094D\u0930\u0940\u0915\u0930\u0923 \u0932\u0935\u0915\u0930\u091A \u092F\u0947\u0923\u093E\u0930 \u0906\u0939\u0947.",
  "home.loading": "\u0924\u0941\u092E\u091A\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0932\u094B\u0921 \u0939\u094B\u0924 \u0906\u0939\u0947\u0924...",
  "home.loadError": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0932\u094B\u0921 \u0915\u0930\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940\u0924",
  "home.retry": "\u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "home.emptyTitle": "\u0905\u091C\u0942\u0928 \u0915\u094B\u0923\u0924\u0940\u0939\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0928\u093E\u0939\u0940\u0924",
  "home.emptyMessage": "KalaSetu \u0935\u0930 \u0935\u093F\u0915\u094D\u0930\u0940 \u0938\u0941\u0930\u0942 \u0915\u0930\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940 \u0924\u0941\u092E\u091A\u093E \u092A\u0939\u093F\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u091C\u094B\u0921\u093E.",
  "home.addFirstProduct": "\u0924\u0941\u092E\u091A\u093E \u092A\u0939\u093F\u0932\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u091C\u094B\u0921\u093E",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u092E\u0938\u0941\u0926\u093E",
  "home.statusFailed": "\u0905\u092F\u0936\u0938\u094D\u0935\u0940",
  "home.detailCategory": "\u0936\u094D\u0930\u0947\u0923\u0940",
  "home.detailEdit": "\u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u093E",
  "home.detailDelete": "\u0939\u091F\u0935\u093E",
  "home.detailClose": "\u092C\u0902\u0926 \u0915\u0930\u093E",
  "home.editPriceLabel": "\u0915\u093F\u0902\u092E\u0924",
  "home.editDescriptionLabel": "\u0935\u0930\u094D\u0923\u0928",
  "home.editSave": "\u092C\u0926\u0932 \u091C\u0924\u0928 \u0915\u0930\u093E",
  "home.editCancel": "\u0930\u0926\u094D\u0926 \u0915\u0930\u093E",
  "home.editPriceInvalid": "0 \u092A\u0947\u0915\u094D\u0937\u093E \u091C\u093E\u0938\u094D\u0924 \u0915\u093F\u0902\u092E\u0924 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F \u0915\u0930\u093E",
  "home.editDescriptionRequired": "\u0935\u0930\u094D\u0923\u0928 \u0915\u094B\u0923\u0924\u094D\u092F\u093E\u0939\u0940 \u092D\u093E\u0937\u0947\u0924 \u0930\u093F\u0915\u093E\u092E\u0947 \u0905\u0938\u0942 \u0936\u0915\u0924 \u0928\u093E\u0939\u0940",
  "home.editError": "\u092C\u0926\u0932 \u091C\u0924\u0928 \u091D\u093E\u0932\u0947 \u0928\u093E\u0939\u0940\u0924, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "home.deleteConfirm": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0939\u091F\u0935\u093E\u092F\u091A\u0947? \u0939\u0947 \u092A\u0930\u0924 \u0918\u0947\u0924\u093E \u092F\u0947\u0923\u093E\u0930 \u0928\u093E\u0939\u0940.",
  "home.deleteConfirmYes": "\u0939\u094B\u092F, \u0939\u091F\u0935\u093E",
  "home.deleteError": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0939\u091F\u0935\u0924\u093E \u0906\u0932\u0947 \u0928\u093E\u0939\u0940, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "profile.emailLabel": "\u0908\u092E\u0947\u0932 \u092A\u0924\u094D\u0924\u093E",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940",
  "profile.loading": "\u0924\u0941\u092E\u091A\u093E \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u0939\u094B\u0924 \u0906\u0939\u0947...",
  "profile.loadError": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u0915\u0930\u0924\u093E \u0906\u0932\u093E \u0928\u093E\u0939\u0940",
  "profile.displayNameLabel": "\u0924\u0941\u092E\u091A\u0947 \u0928\u093E\u0935",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928\u093E\u091A\u0947 \u0928\u093E\u0935",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u091C\u0924\u0928 \u0915\u0930\u093E",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u091C\u0924\u0928 \u091D\u093E\u0932\u0947",
  "profile.saveError": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u091C\u0924\u0928 \u0939\u094B\u090A \u0936\u0915\u0932\u0947 \u0928\u093E\u0939\u0940, \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "profile.logout": "\u092C\u093E\u0939\u0947\u0930 \u092A\u0921\u093E",
  "install.message": "\u091C\u0932\u0926 \u092A\u094D\u0930\u0935\u0947\u0936\u093E\u0938\u093E\u0920\u0940 KalaSetu \u0907\u0928\u094D\u0938\u094D\u091F\u0949\u0932 \u0915\u0930\u093E",
  "install.action": "\u0907\u0928\u094D\u0938\u094D\u091F\u0949\u0932 \u0915\u0930\u093E",
  "install.dismiss": "\u0928\u093E\u0915\u093E\u0930",
  "offline.message": "\u0924\u0941\u092E\u094D\u0939\u0940 \u0911\u092B\u0932\u093E\u0907\u0928 \u0906\u0939\u093E\u0924, \u0915\u093E\u0939\u0940 \u092B\u0940\u091A\u0930 \u0915\u093E\u0930\u094D\u092F \u0915\u0930\u0923\u093E\u0930 \u0928\u093E\u0939\u0940\u0924",
  "welcome.languageHint": "\u0938\u0902\u092A\u0942\u0930\u094D\u0923 \u0905\u0945\u092A \u092F\u093E \u092D\u093E\u0937\u0947\u0924 \u0905\u0938\u0947\u0932.",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E",
  "describe.localTab": "\u0906\u092A\u0932\u0940 \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0906\u092A\u0932\u094D\u092F\u093E \u0938\u094D\u0935\u0924\u0903\u091A\u094D\u092F\u093E \u092D\u093E\u0937\u0947\u0924 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u091A\u0947 \u0935\u0930\u094D\u0923\u0928 \u0915\u0930\u093E",
  "describe.syncing": "\u0907\u0924\u0930 \u092D\u093E\u0937\u093E \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0930\u0924 \u0906\u0939\u0947...",
  "describe.syncFailed": "\u0907\u0924\u0930 \u092D\u093E\u0937\u093E \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0930\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940. \u0906\u0935\u0936\u094D\u092F\u0915 \u0905\u0938\u0932\u094D\u092F\u093E\u0938 \u0938\u094D\u0935\u0924\u0903 \u0938\u0902\u092A\u093E\u0926\u093F\u0924 \u0915\u0930\u093E.",
  "describe.syncHint": "\u0938\u0902\u092A\u093E\u0926\u0928 \u0906\u092A\u094B\u0906\u092A \u0907\u0924\u0930 \u092D\u093E\u0937\u0947\u0924 \u0915\u0949\u092A\u0940 \u0915\u0947\u0932\u0947 \u091C\u093E\u0924\u093E\u0924.",
  "pricing.updating": "\u0928\u0935\u0940\u0928 \u0938\u093E\u0939\u093F\u0924\u094D\u092F \u0916\u0930\u094D\u091A\u093E\u0938\u093E\u0920\u0940 \u0905\u0926\u094D\u092F\u0924\u0928 \u091A\u093E\u0932\u0942 \u0906\u0939\u0947...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0915\u0945\u091F\u0932\u0949\u0917 \u0928\u093F\u0930\u094D\u092F\u093E\u0924 \u0915\u0930\u093E (ONDC \u0938\u094D\u0935\u0930\u0942\u092A)",
  "home.exportCatalogNote": "\u0906\u092A\u0932\u094D\u092F\u093E \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0932\u093F\u0938\u094D\u091F\u093F\u0902\u0917\u094D\u091C\u0928\u093E ONDC \u0930\u093F\u091F\u0947\u0932 \u0915\u0945\u091F\u0932\u0949\u0917 \u0938\u0902\u0930\u091A\u0928\u0947\u0936\u0940 \u091C\u0941\u0933\u0935\u0942\u0928 \u0921\u093E\u0909\u0928\u0932\u094B\u0921 \u0915\u0930\u0924\u0947. \u0907\u0902\u091F\u093F\u0917\u094D\u0930\u0947\u0936\u0928-\u0930\u0947\u0921\u0940: \u092E\u0945\u092A\u093F\u0902\u0917 \u092A\u0942\u0930\u094D\u0923 \u0906\u0939\u0947, \u0928\u0947\u091F\u0935\u0930\u094D\u0915\u0935\u0930 \u0932\u093E\u0908\u0935\u094D\u0939 \u0939\u094B\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940 \u0905\u091C\u0942\u0928 ONDC \u0928\u094B\u0902\u0926\u0923\u0940 \u0906\u0935\u0936\u094D\u092F\u0915 \u0906\u0939\u0947.",
  "home.exportOndcSingle": "\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u091A\u0940 \u0928\u093F\u0930\u094D\u092F\u093E\u0924 \u0915\u0930\u093E (ONDC \u0938\u094D\u0935\u0930\u0942\u092A)",
  "profile.relocalising": "\u0906\u092A\u0932\u094D\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0902\u0928\u093E \u092F\u093E \u092D\u093E\u0937\u0947\u0924 \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0930\u0924 \u0906\u0939\u0947...",
  "profile.relocalised": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0902\u0928\u093E \u092F\u093E \u092D\u093E\u0937\u0947\u0924 \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0947\u0932\u0947.",
  "profile.relocaliseFailed": "\u0915\u093E\u0939\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0902 \u0905\u0926\u094D\u092F\u092F\u093E\u0935\u0924 \u0915\u0930\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940\u0924. \u0928\u0902\u0924\u0930 \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E.",
  "marketplace.navBrowse": "\u092C\u094D\u0930\u093E\u0909\u091D",
  "marketplace.navProfile": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "marketplace.browseTitle": "\u092C\u093E\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0936\u094B\u0927\u093E...",
  "marketplace.filtersTitle": "\u092B\u093F\u0932\u094D\u091F\u0930",
  "marketplace.filtersClear": "\u0938\u0930\u094D\u0935 \u0938\u093E\u092B \u0915\u0930\u093E",
  "marketplace.filterAll": "\u0938\u0930\u094D\u0935",
  "marketplace.filterMaterial": "\u0938\u093E\u0939\u093F\u0924\u094D\u092F",
  "marketplace.filterRegion": "\u092A\u094D\u0930\u0926\u0947\u0936",
  "marketplace.filterPrice": "\u0915\u093F\u0902\u092E\u0924 \u0936\u094D\u0930\u0947\u0923\u0940 (\u20B9)",
  "marketplace.filterPriceMin": "\u0915\u093F\u092E\u093E\u0928",
  "marketplace.filterPriceMax": "\u0915\u092E\u093E\u0932",
  "marketplace.sortLabel": "\u0915\u094D\u0930\u092E\u093E\u0928\u0941\u0938\u093E\u0930",
  "marketplace.sortNewest": "\u0928\u0935\u0940\u0928\u0924\u092E \u092A\u094D\u0930\u0925\u092E",
  "marketplace.sortPriceAsc": "\u0915\u093F\u0902\u092E\u0924: \u0915\u092E\u0940 \u0924\u0947 \u091C\u093E\u0938\u094D\u0924",
  "marketplace.sortPriceDesc": "\u0915\u093F\u0902\u092E\u0924: \u091C\u093E\u0938\u094D\u0924 \u0924\u0947 \u0915\u092E\u0940",
  "marketplace.resultCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0938\u093E\u092A\u0921\u0932\u0940",
  "marketplace.loadMore": "\u0905\u0927\u093F\u0915 \u0932\u094B\u0921 \u0915\u0930\u093E",
  "marketplace.loadError": "\u092E\u093E\u0930\u094D\u0915\u0947\u091F\u092A\u094D\u0932\u0947\u0938 \u0932\u094B\u0921 \u0939\u094B\u090A \u0936\u0915\u0932\u093E \u0928\u093E\u0939\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "marketplace.emptyTitle": "\u092F\u093E \u092B\u093F\u0932\u094D\u091F\u0930\u0936\u0940 \u091C\u0941\u0933\u0923\u093E\u0930\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u0928\u093E\u0939\u0940\u0924",
  "marketplace.emptyFiltered": "\u092B\u093F\u0932\u094D\u091F\u0930 \u0915\u093E\u0922\u093E \u0915\u093F\u0902\u0935\u093E \u0926\u0941\u0938\u0930\u0947 \u0915\u093E\u0939\u0940 \u0936\u094B\u0927\u093E.",
  "marketplace.emptyNoProducts": "\u0906\u0924\u093E \u092A\u0930\u094D\u092F\u0902\u0924 \u0915\u094B\u0923\u0924\u0940\u0939\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0928\u093E\u0939\u0940\u0924. \u0932\u0935\u0915\u0930\u091A \u0924\u092A\u093E\u0938\u093E.",
  "marketplace.artisanUnnamed": "KalaSetu \u0915\u093E\u0930\u093E\u0917\u0940\u0930",
  "marketplace.backToBrowse": "\u092C\u093E\u091C\u093E\u0930\u093E\u0924 \u092A\u0930\u0924 \u091C\u093E",
  "marketplace.detailNotFoundTitle": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0938\u093E\u092A\u0921\u0932\u0947 \u0928\u093E\u0939\u0940",
  "marketplace.detailNotFoundMessage": "\u0939\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0915\u093E\u0922\u0932\u0947 \u0917\u0947\u0932\u0947 \u0905\u0938\u0942 \u0936\u0915\u0924\u0947 \u0915\u093F\u0902\u0935\u093E \u0906\u0924\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940.",
  "marketplace.artisanSummaryTitle": "\u0915\u093E\u0930\u093E\u0917\u0940\u0930\u093E\u092C\u0926\u094D\u0926\u0932",
  "marketplace.artisanProductCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947 KalaSetu \u0935\u0930 \u0938\u0942\u091A\u0940\u092C\u0926\u094D\u0927",
  "marketplace.inquiryTitle": "\u092F\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u093E\u0924 \u0930\u0938 \u0906\u0939\u0947 \u0915\u093E?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0915\u093E\u0930\u093E\u0917\u0940\u0930\u093E\u0932\u093E \u0938\u093E\u0902\u0917\u093E \u0924\u0941\u092E\u094D\u0939\u093E\u0932\u093E \u0915\u093E\u092F \u0939\u0935\u0902 \u0906\u0939\u0947: \u092A\u094D\u0930\u092E\u093E\u0923, \u0938\u093E\u0928\u0941\u0915\u0942\u0932\u0928, \u0935\u093F\u0924\u0930\u0923 \u0935\u0947\u0933...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0935\u093F\u091A\u093E\u0930\u0923\u093E \u092A\u093E\u0920\u0935\u093E",
  "marketplace.inquirySent": "\u0924\u0941\u092E\u091A\u0940 \u0935\u093F\u091A\u093E\u0930\u0923\u093E \u092A\u093E\u0920\u0935\u0932\u0940 \u0917\u0947\u0932\u0940 \u0906\u0939\u0947. \u0915\u093E\u0930\u093E\u0917\u0940\u0930 \u0932\u0935\u0915\u0930\u091A \u0938\u0902\u092A\u0930\u094D\u0915 \u0915\u0930\u0947\u0932.",
  "marketplace.inquiryError": "\u0935\u093F\u091A\u093E\u0930\u0923\u093E \u092A\u093E\u0920\u0935\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u094D\u0939\u093E \u092A\u094D\u0930\u092F\u0924\u094D\u0928 \u0915\u0930\u093E",
  "marketplace.regionLabel": "\u092A\u094D\u0930\u0926\u0947\u0936",
  "marketplace.regionUnspecified": "\u0928\u093F\u0930\u094D\u0926\u093F\u0937\u094D\u091F \u0928\u093E\u0939\u0940",
  "marketplace.myInquiriesTitle": "\u092E\u093E\u091D\u0940 \u091A\u094C\u0915\u0936\u0940",
  "marketplace.inquiriesLoading": "\u0924\u0941\u092E\u091A\u0940 \u091A\u094C\u0915\u0936\u0940 \u0932\u094B\u0921 \u0939\u094B\u0924 \u0906\u0939\u0947...",
  "marketplace.inquiriesLoadError": "\u091A\u094C\u0915\u0936\u0940 \u0932\u094B\u0921 \u0915\u0930\u0924\u093E \u0906\u0932\u0940 \u0928\u093E\u0939\u0940",
  "marketplace.noInquiries": "\u0924\u0941\u092E\u094D\u0939\u0940 \u0905\u091C\u0942\u0928 \u0915\u094B\u0923\u0924\u0940\u0939\u0940 \u091A\u094C\u0915\u0936\u0940 \u092A\u093E\u0920\u0935\u0932\u0940 \u0928\u093E\u0939\u0940. \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0902 \u0936\u094B\u0927\u0923\u094D\u092F\u093E\u0938\u093E\u0920\u0940 \u092E\u093E\u0930\u094D\u0915\u0947\u091F\u092A\u094D\u0932\u0947\u0938 \u092C\u0918\u093E.",
  "marketplace.inquiryProductRemoved": "\u0939\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0906\u0924\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0939\u0940",
  "marketplace.inquiryStatusOpen": "\u092A\u094D\u0930\u0924\u093F\u0938\u093E\u0926\u093E\u091A\u0940 \u0935\u093E\u091F \u092A\u093E\u0939\u0924 \u0906\u0939\u0947",
  "marketplace.inquiryStatusClosed": "\u092C\u0902\u0926",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/ne.json
var ne_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0939\u0938\u094D\u0924\u0915\u0932\u093E \u0905\u0928\u0932\u093E\u0907\u0928 \u092C\u0947\u091A\u094D\u0928\u0941\u0939\u094B\u0938\u094D, \u0938\u091C\u093F\u0932\u094B \u0924\u0930\u093F\u0915\u093E\u0932\u0947\u0964",
  "welcome.languageLabel": "\u092D\u093E\u0937\u093E \u091B\u093E\u0928\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "welcome.getStarted": "\u0938\u0941\u0930\u0941 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "language.en": "\u0905\u0902\u0917\u094D\u0930\u0947\u091C\u0940",
  "language.hi": "\u0939\u093F\u0928\u094D\u0926\u0940",
  "email.title": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0907\u092E\u0947\u0932 \u0920\u0947\u0917\u093E\u0928\u093E \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "email.roleQuestion": "\u092E \u092F\u0939\u093E\u0901 \u091B\u0941",
  "email.roleSell": "\u092E\u0947\u0930\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092C\u0947\u091A\u094D\u0928\u0941",
  "email.roleBuy": "\u0939\u0938\u094D\u0924\u0928\u093F\u0930\u094D\u092E\u093F\u0924 \u0938\u093E\u092E\u093E\u0928 \u0915\u093F\u0928\u094D\u0928\u0941",
  "email.label": "\u0907\u092E\u0947\u0932 \u0920\u0947\u0917\u093E\u0928\u093E",
  "email.helper": "\u0939\u093E\u092E\u0940 \u096A \u0905\u0919\u094D\u0915\u0915\u094B \u0915\u094B\u0921 \u092A\u0920\u093E\u0909\u0928\u0947\u091B\u094C\u0902, \u091C\u0938\u0932\u0947 \u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092A\u0939\u093F\u091A\u093E\u0928 \u092A\u0941\u0937\u094D\u091F\u093F \u0917\u0930\u094D\u0928\u0947\u091B\u0964",
  "email.invalid": "\u0935\u0948\u0927 \u0907\u092E\u0947\u0932 \u0920\u0947\u0917\u093E\u0928\u093E \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "email.sendOtp": "\u0915\u094B\u0921 \u092A\u0920\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "email.error": "\u0915\u094B\u0921 \u092A\u0920\u093E\u0909\u0928 \u0938\u0915\u093F\u090F\u0928, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.title": "\u0907\u092E\u0947\u0932 \u092A\u0941\u0937\u094D\u091F\u093F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.subtitle": "\u092D\u0947\u091C\u093F\u090F\u0915\u094B \u096A \u0905\u0919\u094D\u0915\u0915\u094B \u0915\u094B\u0921 \u092F\u0939\u093E\u0901 \u091F\u093E\u0907\u092A \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.emailUndelivered": "\u0939\u093E\u092E\u0940 \u0907\u092E\u0947\u0932 \u092A\u0920\u093E\u0909\u0928 \u0938\u0915\u0947\u0928\u094C\u0902\u0964 \u0921\u0947\u092E\u094B \u0915\u094B\u0921\u0915\u094B \u0932\u093E\u0917\u093F \u0906\u092B\u094D\u0928\u094B \u091F\u093F\u092E\u0938\u0901\u0917 \u0938\u094B\u0927\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "otp.changeEmail": "\u0907\u092E\u0947\u0932 \u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.verify": "\u092A\u0941\u0937\u094D\u091F\u093F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.invalid": "\u0938\u092C\u0948 \u096A \u0905\u0919\u094D\u0915 \u091F\u093E\u0907\u092A \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.wrong": "\u0917\u0932\u0924 OTP, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928: \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.resend": "OTP \u092A\u0941\u0928: \u092A\u0920\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.resendIn": "OTP {n}s \u092A\u091B\u093F \u092A\u0941\u0928: \u092A\u0920\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "otp.resendError": "OTP \u092A\u0941\u0928: \u092A\u0920\u093E\u0909\u0928 \u0938\u0915\u0947\u0928\u094C\u0902, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928: \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "camera.capture": "\u092B\u094B\u091F\u094B \u0916\u093F\u091A\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "camera.unavailable": "\u0915\u094D\u092F\u093E\u092E\u0947\u0930\u093E \u0909\u092A\u0932\u092C\u094D\u0927 \u091B\u0948\u0928, \u0915\u0943\u092A\u092F\u093E \u092B\u094B\u091F\u094B \u091B\u093E\u0928\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "camera.choosePhoto": "\u092B\u094B\u091F\u094B \u091B\u093E\u0928\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "camera.retake": "\u092B\u0947\u0930\u093F \u0932\u093F\u0907\u092F\u094B",
  "camera.usePhoto": "\u092F\u094B \u092B\u094B\u091F\u094B \u092A\u094D\u0930\u092F\u094B\u0917 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "camera.enhancing": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u094D\u0926\u0948...",
  "camera.enhanceError": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928",
  "camera.retry": "\u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938",
  "camera.before": "\u092E\u0942\u0932",
  "camera.after": "\u0938\u0941\u0927\u093E\u0930\u093F\u090F\u0915\u094B",
  "camera.compareHint": "\u0924\u0941\u0932\u0928\u093E \u0917\u0930\u094D\u0928 \u0938\u094D\u0932\u093E\u0907\u0921\u0930 \u091F\u093E\u0928\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "camera.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "studio.title": "\u092B\u094B\u091F\u094B \u0938\u0941\u0927\u093E\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "studio.original": "\u092E\u0942\u0932",
  "studio.processed": "\u092A\u094D\u0930\u0915\u094D\u0930\u093F\u092F\u093E \u0917\u0930\u093F\u090F\u0915\u094B",
  "studio.removeBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "studio.removingBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0907\u0901\u0926\u0948\u091B...",
  "studio.keepOriginalBackground": "\u092E\u0942\u0932 \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0930\u093E\u0916\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "studio.backgroundWhite": "\u0938\u0947\u0924\u094B",
  "studio.backgroundNeutral": "\u0928\u0930\u092E \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0941\u0902\u0927\u094B",
  "studio.backgroundUnavailableNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0909\u0928\u0947 \u0938\u0941\u0935\u093F\u0927\u093E \u0905\u0939\u093F\u0932\u0947 \u0909\u092A\u0932\u092C\u094D\u0927 \u091B\u0948\u0928\u0964 \u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092B\u094B\u091F\u094B \u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u092D\u090F\u0915\u094B \u091B\u0948\u0928\u0964",
  "studio.backgroundTimedOutNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0909\u0928 \u0927\u0947\u0930\u0948 \u0938\u092E\u092F \u0932\u093E\u0917\u094D\u092F\u094B \u0930 \u091B\u094B\u0921\u093F\u092F\u094B\u0964 \u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092B\u094B\u091F\u094B \u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u092D\u090F\u0915\u094B \u091B\u0948\u0928\u0964",
  "studio.backgroundQuotaNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0909\u0928\u0947 \u0915\u094B\u091F\u093E \u0905\u0939\u093F\u0932\u0947 \u0938\u092E\u093E\u092A\u094D\u0924 \u092D\u092F\u094B\u0964 \u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092B\u094B\u091F\u094B \u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u092D\u090F\u0915\u094B \u091B\u0948\u0928\u0964",
  "studio.backgroundFailedNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F \u0939\u091F\u093E\u0909\u0928 \u0905\u0938\u092B\u0932 \u092D\u092F\u094B\u0964 \u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092B\u094B\u091F\u094B \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924 \u0930\u0939\u094D\u092F\u094B\u0964",
  "studio.brightness": "\u091A\u092E\u094D\u0915\u093F\u0932\u094B\u092A\u0928",
  "studio.contrast": "\u0935\u093F\u0930\u094B\u0927\u093E\u092D\u093E\u0938",
  "studio.sharpen": "\u0927\u093E\u0930\u093F\u0932\u094B \u092C\u0928\u093E\u0909\u0928\u0941",
  "studio.autoLighting": "\u0938\u094D\u0935\u091A\u093E\u0932\u093F\u0924 \u092A\u094D\u0930\u0915\u093E\u0936",
  "studio.crop": "\u0915\u091F \u0917\u0930\u094D\u0928\u0941",
  "studio.cropOriginal": "\u092E\u0942\u0932",
  "studio.cropSquare": "\u0935\u0930\u094D\u0917",
  "studio.cropPortrait": "\u0909\u092D\u093F\u092F\u094B",
  "studio.accept": "\u092F\u094B \u092B\u094B\u091F\u094B \u092A\u094D\u0930\u092F\u094B\u0917 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "studio.retake": "\u092B\u0947\u0930\u093F \u0932\u093F\u0928\u0941\u0939\u094B\u0938\u094D",
  "studio.finalizing": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0938\u092E\u094D\u092A\u093E\u0926\u0928 \u0932\u093E\u0917\u0942 \u0917\u0930\u093F\u0901\u0926\u0948\u091B...",
  "studio.on": "\u091A\u093E\u0932\u0941",
  "studio.off": "\u092C\u0928\u094D\u0926",
  "category.title": "\u0924\u092A\u093E\u0908\u0902 \u0915\u0947 \u092C\u0947\u091A\u094D\u0926\u0948 \u0939\u0941\u0928\u0941\u0939\u0941\u0928\u094D\u091B?",
  "category.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "category.materialQuestion": "\u092F\u094B \u0915\u0947\u092C\u093E\u091F \u092C\u0928\u093E\u0907\u090F\u0915\u094B \u0939\u094B? (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "category.textiles": "\u0915\u092A\u0921\u093E",
  "category.pottery": "\u092E\u093E\u091F\u094B\u0915\u093E \u092C\u0930\u094D\u0924\u0928",
  "category.jewelry": "\u0917\u0939\u0928\u093E",
  "category.woodwork": "\u0915\u093E\u0920\u0915\u0932\u093E",
  "category.bambooCane": "\u092C\u093E\u0901\u0938 \u0930 \u0917\u0928\u094D\u0928\u093E",
  "category.other": "\u0905\u0928\u094D\u092F",
  "voice.tapToRecord": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0915\u094B \u0935\u093F\u0935\u0930\u0923 \u0930\u0947\u0915\u0930\u094D\u0921 \u0917\u0930\u094D\u0928 \u091F\u094D\u092F\u093E\u092A \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "voice.recording": "\u0930\u0947\u0915\u0930\u094D\u0921 \u0939\u0941\u0901\u0926\u0948\u091B...",
  "voice.stop": "\u0930\u0947\u0915\u0930\u094D\u0921 \u0930\u094B\u0915\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "voice.record": "\u0930\u0947\u0915\u0930\u094D\u0921",
  "voice.reviewRecording": "\u092A\u0941\u0928: \u0938\u0941\u0928\u094D\u0928\u0941\u0939\u094B\u0938\u094D, \u0924\u094D\u092F\u0938\u092A\u091B\u093F \u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u094D\u0928\u0941\u0939\u094B\u0938\u094D \u0935\u093E \u092A\u0941\u0928: \u0930\u0947\u0915\u0930\u094D\u0921 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D.",
  "voice.reRecord": "\u092A\u0941\u0928: \u0930\u0947\u0915\u0930\u094D\u0921",
  "voice.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "describe.transcribing": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0935\u093F\u0935\u0930\u0923 \u092C\u0941\u091D\u094D\u0926\u0948\u091B\u0941...",
  "describe.transcribeError": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0935\u093F\u0935\u0930\u0923 \u092C\u0941\u091D\u094D\u0928 \u0938\u0915\u0947\u0928",
  "describe.retry": "\u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938",
  "describe.reviewHint": "\u0938\u092E\u0940\u0915\u094D\u0937\u093E \u0930 \u0938\u092E\u094D\u092A\u093E\u0926\u0928 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "describe.fallbackNote": "\u092E\u093E\u0907\u0915\u094D\u0930\u094B\u092B\u094B\u0928 \u0909\u092A\u0932\u092C\u094D\u0927 \u091B\u0948\u0928, \u0935\u093F\u0935\u0930\u0923 \u091F\u093E\u0907\u092A \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D.",
  "describe.placeholderEn": "\u0905\u0902\u0917\u094D\u0930\u0947\u091C\u0940\u092E\u093E \u0906\u092B\u094D\u0928\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0935\u0930\u094D\u0923\u0928 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "describe.continue": "\u091C\u093E\u0930\u0940 \u0930\u093E\u0916\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "pricing.title": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0915\u094B \u092E\u0942\u0932\u094D\u092F \u0928\u093F\u0930\u094D\u0927\u093E\u0930\u0923",
  "pricing.summaryEdit": "\u0938\u092E\u094D\u092A\u093E\u0926\u0928",
  "pricing.materialCostLabel": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924",
  "pricing.materialCostHelper": "\u0915\u091A\u094D\u091A\u093E \u0938\u093E\u092E\u0917\u094D\u0930\u0940\u092E\u093E \u0916\u0930\u094D\u091A \u0917\u0930\u0947\u0915\u094B \u0930\u0915\u092E, \u0930\u0941\u092A\u0948\u092F\u093E\u0901\u092E\u093E \u092D\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D.",
  "pricing.materialCostInvalid": "0 \u092D\u0928\u094D\u0926\u093E \u092C\u0922\u0940 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "pricing.getSuggestion": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935 \u092A\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "pricing.suggestError": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935 \u092A\u094D\u0930\u093E\u092A\u094D\u0924 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928",
  "pricing.retry": "\u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938",
  "pricing.rangeLabel": "\u0938\u0941\u091D\u093E\u0935 \u0917\u0930\u093F\u090F\u0915\u094B \u092E\u0942\u0932\u094D\u092F \u0938\u0940\u092E\u093E",
  "pricing.sellingPriceLabel": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092C\u093F\u0915\u094D\u0930\u0940 \u092E\u0942\u0932\u094D\u092F",
  "pricing.sellingPriceNote": "\u092F\u094B \u0938\u0941\u091D\u093E\u0935 \u092E\u093E\u0924\u094D\u0930 \u0939\u094B, \u0924\u092A\u093E\u0908\u0902 \u092E\u0928\u092A\u0930\u094D\u0928\u0947 \u0915\u0941\u0928\u0948 \u092A\u0928\u093F \u092E\u0942\u0932\u094D\u092F \u0938\u0947\u091F \u0917\u0930\u094D\u0928 \u0938\u0915\u094D\u0928\u0941\u0939\u0941\u0928\u094D\u091B.",
  "pricing.sellingPriceInvalid": "0 \u092D\u0928\u094D\u0926\u093E \u092C\u0922\u0940 \u092C\u093F\u0915\u094D\u0930\u0940 \u092E\u0942\u0932\u094D\u092F \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "pricing.publishError": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928",
  "pricing.successTitle": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0932\u093E\u0907\u092D \u091B!",
  "pricing.successMessage": "\u0916\u0930\u0947\u0926\u0940\u0926\u093E\u0930\u0939\u0930\u0942 \u0905\u092C \u092F\u0938\u0932\u093E\u0908 \u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092A\u0938\u0932\u092E\u093E \u092A\u093E\u0909\u0928 \u0938\u0915\u094D\u091B\u0928\u094D.",
  "pricing.viewShop": "\u092E\u0947\u0930\u094B \u092A\u0938\u0932\u092E\u093E \u0939\u0947\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.title": "\u092E\u0947\u0930\u094B \u092A\u0938\u0932",
  "home.gemBannerTitle": "GeM / ONDC \u0938\u0901\u0917 \u091C\u0921\u093E\u0928 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.gemBannerBadge": "\u091C\u0932\u094D\u0926\u0948 \u0906\u0909\u0901\u0926\u0948\u091B",
  "home.gemBannerMessage": "\u092F\u094B \u090F\u0915\u0940\u0915\u0930\u0923 \u091A\u093E\u0901\u0921\u0948 \u0906\u0909\u0901\u0926\u0948\u091B.",
  "home.loading": "\u0924\u092A\u093E\u0908\u0902\u0915\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u0932\u094B\u0921 \u0939\u0941\u0901\u0926\u0948\u091B\u0928\u094D...",
  "home.loadError": "\u0924\u092A\u093E\u0908\u0902\u0915\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u0932\u094B\u0921 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928",
  "home.retry": "\u092A\u0941\u0928: \u092A\u094D\u0930\u092F\u093E\u0938",
  "home.emptyTitle": "\u0905\u0939\u093F\u0932\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u091B\u0948\u0928",
  "home.emptyMessage": "KalaSetu \u092E\u093E \u092C\u0947\u091A\u094D\u0928 \u0938\u0941\u0930\u0941 \u0917\u0930\u094D\u0928 \u092A\u0939\u093F\u0932\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0925\u092A\u094D\u0928\u0941\u0939\u094B\u0938\u094D.",
  "home.addFirstProduct": "\u092A\u0939\u093F\u0932\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0925\u092A\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u0921\u094D\u0930\u093E\u092B\u094D\u091F",
  "home.statusFailed": "\u0905\u0938\u092B\u0932",
  "home.detailCategory": "\u0936\u094D\u0930\u0947\u0923\u0940",
  "home.detailEdit": "\u0938\u0902\u0938\u094B\u0927\u0928",
  "home.detailDelete": "\u092E\u0947\u091F\u093E\u0909\u0928\u0941",
  "home.detailClose": "\u092C\u0928\u094D\u0926 \u0917\u0930\u094D\u0928\u0941",
  "home.editPriceLabel": "\u092E\u0942\u0932\u094D\u092F",
  "home.editDescriptionLabel": "\u0935\u093F\u0935\u0930\u0923",
  "home.editSave": "\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924 \u0917\u0930\u094D\u0928\u0941",
  "home.editCancel": "\u0930\u0926\u094D\u0926 \u0917\u0930\u094D\u0928\u0941",
  "home.editPriceInvalid": "0 \u092D\u0928\u094D\u0926\u093E \u092C\u0922\u0940 \u092E\u0942\u0932\u094D\u092F \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.editDescriptionRequired": "\u0915\u0941\u0928\u0948 \u092A\u0928\u093F \u092D\u093E\u0937\u093E\u092E\u093E \u0935\u093F\u0935\u0930\u0923 \u0916\u093E\u0932\u0940 \u0939\u0941\u0928 \u0938\u0915\u094D\u0926\u0948\u0928",
  "home.editError": "\u0924\u092A\u093E\u0908\u0902\u0915\u093E \u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928\u0939\u0930\u0942 \u092C\u091A\u0924 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928: \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.deleteConfirm": "\u092F\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092E\u0947\u091F\u094D\u0928\u0941\u0939\u0941\u0928\u094D\u091B? \u092F\u094B \u0915\u093E\u0930\u094D\u092F\u0932\u093E\u0908 \u0909\u0932\u094D\u091F\u093E\u0909\u0928 \u0938\u0915\u093F\u0901\u0926\u0948\u0928\u0964",
  "home.deleteConfirmYes": "\u0939\u094B, \u092E\u0947\u091F\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "home.deleteError": "\u092F\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092E\u0947\u091F\u094D\u0928 \u0938\u0915\u093F\u090F\u0928, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928: \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "profile.emailLabel": "\u0907\u092E\u0947\u0932 \u0920\u0947\u0917\u093E\u0928\u093E",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u091B\u0948\u0928",
  "profile.loading": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u0939\u0941\u0901\u0926\u0948\u091B...",
  "profile.loadError": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0932\u094B\u0921 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928",
  "profile.displayNameLabel": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0928\u093E\u092E",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928\u0915\u094B \u0928\u093E\u092E",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u092C\u091A\u0924 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924 \u092D\u092F\u094B",
  "profile.saveError": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932 \u092C\u091A\u0924 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "profile.logout": "\u0932\u0917 \u0906\u0909\u091F \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "install.message": "\u091C\u0932\u094D\u0926\u0940 \u092A\u0939\u0941\u0901\u091A\u0915\u094B \u0932\u093E\u0917\u093F KalaSetu \u0938\u094D\u0925\u093E\u092A\u0928\u093E \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "install.action": "\u0938\u094D\u0925\u093E\u092A\u0928\u093E \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "install.dismiss": "\u0930\u0926\u094D\u0926 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "offline.message": "\u0924\u092A\u093E\u0908\u0902 \u0905\u092B\u0932\u093E\u0907\u0928 \u0939\u0941\u0928\u0941\u0939\u0941\u0928\u094D\u091B, \u0915\u0947\u0939\u0940 \u0938\u0941\u0935\u093F\u0927\u093E\u0939\u0930\u0942 \u0915\u093E\u092E \u0928\u0917\u0930\u094D\u0928 \u0938\u0915\u094D\u091B\u0928\u094D",
  "welcome.languageHint": "\u092A\u0942\u0930\u093E \u090F\u092A \u092F\u094B \u092D\u093E\u0937\u093E\u092E\u093E \u0939\u0941\u0928\u0947\u091B",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E\u0939\u0930\u0942",
  "describe.localTab": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0906\u092B\u094D\u0928\u0948 \u092D\u093E\u0937\u093E\u092E\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0935\u0930\u094D\u0923\u0928 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "describe.syncing": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0939\u0941\u0901\u0926\u0948\u091B...",
  "describe.syncFailed": "\u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E \u0905\u092A\u0921\u0947\u091F \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928\u0964 \u0906\u0935\u0936\u094D\u092F\u0915 \u092A\u0930\u0947\u092E\u093E \u0906\u092B\u0948\u0901 \u0938\u092E\u094D\u092A\u093E\u0926\u0928 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "describe.syncHint": "\u0938\u092E\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u0938\u094D\u0935\u0924\u0903 \u0905\u0928\u094D\u092F \u092D\u093E\u0937\u093E\u092E\u093E \u092A\u094D\u0930\u0924\u093F\u0932\u093F\u092A\u093F \u0917\u0930\u093F\u0928\u094D\u091B\u0964",
  "pricing.updating": "\u0928\u092F\u093E\u0901 \u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0932\u093E\u0917\u0924\u0915\u094B \u0932\u093E\u0917\u093F \u0905\u092A\u0921\u0947\u091F \u0917\u0930\u094D\u0926\u0948...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0915\u094D\u092F\u093E\u091F\u0932\u0917 \u0928\u093F\u0930\u094D\u092F\u093E\u0924 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D (ONDC \u0922\u093E\u0901\u091A\u093E)",
  "home.exportCatalogNote": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0938\u0942\u091A\u0940\u0939\u0930\u0942\u0932\u093E\u0908 ONDC \u0916\u0941\u0926\u094D\u0930\u093E \u0915\u094D\u092F\u093E\u091F\u0932\u0917 \u0938\u0902\u0930\u091A\u0928\u093E\u092E\u093E \u0928\u0915\u094D\u0938\u093E \u0917\u0930\u0940 \u0921\u093E\u0909\u0928\u0932\u094B\u0921 \u0917\u0930\u094D\u091B\u0964 \u090F\u0915\u0940\u0915\u0930\u0923 \u0924\u092F\u093E\u0930: \u0928\u0915\u094D\u0938\u093E \u092A\u0942\u0930\u093E \u092D\u090F\u0915\u094B \u091B, \u0928\u0947\u091F\u0935\u0930\u094D\u0915\u092E\u093E \u0932\u093E\u0907\u092D \u0939\u0941\u0928 \u0905\u091D\u0948 ONDC \u0926\u0930\u094D\u0924\u093E \u0906\u0935\u0936\u094D\u092F\u0915 \u091B\u0964",
  "home.exportOndcSingle": "\u092F\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0928\u093F\u0930\u094D\u092F\u093E\u0924 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D (ONDC \u0922\u093E\u0901\u091A\u093E)",
  "profile.relocalising": "\u0924\u092A\u093E\u0908\u0902\u0915\u093E \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u092F\u094B \u092D\u093E\u0937\u093E\u092E\u093E \u0905\u092A\u0921\u0947\u091F \u0939\u0941\u0901\u0926\u0948\u091B\u0928\u094D...",
  "profile.relocalised": "\u092F\u094B \u092D\u093E\u0937\u093E\u092E\u093E {n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u0905\u092A\u0921\u0947\u091F \u0917\u0930\u093F\u092F\u094B\u0964",
  "profile.relocaliseFailed": "\u0915\u0947\u0939\u0940 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u0905\u092A\u0921\u0947\u091F \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928\u0964 \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "marketplace.navBrowse": "\u092C\u094D\u0930\u093E\u0909\u091C",
  "marketplace.navProfile": "\u092A\u094D\u0930\u094B\u092B\u093E\u0907\u0932",
  "marketplace.browseTitle": "\u092C\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0916\u094B\u091C\u094D\u0928\u0941\u0939\u094B\u0938\u094D...",
  "marketplace.filtersTitle": "\u092B\u093F\u0932\u094D\u091F\u0930\u0939\u0930\u0942",
  "marketplace.filtersClear": "\u0938\u092C\u0948 \u0939\u091F\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "marketplace.filterAll": "\u0938\u092C\u0948",
  "marketplace.filterMaterial": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "marketplace.filterRegion": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.filterPrice": "\u092E\u0942\u0932\u094D\u092F \u0926\u093E\u092F\u0930\u093E (\u20B9)",
  "marketplace.filterPriceMin": "\u0928\u094D\u092F\u0942\u0928\u0924\u092E",
  "marketplace.filterPriceMax": "\u0905\u0927\u093F\u0915\u0924\u092E",
  "marketplace.sortLabel": "\u0915\u094D\u0930\u092E\u092C\u0926\u094D\u0927",
  "marketplace.sortNewest": "\u0928\u092F\u093E\u0901\u0924\u092E \u092A\u0939\u093F\u0932\u0947",
  "marketplace.sortPriceAsc": "\u092E\u0942\u0932\u094D\u092F: \u0915\u092E\u0926\u0947\u0916\u093F \u092C\u0922\u0940",
  "marketplace.sortPriceDesc": "\u092E\u0942\u0932\u094D\u092F: \u092C\u0922\u0940\u0926\u0947\u0916\u093F \u0915\u092E",
  "marketplace.resultCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u092D\u0947\u091F\u093F\u092F\u094B",
  "marketplace.loadMore": "\u0925\u092A \u0932\u094B\u0921",
  "marketplace.loadError": "\u092C\u091C\u093E\u0930 \u0932\u094B\u0921 \u0917\u0930\u094D\u0928 \u0938\u0915\u0947\u0928, \u0915\u0943\u092A\u092F\u093E \u092B\u0947\u0930\u093F \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D",
  "marketplace.emptyTitle": "\u092F\u0940 \u092B\u093F\u0932\u094D\u091F\u0930\u0938\u0901\u0917 \u092E\u093F\u0932\u094D\u0928\u0947 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 \u091B\u0948\u0928\u0928\u094D",
  "marketplace.emptyFiltered": "\u092B\u093F\u0932\u094D\u091F\u0930 \u0939\u091F\u093E\u090F\u0930 \u0935\u093E \u0905\u0930\u0942 \u0915\u0947\u0939\u093F \u0916\u094B\u091C\u0947\u0930 \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "marketplace.emptyNoProducts": "\u0905\u0939\u093F\u0932\u0947\u0938\u092E\u094D\u092E \u0915\u0941\u0928\u0948 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u092D\u090F\u0915\u094B \u091B\u0948\u0928\u0964 \u091A\u093E\u0901\u0921\u0948 \u092B\u0947\u0930\u0940 \u091C\u093E\u0901\u091A \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "marketplace.artisanUnnamed": "KalaSetu \u0915\u093E\u0930\u0940\u0917\u0930",
  "marketplace.backToBrowse": "\u092C\u091C\u093E\u0930\u092E\u093E \u092B\u0930\u094D\u0915\u0928\u0941\u0939\u094B\u0938\u094D",
  "marketplace.detailNotFoundTitle": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u092B\u0947\u0932\u093E \u092A\u0930\u0947\u0928",
  "marketplace.detailNotFoundMessage": "\u092F\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0939\u091F\u093E\u0907\u090F\u0915\u094B \u0939\u0941\u0928 \u0938\u0915\u094D\u091B \u0935\u093E \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u091B\u0948\u0928\u0964",
  "marketplace.artisanSummaryTitle": "\u0936\u093F\u0932\u094D\u092A\u0940\u0915\u094B \u092C\u093E\u0930\u0947\u092E\u093E",
  "marketplace.artisanProductCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0939\u0930\u0942 KalaSetu \u092E\u093E \u0938\u0942\u091A\u0940\u092C\u0926\u094D\u0927",
  "marketplace.inquiryTitle": "\u092F\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u092E\u093E \u091A\u093E\u0938\u094B \u091B?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0936\u093F\u0932\u094D\u092A\u0940\u0932\u093E\u0908 \u0924\u092A\u093E\u0908\u0902 \u0915\u0947 \u091A\u093E\u0939\u0928\u0941\u0939\u0941\u0928\u094D\u091B \u092D\u0928\u094D\u0928\u0941\u0939\u094B\u0938\u094D: \u092E\u093E\u0924\u094D\u0930\u093E, \u0905\u0928\u0941\u0915\u0942\u0932\u0928, \u0921\u0947\u0932\u093F\u092D\u0930\u0940 \u0938\u092E\u092F\u0938\u0940\u092E\u093E...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u091C\u093E\u0901\u091A \u092A\u0920\u093E\u0909\u0928\u0941\u0939\u094B\u0938\u094D",
  "marketplace.inquirySent": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u091C\u093E\u0901\u091A \u092A\u0920\u093E\u0907\u092F\u094B\u0964 \u0936\u093F\u0932\u094D\u092A\u0940 \u0924\u092A\u093E\u0908\u0902\u0932\u093E\u0908 \u0938\u092E\u094D\u092A\u0930\u094D\u0915 \u0917\u0930\u094D\u0928\u0947\u091B\u0964",
  "marketplace.inquiryError": "\u091C\u093E\u0901\u091A \u092A\u0920\u093E\u0909\u0928 \u0938\u0915\u0947\u0928, \u0915\u0943\u092A\u092F\u093E \u092B\u0947\u0930\u093F \u092A\u094D\u0930\u092F\u093E\u0938 \u0917\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "marketplace.regionLabel": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.regionUnspecified": "\u0928\u093F\u0930\u094D\u0926\u093F\u0937\u094D\u091F \u091B\u0948\u0928",
  "marketplace.myInquiriesTitle": "\u092E\u0947\u0930\u094B \u0938\u094B\u0927\u092A\u0941\u091B",
  "marketplace.inquiriesLoading": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0938\u094B\u0927\u092A\u0941\u091B \u0932\u094B\u0921 \u0939\u0941\u0901\u0926\u0948\u091B...",
  "marketplace.inquiriesLoadError": "\u0924\u092A\u093E\u0908\u0902\u0915\u094B \u0938\u094B\u0927\u092A\u0941\u091B \u0932\u094B\u0921 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u090F\u0928",
  "marketplace.noInquiries": "\u0924\u092A\u093E\u0908\u0902\u0932\u0947 \u0905\u0939\u093F\u0932\u0947\u0938\u092E\u094D\u092E \u0938\u094B\u0927\u092A\u0941\u091B \u092A\u0920\u093E\u0909\u0928\u0941\u092D\u090F\u0915\u094B \u091B\u0948\u0928\u0964 \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0916\u094B\u091C\u094D\u0928 \u092C\u091C\u093E\u0930 \u0939\u0947\u0930\u094D\u0928\u0941\u0939\u094B\u0938\u094D\u0964",
  "marketplace.inquiryProductRemoved": "\u092F\u094B \u0909\u0924\u094D\u092A\u093E\u0926\u0928 \u0905\u092C \u0909\u092A\u0932\u092C\u094D\u0927 \u091B\u0948\u0928",
  "marketplace.inquiryStatusOpen": "\u091C\u0935\u093E\u092B\u0915\u094B \u092A\u094D\u0930\u0924\u0940\u0915\u094D\u0937\u093E",
  "marketplace.inquiryStatusClosed": "\u092C\u0928\u094D\u0926",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/or.json
var or_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B39\u0B38\u0B4D\u0B24\u0B36\u0B3F\u0B33\u0B4D\u0B2A \u0B05\u0B28\u0B32\u0B3E\u0B07\u0B28\u0B4D \u0B2C\u0B3F\u0B15\u0B4D\u0B30\u0B3F, \u0B0F\u0B39\u0B3E \u0B39\u0B47\u0B09\u0B1B\u0B3F \u0B0F\u0B15 \u0B06\u0B38\u0B3E\u0B28 \u0B09\u0B2A\u0B3E\u0B5F\u0964",
  "welcome.languageLabel": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2D\u0B3E\u0B37\u0B3E \u0B1A\u0B5F\u0B28 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "welcome.getStarted": "\u0B06\u0B30\u0B2E\u0B4D\u0B2D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "language.en": "\u0B07\u0B02\u0B30\u0B3E\u0B1C\u0B40",
  "language.hi": "\u0B39\u0B3F\u0B28\u0B4D\u0B26\u0B40",
  "email.title": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B07\u0B2E\u0B47\u0B32 \u0B20\u0B3F\u0B15\u0B23\u0B3E \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "email.roleQuestion": "\u0B2E\u0B41\u0B01 \u0B0F\u0B20\u0B3E\u0B30\u0B47",
  "email.roleSell": "\u0B2E\u0B4B \u0B2A\u0B23\u0B4D\u0B5F \u0B2C\u0B3F\u0B15\u0B4D\u0B30\u0B3F \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "email.roleBuy": "\u0B39\u0B38\u0B4D\u0B24\u0B15\u0B33\u0B3E \u0B2A\u0B23\u0B4D\u0B5F \u0B15\u0B3F\u0B23\u0B28\u0B4D\u0B24\u0B41",
  "email.label": "\u0B07\u0B2E\u0B47\u0B32 \u0B20\u0B3F\u0B15\u0B23\u0B3E",
  "email.helper": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B1A\u0B3F\u0B39\u0B4D\u0B28\u0B1F\u0B3F \u0B28\u0B3F\u0B36\u0B4D\u0B1A\u0B3F\u0B24 \u0B2A\u0B3E\u0B07\u0B01 \u0B06\u0B2E\u0B47 4 \u0B21\u0B3F\u0B1C\u0B3F\u0B1F \u0B28\u0B2E\u0B4D\u0B2C\u0B30 \u0B2A\u0B20\u0B3E\u0B07\u0B2C\u0B41\u0964",
  "email.invalid": "\u0B0F\u0B15 \u0B2C\u0B48\u0B27 \u0B07\u0B2E\u0B47\u0B32 \u0B20\u0B3F\u0B15\u0B23\u0B3E \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "email.sendOtp": "\u0B15\u0B4B\u0B21 \u0B2A\u0B20\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "email.error": "\u0B15\u0B4B\u0B21 \u0B2A\u0B20\u0B3E\u0B07 \u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B41 \u0B28\u0B3E\u0B39\u0B3F\u0B01, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "otp.title": "\u0B07\u0B2E\u0B47\u0B32 \u0B2F\u0B3E\u0B1E\u0B4D\u0B1A",
  "otp.subtitle": "\u0B0F\u0B20\u0B3E\u0B30\u0B47 \u0B1A\u0B3E\u0B30\u0B3F \u0B21\u0B3F\u0B1C\u0B3F\u0B1F \u0B28\u0B2E\u0B4D\u0B2C\u0B30 \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "otp.emailUndelivered": "\u0B07\u0B2E\u0B47\u0B32 \u0B2A\u0B20\u0B3E\u0B07 \u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B41 \u0B28\u0B3E\u0B39\u0B3F\u0B01\u0964 \u0B21\u0B47\u0B2E\u0B4B \u0B15\u0B4B\u0B21 \u0B2A\u0B3E\u0B07\u0B01 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B1F\u0B3F\u0B2E \u0B20\u0B3E\u0B30\u0B41 \u0B05\u0B28\u0B41\u0B30\u0B4B\u0B27 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41\u0964",
  "otp.changeEmail": "\u0B07\u0B2E\u0B47\u0B32 \u0B2C\u0B26\u0B33\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "otp.verify": "\u0B2F\u0B3E\u0B1E\u0B4D\u0B1A",
  "otp.invalid": "\u0B38\u0B2E\u0B38\u0B4D\u0B24 4 \u0B21\u0B3F\u0B1C\u0B3F\u0B1F \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "otp.wrong": "\u0B05\u0B38\u0B20\u0B3F\u0B15 OTP, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "otp.resend": "OTP \u0B2A\u0B41\u0B23\u0B3F \u0B2A\u0B20\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "otp.resendIn": "OTP \u0B2A\u0B41\u0B23\u0B3F \u0B2A\u0B20\u0B3E\u0B28\u0B4D\u0B24\u0B41 {n}s \u0B30\u0B47",
  "otp.resendError": "OTP \u0B2A\u0B41\u0B23\u0B3F \u0B2A\u0B20\u0B3E\u0B07 \u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B41 \u0B28\u0B3E\u0B39\u0B3F\u0B01, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "camera.capture": "\u0B2B\u0B1F\u0B4B \u0B27\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "camera.unavailable": "\u0B15\u0B4D\u0B5F\u0B3E\u0B2E\u0B47\u0B30\u0B3E \u0B09\u0B2A\u0B32\u0B2C\u0B4D\u0B27 \u0B28\u0B41\u0B39\u0B47\u0B01, \u0B24\u0B47\u0B23\u0B41 \u0B2B\u0B1F\u0B4B \u0B1A\u0B5F\u0B28 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41\u0964",
  "camera.choosePhoto": "\u0B2B\u0B1F\u0B4B \u0B1A\u0B5F\u0B28 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "camera.retake": "\u0B2A\u0B41\u0B23\u0B3F \u0B28\u0B3F\u0B05",
  "camera.usePhoto": "\u0B0F\u0B39\u0B3F \u0B2B\u0B1F\u0B4B \u0B2C\u0B4D\u0B5F\u0B2C\u0B39\u0B3E\u0B30 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "camera.enhancing": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2B\u0B1F\u0B4B \u0B09\u0B28\u0B4D\u0B28\u0B24\u0B3F \u0B39\u0B47\u0B09\u0B1B\u0B3F...",
  "camera.enhanceError": "\u0B2B\u0B1F\u0B4B \u0B09\u0B28\u0B4D\u0B28\u0B24\u0B3F \u0B39\u0B47\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "camera.retry": "\u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E",
  "camera.before": "\u0B2E\u0B42\u0B33",
  "camera.after": "\u0B09\u0B28\u0B4D\u0B28\u0B24",
  "camera.compareHint": "\u0B24\u0B41\u0B33\u0B28\u0B3E \u0B2A\u0B3E\u0B07\u0B01 \u0B1F\u0B4D\u0B30\u0B3E\u0B17\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "camera.continue": "\u0B05\u0B17\u0B4D\u0B30\u0B17\u0B24\u0B3F",
  "studio.title": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2B\u0B1F\u0B4B\u0B15\u0B41 \u0B09\u0B28\u0B4D\u0B28\u0B24 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "studio.original": "\u0B2E\u0B42\u0B33",
  "studio.processed": "\u0B2A\u0B4D\u0B30\u0B15\u0B4D\u0B30\u0B3F\u0B5F\u0B3E\u0B15\u0B43\u0B24",
  "studio.removeBackground": "\u0B2A\u0B43\u0B37\u0B4D\u0B20\u0B2D\u0B42\u0B2E\u0B3F \u0B39\u0B1F\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "studio.removingBackground": "\u0B2A\u0B43\u0B37\u0B4D\u0B20\u0B2D\u0B42\u0B2E\u0B3F \u0B39\u0B1F\u0B3E\u0B09\u0B1B\u0B3F...",
  "studio.keepOriginalBackground": "\u0B2E\u0B42\u0B33 \u0B2A\u0B43\u0B37\u0B4D\u0B20\u0B2D\u0B42\u0B2E\u0B3F \u0B30\u0B16\u0B28\u0B4D\u0B24\u0B41",
  "studio.backgroundWhite": "\u0B27\u0B33\u0B3E",
  "studio.backgroundNeutral": "\u0B28\u0B30\u0B2E \u0B15\u0B4D\u0B30\u0B3F\u0B2E\u0B4D",
  "studio.backgroundBlur": "\u0B27\u0B41\u0B38\u0B30",
  "studio.backgroundUnavailableNotice": "\u0B2A\u0B43\u0B37\u0B4D\u0B20\u0B2D\u0B42\u0B2E\u0B3F \u0B39\u0B1F\u0B3E\u0B07\u0B2C\u0B3E \u0B2C\u0B30\u0B4D\u0B24\u0B4D\u0B24\u0B2E\u0B3E\u0B28 \u0B09\u0B2A\u0B32\u0B2C\u0B4D\u0B27 \u0B28\u0B41\u0B39\u0B47\u0B01\u0964 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2B\u0B1F\u0B4B \u0B2A\u0B30\u0B3F\u0B2C\u0B30\u0B4D\u0B24\u0B4D\u0B24\u0B3F\u0B24 \u0B39\u0B4B\u0B07\u0B28\u0B3E\u0B39\u0B3F\u0B01\u0964",
  "studio.backgroundTimedOutNotice": "\u0B2A\u0B43\u0B37\u0B4D\u0B20\u0B2D\u0B42\u0B2E\u0B3F \u0B39\u0B1F\u0B3E\u0B07\u0B2C\u0B3E \u0B2C\u0B39\u0B41\u0B24 \u0B38\u0B2E\u0B5F \u0B28\u0B47\u0B32\u0B3E, \u0B24\u0B47\u0B23\u0B41 \u0B0F\u0B39\u0B3E \u0B1B\u0B3E\u0B21\u0B3C\u0B3E \u0B39\u0B47\u0B32\u0B3E\u0964 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2B\u0B1F\u0B4B \u0B2A\u0B30\u0B3F\u0B2C\u0B30\u0B4D\u0B24\u0B4D\u0B24\u0B3F\u0B24 \u0B39\u0B4B\u0B07\u0B28\u0B3E\u0B39\u0B3F\u0B01\u0964",
  "studio.backgroundQuotaNotice": "\u0B2A\u0B43\u0B37\u0B4D\u0B20\u0B2D\u0B42\u0B2E\u0B3F \u0B39\u0B1F\u0B3E\u0B07\u0B2C\u0B3E \u0B15\u0B4B\u0B1F\u0B3E \u0B0F\u0B2C\u0B47 \u0B2A\u0B39\u0B1E\u0B4D\u0B1A\u0B3F\u0B17\u0B32\u0B3E\u0964 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2B\u0B1F\u0B4B \u0B2A\u0B30\u0B3F\u0B2C\u0B30\u0B4D\u0B24\u0B4D\u0B24\u0B3F\u0B24 \u0B39\u0B4B\u0B07\u0B28\u0B3E\u0B39\u0B3F\u0B01\u0964",
  "studio.backgroundFailedNotice": "\u0B2A\u0B43\u0B37\u0B4D\u0B20\u0B2D\u0B42\u0B2E\u0B3F \u0B39\u0B1F\u0B3E\u0B07\u0B2C\u0B3E \u0B2C\u0B3F\u0B2B\u0B33 \u0B39\u0B47\u0B32\u0B3E\u0964 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2B\u0B1F\u0B4B \u0B2A\u0B30\u0B3F\u0B2C\u0B30\u0B4D\u0B24\u0B4D\u0B24\u0B3F\u0B24 \u0B39\u0B4B\u0B07\u0B28\u0B3F\u0964",
  "studio.brightness": "\u0B06\u0B32\u0B4B\u0B15\u0B24\u0B3E",
  "studio.contrast": "\u0B2C\u0B3F\u0B2A\u0B30\u0B40\u0B24\u0B24\u0B3E",
  "studio.sharpen": "\u0B24\u0B3F\u0B15\u0B4D\u0B37\u0B4D\u0B23 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "studio.autoLighting": "\u0B38\u0B4D\u0B71\u0B5F\u0B02 \u0B06\u0B32\u0B4B\u0B15",
  "studio.crop": "\u0B15\u0B1F\u0B4D",
  "studio.cropOriginal": "\u0B2E\u0B42\u0B33",
  "studio.cropSquare": "\u0B1A\u0B24\u0B41\u0B30\u0B4D\u0B2D\u0B41\u0B1C",
  "studio.cropPortrait": "\u0B2A\u0B4B\u0B30\u0B4D\u0B1F\u0B4D\u0B30\u0B47\u0B1F\u0B4D",
  "studio.accept": "\u0B0F\u0B39\u0B3F \u0B2B\u0B1F\u0B4B \u0B2C\u0B4D\u0B5F\u0B2C\u0B39\u0B3E\u0B30 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "studio.retake": "\u0B2A\u0B41\u0B28\u0B03 \u0B28\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "studio.finalizing": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B38\u0B02\u0B2A\u0B3E\u0B26\u0B28\u0B3E \u0B32\u0B3E\u0B17\u0B41 \u0B15\u0B30\u0B41\u0B1B\u0B3F...",
  "studio.on": "\u0B1A\u0B3E\u0B32\u0B41",
  "studio.off": "\u0B2C\u0B28\u0B4D\u0B26",
  "category.title": "\u0B06\u0B2A\u0B23 \u0B15\u0B23 \u0B2C\u0B3F\u0B15\u0B4D\u0B30\u0B3F \u0B15\u0B30\u0B41\u0B1B\u0B28\u0B4D\u0B24\u0B3F?",
  "category.continue": "\u0B05\u0B17\u0B4D\u0B30\u0B17\u0B24\u0B3F",
  "category.materialQuestion": "\u0B0F\u0B39\u0B3E \u0B15'\u0B23 \u0B26\u0B4D\u0B71\u0B3E\u0B30\u0B3E \u0B24\u0B3F\u0B06\u0B30\u0B3F? (\u0B07\u0B1A\u0B4D\u0B1B\u0B3E\u0B2E\u0B24)",
  "category.textiles": "\u0B2C\u0B38\u0B4D\u0B24\u0B4D\u0B30",
  "category.pottery": "\u0B2E\u0B1F\u0B3F",
  "category.jewelry": "\u0B17\u0B39\u0B23\u0B3E",
  "category.woodwork": "\u0B15\u0B3E\u0B20",
  "category.bambooCane": "\u0B2C\u0B3E\u0B02\u0B36 \u0B13 \u0B17\u0B23\u0B4D\u0B21",
  "category.other": "\u0B05\u0B28\u0B4D\u0B5F",
  "voice.tapToRecord": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E \u0B30\u0B47\u0B15\u0B30\u0B4D\u0B21 \u0B1F\u0B3E\u0B2A\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "voice.recording": "\u0B30\u0B47\u0B15\u0B30\u0B4D\u0B21\u0B3F\u0B02 \u0B1A\u0B3E\u0B32\u0B3F\u0B1B\u0B3F...",
  "voice.stop": "\u0B30\u0B47\u0B15\u0B30\u0B4D\u0B21\u0B3F\u0B02 \u0B2C\u0B28\u0B4D\u0B26 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "voice.record": "\u0B30\u0B47\u0B15\u0B30\u0B4D\u0B21",
  "voice.reviewRecording": "\u0B2A\u0B41\u0B23\u0B3F \u0B36\u0B41\u0B23\u0B28\u0B4D\u0B24\u0B41, \u0B24\u0B3E\u0B2A\u0B30\u0B47 \u0B1C\u0B3E\u0B30\u0B3F \u0B30\u0B16\u0B28\u0B4D\u0B24\u0B41 \u0B05\u0B25\u0B2C\u0B3E \u0B2A\u0B41\u0B23\u0B3F \u0B30\u0B47\u0B15\u0B30\u0B4D\u0B21 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "voice.reRecord": "\u0B2A\u0B41\u0B23\u0B3F \u0B30\u0B47\u0B15\u0B30\u0B4D\u0B21",
  "voice.continue": "\u0B05\u0B17\u0B4D\u0B30\u0B17\u0B24\u0B3F",
  "describe.transcribing": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E \u0B2C\u0B41\u0B1D\u0B3F\u0B2C\u0B3E \u0B1A\u0B3E\u0B32\u0B3F\u0B1B\u0B3F...",
  "describe.transcribeError": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E \u0B2C\u0B41\u0B1D\u0B3F \u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B41 \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "describe.retry": "\u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E",
  "describe.reviewHint": "\u0B06\u0B2C\u0B36\u0B4D\u0B5F\u0B15 \u0B39\u0B47\u0B32\u0B47 \u0B30\u0B3F\u0B2D\u0B4D\u0B5F\u0B41 \u0B13 \u0B0F\u0B21\u0B3F\u0B1F\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "describe.fallbackNote": "\u0B2E\u0B3E\u0B07\u0B15\u0B4D\u0B30\u0B4B\u0B2B\u0B4B\u0B28 \u0B09\u0B2A\u0B32\u0B2C\u0B4D\u0B27 \u0B28\u0B41\u0B39\u0B47\u0B01, \u0B24\u0B47\u0B23\u0B41 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E \u0B1F\u0B3E\u0B07\u0B2A\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41\u0964",
  "describe.placeholderEn": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B07\u0B02\u0B30\u0B3E\u0B1C\u0B40\u0B30\u0B47 \u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "describe.continue": "\u0B05\u0B17\u0B4D\u0B30\u0B17\u0B24\u0B3F",
  "pricing.title": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B28\u0B3F\u0B30\u0B4D\u0B26\u0B4D\u0B27\u0B3E\u0B30\u0B23",
  "pricing.summaryEdit": "\u0B38\u0B02\u0B36\u0B4B\u0B27\u0B28",
  "pricing.materialCostLabel": "\u0B38\u0B3E\u0B2E\u0B17\u0B4D\u0B30\u0B40 \u0B16\u0B30\u0B4D\u0B1A\u0B4D\u0B1A",
  "pricing.materialCostHelper": "\u0B15\u0B1A\u0B4D\u0B1A\u0B3E \u0B2E\u0B3E\u0B32 \u0B09\u0B2A\u0B30\u0B47 \u0B16\u0B30\u0B4D\u0B1A\u0B4D\u0B1A \u0B30\u0B41\u0B2A\u0B3F\u0B30\u0B47 \u0B32\u0B47\u0B16\u0B28\u0B4D\u0B24\u0B41\u0964",
  "pricing.materialCostInvalid": "0 \u0B20\u0B3E\u0B30\u0B41 \u0B05\u0B27\u0B3F\u0B15 \u0B2E\u0B3E\u0B32 \u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "pricing.getSuggestion": "\u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B2A\u0B4D\u0B30\u0B38\u0B4D\u0B24\u0B3E\u0B2C \u0B28\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "pricing.suggestError": "\u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B2A\u0B4D\u0B30\u0B38\u0B4D\u0B24\u0B3E\u0B2C \u0B2E\u0B3F\u0B33\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "pricing.retry": "\u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "pricing.rangeLabel": "\u0B2A\u0B4D\u0B30\u0B38\u0B4D\u0B24\u0B3E\u0B2C\u0B3F\u0B24 \u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B30\u0B47\u0B1E\u0B4D\u0B1C",
  "pricing.sellingPriceLabel": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2C\u0B3F\u0B15\u0B4D\u0B30\u0B5F \u0B2E\u0B42\u0B32\u0B4D\u0B5F",
  "pricing.sellingPriceNote": "\u0B0F\u0B39\u0B3E \u0B0F\u0B15 \u0B2A\u0B4D\u0B30\u0B38\u0B4D\u0B24\u0B3E\u0B2C, \u0B06\u0B2A\u0B23 \u0B07\u0B1A\u0B4D\u0B1B\u0B3E\u0B2E\u0B24 \u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B30\u0B16\u0B3F\u0B2A\u0B3E\u0B30\u0B3F\u0B2C\u0B47\u0964",
  "pricing.sellingPriceInvalid": "0 \u0B20\u0B3E\u0B30\u0B41 \u0B05\u0B27\u0B3F\u0B15 \u0B2C\u0B3F\u0B15\u0B4D\u0B30\u0B5F \u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "pricing.publish": "\u0B2A\u0B4D\u0B30\u0B15\u0B3E\u0B36\u0B3F\u0B24 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "pricing.publishError": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2A\u0B4D\u0B30\u0B15\u0B3E\u0B36\u0B3F\u0B24 \u0B39\u0B47\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "pricing.successTitle": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B32\u0B3E\u0B07\u0B2D\u0B4D \u0B39\u0B47\u0B32\u0B3E!",
  "pricing.successMessage": "\u0B15\u0B4D\u0B30\u0B47\u0B24\u0B3E\u0B2E\u0B3E\u0B28\u0B47 \u0B0F\u0B2C\u0B47 \u0B0F\u0B39\u0B3E\u0B15\u0B41 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B26\u0B4B\u0B15\u0B3E\u0B28\u0B30\u0B47 \u0B16\u0B4B\u0B1C\u0B3F\u0B2A\u0B3E\u0B30\u0B3F\u0B2C\u0B47\u0964",
  "pricing.viewShop": "\u0B2E\u0B4B \u0B26\u0B4B\u0B15\u0B3E\u0B28\u0B30\u0B47 \u0B26\u0B47\u0B16\u0B28\u0B4D\u0B24\u0B41",
  "home.title": "\u0B2E\u0B4B \u0B26\u0B4B\u0B15\u0B3E\u0B28",
  "home.gemBannerTitle": "GeM / ONDC \u0B2F\u0B4B\u0B17 \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "home.gemBannerBadge": "\u0B36\u0B40\u0B18\u0B4D\u0B30 \u0B06\u0B38\u0B41\u0B1B\u0B3F",
  "home.gemBannerMessage": "\u0B0F\u0B39\u0B3F \u0B0F\u0B15\u0B24\u0B3E \u0B36\u0B40\u0B18\u0B4D\u0B30 \u0B06\u0B38\u0B41\u0B1B\u0B3F\u0964",
  "home.loading": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B32\u0B4B\u0B21\u0B3C \u0B39\u0B47\u0B09\u0B1B\u0B3F...",
  "home.loadError": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B32\u0B4B\u0B21\u0B3C \u0B39\u0B4B\u0B07\u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "home.retry": "\u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "home.emptyTitle": "\u0B0F\u0B2F\u0B3E\u0B01 \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "home.emptyMessage": "KalaSetu \u0B30\u0B47 \u0B2C\u0B3F\u0B15\u0B4D\u0B30\u0B3F \u0B06\u0B30\u0B2E\u0B4D\u0B2D \u0B15\u0B30\u0B3F\u0B2C\u0B3E \u0B2A\u0B3E\u0B07\u0B01 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B25\u0B2E \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B2F\u0B4B\u0B17 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41\u0964",
  "home.addFirstProduct": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B25\u0B2E \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B2F\u0B4B\u0B17 \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "home.statusPublished": "\u0B2A\u0B4D\u0B30\u0B15\u0B3E\u0B36\u0B3F\u0B24",
  "home.statusDraft": "\u0B16\u0B38\u0B21\u0B3C\u0B3E",
  "home.statusFailed": "\u0B05\u0B38\u0B2B\u0B33",
  "home.detailCategory": "\u0B36\u0B4D\u0B30\u0B47\u0B23\u0B40",
  "home.detailEdit": "\u0B38\u0B02\u0B2A\u0B3E\u0B26\u0B28",
  "home.detailDelete": "\u0B39\u0B1F\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "home.detailClose": "\u0B2C\u0B28\u0B4D\u0B26",
  "home.editPriceLabel": "\u0B2E\u0B42\u0B32\u0B4D\u0B5F",
  "home.editDescriptionLabel": "\u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E",
  "home.editSave": "\u0B2A\u0B30\u0B3F\u0B2C\u0B30\u0B4D\u0B24\u0B4D\u0B24\u0B28 \u0B38\u0B02\u0B30\u0B15\u0B4D\u0B37\u0B23",
  "home.editCancel": "\u0B2C\u0B3E\u0B24\u0B3F\u0B32\u0B4D",
  "home.editPriceInvalid": "0 \u0B20\u0B3E\u0B30\u0B41 \u0B05\u0B27\u0B3F\u0B15 \u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B26\u0B3F\u0B05\u0B28\u0B4D\u0B24\u0B41",
  "home.editDescriptionRequired": "\u0B2F\u0B47\u0B15\u0B4C\u0B23\u0B38\u0B3F \u0B2D\u0B3E\u0B37\u0B3E\u0B30\u0B47 \u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E \u0B16\u0B3E\u0B32\u0B3F \u0B30\u0B39\u0B3F\u0B2A\u0B3E\u0B30\u0B3F\u0B2C \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "home.editError": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2A\u0B30\u0B3F\u0B2C\u0B30\u0B4D\u0B24\u0B4D\u0B24\u0B28 \u0B38\u0B1E\u0B4D\u0B1A\u0B5F \u0B39\u0B4B\u0B07\u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "home.deleteConfirm": "\u0B0F\u0B39\u0B3F \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B39\u0B1F\u0B3E\u0B07\u0B2C\u0B47? \u0B0F\u0B39\u0B3E \u0B2B\u0B47\u0B30\u0B3E\u0B07 \u0B28 \u0B39\u0B4B\u0B07\u0B2A\u0B3E\u0B30\u0B3F\u0B2C\u0964",
  "home.deleteConfirmYes": "\u0B39\u0B01, \u0B39\u0B1F\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "home.deleteError": "\u0B0F\u0B39\u0B3F \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B39\u0B1F\u0B3E\u0B07 \u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "profile.title": "\u0B2A\u0B4D\u0B30\u0B4B\u0B2B\u0B3E\u0B07\u0B32",
  "profile.emailLabel": "\u0B07\u0B2E\u0B47\u0B32 \u0B20\u0B3F\u0B15\u0B23\u0B3E",
  "profile.emailUnknown": "\u0B09\u0B2A\u0B32\u0B2C\u0B4D\u0B27 \u0B28\u0B41\u0B39\u0B47\u0B01",
  "profile.loading": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2A\u0B4D\u0B30\u0B4B\u0B2B\u0B3E\u0B07\u0B32 \u0B32\u0B4B\u0B21 \u0B39\u0B47\u0B09\u0B1B\u0B3F...",
  "profile.loadError": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2A\u0B4D\u0B30\u0B4B\u0B2B\u0B3E\u0B07\u0B32 \u0B32\u0B4B\u0B21 \u0B39\u0B4B\u0B07\u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "profile.displayNameLabel": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B28\u0B3E\u0B2E",
  "profile.shopNameLabel": "\u0B26\u0B4B\u0B15\u0B3E\u0B28 \u0B28\u0B3E\u0B2E",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u0B2A\u0B4D\u0B30\u0B4B\u0B2B\u0B3E\u0B07\u0B32 \u0B38\u0B1E\u0B4D\u0B1A\u0B5F \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "profile.saved": "\u0B2A\u0B4D\u0B30\u0B4B\u0B2B\u0B3E\u0B07\u0B32 \u0B30\u0B15\u0B4D\u0B37\u0B3F\u0B24 \u0B39\u0B47\u0B32\u0B3E",
  "profile.saveError": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B4B\u0B2B\u0B3E\u0B07\u0B32 \u0B30\u0B15\u0B4D\u0B37\u0B3F\u0B24 \u0B39\u0B47\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "profile.logout": "\u0B32\u0B17 \u0B06\u0B09\u0B1F\u0B4D",
  "install.message": "\u0B24\u0B4D\u0B71\u0B30\u0B3F\u0B24 \u0B06\u0B15\u0B4D\u0B38\u0B47\u0B38 \u0B2A\u0B3E\u0B07\u0B01 KalaSetu \u0B07\u0B28\u0B37\u0B4D\u0B1F\u0B32\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "install.action": "\u0B07\u0B28\u0B37\u0B4D\u0B1F\u0B32\u0B4D",
  "install.dismiss": "\u0B05\u0B17\u0B4D\u0B30\u0B39\u0B23",
  "offline.message": "\u0B06\u0B2A\u0B23 \u0B05\u0B2B\u0B32\u0B3E\u0B07\u0B28 \u0B05\u0B1B\u0B28\u0B4D\u0B24\u0B3F, \u0B15\u0B3F\u0B1B\u0B3F \u0B2C\u0B3F\u0B36\u0B47\u0B37\u0B24\u0B3E \u0B1A\u0B3E\u0B32\u0B3F \u0B28\u0B2A\u0B3E\u0B30\u0B47",
  "welcome.languageHint": "\u0B38\u0B2E\u0B17\u0B4D\u0B30 \u0B06\u0B2A\u0B4D \u0B0F\u0B39\u0B3F \u0B2D\u0B3E\u0B37\u0B3E\u0B30\u0B47 \u0B39\u0B47\u0B2C",
  "welcome.regionalLanguages": "\u0B2D\u0B3E\u0B30\u0B24\u0B40\u0B5F \u0B2D\u0B3E\u0B37\u0B3E\u0B17\u0B41\u0B21\u0B3C\u0B3F\u0B15",
  "describe.localTab": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2D\u0B3E\u0B37\u0B3E",
  "describe.placeholderLocal": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2D\u0B3E\u0B37\u0B3E\u0B30\u0B47 \u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2C\u0B30\u0B4D\u0B23\u0B4D\u0B23\u0B28\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "describe.syncing": "\u0B05\u0B28\u0B4D\u0B5F \u0B2D\u0B3E\u0B37\u0B3E \u0B05\u0B26\u0B4D\u0B5F\u0B24\u0B28 \u0B39\u0B47\u0B09\u0B1B\u0B3F...",
  "describe.syncFailed": "\u0B05\u0B28\u0B4D\u0B5F \u0B2D\u0B3E\u0B37\u0B3E \u0B05\u0B26\u0B4D\u0B5F\u0B24\u0B28 \u0B39\u0B47\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01\u0964 \u0B06\u0B2C\u0B36\u0B4D\u0B5F\u0B15 \u0B39\u0B47\u0B32\u0B47 \u0B28\u0B3F\u0B1C\u0B47 \u0B0F\u0B21\u0B3F\u0B1F\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41\u0964",
  "describe.syncHint": "\u0B38\u0B02\u0B36\u0B4B\u0B27\u0B28\u0B17\u0B41\u0B21\u0B3C\u0B3F\u0B15 \u0B05\u0B28\u0B4D\u0B5F \u0B2D\u0B3E\u0B37\u0B3E\u0B15\u0B41 \u0B06\u0B2A\u0B47 \u0B06\u0B2A\u0B47 \u0B28\u0B15\u0B32 \u0B39\u0B47\u0B09\u0B1B\u0B3F\u0964",
  "pricing.updating": "\u0B28\u0B42\u0B24\u0B28 \u0B09\u0B2A\u0B3E\u0B26\u0B3E\u0B28 \u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B2A\u0B3E\u0B07\u0B01 \u0B05\u0B26\u0B4D\u0B5F\u0B24\u0B28 \u0B39\u0B47\u0B09\u0B1B\u0B3F...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26\u0B17\u0B41\u0B21\u0B3C\u0B3F\u0B15 \u0B0F\u0B39\u0B3F \u0B2D\u0B3E\u0B37\u0B3E\u0B30\u0B47 \u0B05\u0B26\u0B4D\u0B5F\u0B24\u0B28 \u0B39\u0B47\u0B09\u0B1B\u0B3F...",
  "profile.relocalised": "{n} \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B0F\u0B39\u0B3F \u0B2D\u0B3E\u0B37\u0B3E\u0B30\u0B47 \u0B05\u0B26\u0B4D\u0B5F\u0B24\u0B28 \u0B39\u0B4B\u0B07\u0B1B\u0B3F\u0964",
  "profile.relocaliseFailed": "\u0B15\u0B3F\u0B1B\u0B3F \u0B09\u0B24\u0B4D\u0B2A\u0B3E\u0B26 \u0B05\u0B26\u0B4D\u0B5F\u0B24\u0B28 \u0B39\u0B4B\u0B07\u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01\u0964 \u0B2A\u0B30\u0B47 \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41\u0964",
  "marketplace.navBrowse": "\u0B2C\u0B4D\u0B30\u0B3E\u0B09\u0B1C\u0B4D",
  "marketplace.navProfile": "\u0B2A\u0B4D\u0B30\u0B4B\u0B2B\u0B3E\u0B07\u0B32\u0B4D",
  "marketplace.browseTitle": "\u0B2C\u0B1C\u0B3E\u0B30",
  "marketplace.searchPlaceholder": "\u0B2A\u0B23\u0B4D\u0B5F \u0B16\u0B4B\u0B1C\u0B28\u0B4D\u0B24\u0B41...",
  "marketplace.filtersTitle": "\u0B1B\u0B3E\u0B23\u0B3F",
  "marketplace.filtersClear": "\u0B38\u0B2C\u0B41 \u0B39\u0B1F\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "marketplace.filterAll": "\u0B38\u0B2E\u0B38\u0B4D\u0B24",
  "marketplace.filterMaterial": "\u0B38\u0B3E\u0B2E\u0B17\u0B4D\u0B30\u0B40",
  "marketplace.filterRegion": "\u0B05\u0B1E\u0B4D\u0B1A\u0B33",
  "marketplace.filterPrice": "\u0B2E\u0B42\u0B32\u0B4D\u0B5F \u0B38\u0B40\u0B2E\u0B3E (\u20B9)",
  "marketplace.filterPriceMin": "\u0B28\u0B4D\u0B5F\u0B41\u0B28\u0B24\u0B2E",
  "marketplace.filterPriceMax": "\u0B38\u0B30\u0B4D\u0B2C\u0B3E\u0B27\u0B3F\u0B15",
  "marketplace.sortLabel": "\u0B38\u0B1C\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "marketplace.sortNewest": "\u0B28\u0B42\u0B24\u0B28\u0B24\u0B2E \u0B2A\u0B4D\u0B30\u0B25\u0B2E",
  "marketplace.sortPriceAsc": "\u0B2E\u0B42\u0B32\u0B4D\u0B5F: \u0B28\u0B3F\u0B2E\u0B4D\u0B28\u0B30\u0B41 \u0B09\u0B1A\u0B4D\u0B1A",
  "marketplace.sortPriceDesc": "\u0B2E\u0B42\u0B32\u0B4D\u0B5F: \u0B09\u0B1A\u0B4D\u0B1A\u0B30\u0B41 \u0B28\u0B3F\u0B2E\u0B4D\u0B28",
  "marketplace.resultCount": "{n} \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2E\u0B3F\u0B33\u0B3F\u0B32\u0B3E",
  "marketplace.loadMore": "\u0B05\u0B27\u0B3F\u0B15 \u0B26\u0B47\u0B16\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "marketplace.loadError": "\u0B2E\u0B3E\u0B30\u0B4D\u0B15\u0B47\u0B1F\u0B2A\u0B4D\u0B32\u0B47\u0B38\u0B4D \u0B32\u0B4B\u0B21\u0B4D \u0B39\u0B4B\u0B07\u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B28\u0B03\u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "marketplace.emptyTitle": "\u0B0F\u0B39\u0B3F \u0B2B\u0B3F\u0B32\u0B4D\u0B1F\u0B30\u0B4D\u200C\u0B17\u0B41\u0B21\u0B3F\u0B15 \u0B38\u0B39\u0B3F\u0B24 \u0B15\u0B4C\u0B23\u0B38\u0B3F \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2E\u0B47\u0B33 \u0B39\u0B47\u0B09\u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "marketplace.emptyFiltered": "\u0B0F\u0B15 \u0B2B\u0B3F\u0B32\u0B4D\u0B1F\u0B30\u0B4D \u0B15\u0B4D\u0B32\u0B3F\u0B5F\u0B3E\u0B30\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41 \u0B15\u0B3F\u0B2E\u0B4D\u0B2C\u0B3E \u0B05\u0B28\u0B4D\u0B5F \u0B15\u0B3F\u0B1B\u0B3F \u0B16\u0B4B\u0B1C\u0B28\u0B4D\u0B24\u0B41\u0964",
  "marketplace.emptyNoProducts": "\u0B0F\u0B2A\u0B30\u0B4D\u0B2F\u0B4D\u0B5F\u0B28\u0B4D\u0B24 \u0B15\u0B4C\u0B23\u0B38\u0B3F \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2A\u0B4D\u0B30\u0B15\u0B3E\u0B36\u0B3F\u0B24 \u0B39\u0B4B\u0B07\u0B28\u0B3E\u0B39\u0B3F\u0B01\u0964 \u0B36\u0B3F\u0B18\u0B4D\u0B30 \u0B2B\u0B47\u0B30\u0B3F \u0B1A\u0B47\u0B15\u0B4D \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41\u0964",
  "marketplace.artisanUnnamed": "KalaSetu \u0B15\u0B3E\u0B30\u0B3F\u0B17\u0B30",
  "marketplace.backToBrowse": "\u0B2C\u0B1C\u0B3E\u0B30\u0B15\u0B41 \u0B2B\u0B47\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "marketplace.detailNotFoundTitle": "\u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2E\u0B3F\u0B33\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "marketplace.detailNotFoundMessage": "\u0B0F\u0B39\u0B3F \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B2C\u0B3F\u0B32\u0B4B\u0B2A\u0B3F\u0B24 \u0B39\u0B4B\u0B07\u0B25\u0B3E\u0B07\u0B2A\u0B3E\u0B30\u0B47 \u0B15\u0B3F\u0B2E\u0B4D\u0B2C\u0B3E \u0B0F\u0B2C\u0B47 \u0B09\u0B2A\u0B32\u0B2C\u0B4D\u0B27 \u0B28\u0B41\u0B39\u0B47\u0B01\u0964",
  "marketplace.artisanSummaryTitle": "\u0B15\u0B3E\u0B30\u0B3F\u0B17\u0B30 \u0B2C\u0B3F\u0B37\u0B5F\u0B30\u0B47",
  "marketplace.artisanProductCount": "{n} \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B15\u0B3E\u0B32\u0B3E\u0B38\u0B47\u0B1F\u0B41\u0B30\u0B47 \u0B24\u0B3E\u0B32\u0B3F\u0B15\u0B3E\u0B2D\u0B41\u0B15\u0B4D\u0B24",
  "marketplace.inquiryTitle": "\u0B0F\u0B39\u0B3F \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F\u0B30\u0B47 \u0B06\u0B17\u0B4D\u0B30\u0B39 \u0B05\u0B1B\u0B3F \u0B15\u0B3F?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0B15\u0B3E\u0B30\u0B3F\u0B17\u0B30\u0B19\u0B4D\u0B15\u0B41 \u0B06\u0B2A\u0B23 \u0B1A\u0B3E\u0B39\u0B41\u0B01\u0B25\u0B3F\u0B2C\u0B3E \u0B2C\u0B3F\u0B37\u0B5F \u0B15\u0B41\u0B39\u0B28\u0B4D\u0B24\u0B41: \u0B2A\u0B30\u0B3F\u0B2E\u0B3E\u0B23, \u0B15\u0B37\u0B4D\u0B1F\u0B2E\u0B3E\u0B07\u0B1C\u0B47\u0B38\u0B28\u0B4D, \u0B2C\u0B3F\u0B24\u0B30\u0B23 \u0B38\u0B2E\u0B5F...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0B2A\u0B4D\u0B30\u0B36\u0B4D\u0B28 \u0B2A\u0B20\u0B3E\u0B28\u0B4D\u0B24\u0B41",
  "marketplace.inquirySent": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15\u0B30 \u0B2A\u0B4D\u0B30\u0B36\u0B4D\u0B28 \u0B2A\u0B20\u0B3E\u0B2F\u0B3E\u0B07\u0B1B\u0B3F\u0964 \u0B15\u0B3E\u0B30\u0B3F\u0B17\u0B30 \u0B36\u0B40\u0B18\u0B4D\u0B30 \u0B2F\u0B4B\u0B17\u0B3E\u0B2F\u0B4B\u0B17 \u0B15\u0B30\u0B3F\u0B2C\u0B47\u0964",
  "marketplace.inquiryError": "\u0B2A\u0B4D\u0B30\u0B36\u0B4D\u0B28 \u0B2A\u0B20\u0B3E\u0B07 \u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01, \u0B26\u0B5F\u0B3E\u0B15\u0B30\u0B3F \u0B2A\u0B41\u0B23\u0B3F \u0B1A\u0B47\u0B37\u0B4D\u0B1F\u0B3E \u0B15\u0B30\u0B28\u0B4D\u0B24\u0B41",
  "marketplace.regionLabel": "\u0B05\u0B1E\u0B4D\u0B1A\u0B33",
  "marketplace.regionUnspecified": "\u0B05\u0B28\u0B3F\u0B30\u0B4D\u0B26\u0B4D\u0B26\u0B3F\u0B37\u0B4D\u0B1F",
  "marketplace.myInquiriesTitle": "\u0B2E\u0B4B\u0B30 \u0B2A\u0B4D\u0B30\u0B36\u0B4D\u0B28",
  "marketplace.inquiriesLoading": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B36\u0B4D\u0B28 \u0B32\u0B4B\u0B21\u0B4D \u0B39\u0B47\u0B09\u0B1B\u0B3F...",
  "marketplace.inquiriesLoadError": "\u0B06\u0B2A\u0B23\u0B19\u0B4D\u0B15 \u0B2A\u0B4D\u0B30\u0B36\u0B4D\u0B28 \u0B32\u0B4B\u0B21\u0B4D \u0B39\u0B4B\u0B07\u0B2A\u0B3E\u0B30\u0B3F\u0B32\u0B3E \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "marketplace.noInquiries": "\u0B06\u0B2A\u0B23 \u0B0F\u0B2A\u0B30\u0B4D\u0B2F\u0B4D\u0B5F\u0B28\u0B4D\u0B24 \u0B2A\u0B4D\u0B30\u0B36\u0B4D\u0B28 \u0B2A\u0B20\u0B3E\u0B07\u0B28\u0B3E\u0B39\u0B3E\u0B28\u0B4D\u0B24\u0B3F\u0964 \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B16\u0B4B\u0B1C\u0B3F\u0B2C\u0B3E \u0B2A\u0B3E\u0B07\u0B01 \u0B2C\u0B1C\u0B3E\u0B30 \u0B26\u0B47\u0B16\u0B28\u0B4D\u0B24\u0B41\u0964",
  "marketplace.inquiryProductRemoved": "\u0B0F\u0B39\u0B3F \u0B2A\u0B4D\u0B30\u0B4B\u0B21\u0B15\u0B4D\u0B1F \u0B06\u0B09 \u0B09\u0B2A\u0B32\u0B2C\u0B4D\u0B27 \u0B28\u0B3E\u0B39\u0B3F\u0B01",
  "marketplace.inquiryStatusOpen": "\u0B09\u0B24\u0B4D\u0B24\u0B30 \u0B05\u0B2A\u0B47\u0B15\u0B4D\u0B37\u0B3E\u0B30\u0B24",
  "marketplace.inquiryStatusClosed": "\u0B2C\u0B28\u0B4D\u0B26",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/pa.json
var pa_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0A06\u0A2A\u0A23\u0A3E \u0A39\u0A38\u0A24\u0A15\u0A32\u0A3E \u0A06\u0A28\u0A32\u0A3E\u0A08\u0A28 \u0A06\u0A38\u0A3E\u0A28\u0A40 \u0A28\u0A3E\u0A32 \u0A35\u0A47\u0A1A\u0A4B\u0964",
  "welcome.languageLabel": "\u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A1A\u0A41\u0A23\u0A4B",
  "welcome.getStarted": "\u0A38\u0A3C\u0A41\u0A30\u0A42 \u0A15\u0A30\u0A4B",
  "language.en": "\u0A05\u0A70\u0A17\u0A30\u0A47\u0A1C\u0A3C\u0A40",
  "language.hi": "\u0A39\u0A3F\u0A70\u0A26\u0A40",
  "email.title": "\u0A06\u0A2A\u0A23\u0A3E \u0A08\u0A2E\u0A47\u0A32 \u0A10\u0A21\u0A30\u0A48\u0A71\u0A38 \u0A26\u0A3E\u0A16\u0A32 \u0A15\u0A30\u0A4B",
  "email.roleQuestion": "\u0A2E\u0A48\u0A02 \u0A07\u0A71\u0A25\u0A47 \u0A39\u0A3E\u0A02",
  "email.roleSell": "\u0A2E\u0A47\u0A30\u0A47 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A35\u0A47\u0A1A\u0A4B",
  "email.roleBuy": "\u0A39\u0A71\u0A25\u0A4B\u0A02 \u0A2C\u0A23\u0A47 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A16\u0A30\u0A40\u0A26\u0A4B",
  "email.label": "\u0A08\u0A2E\u0A47\u0A32 \u0A10\u0A21\u0A30\u0A48\u0A71\u0A38",
  "email.helper": "\u0A05\u0A38\u0A40\u0A02 \u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A2A\u0A41\u0A38\u0A3C\u0A1F\u0A40 \u0A32\u0A08 4 \u0A05\u0A70\u0A15\u0A3E\u0A02 \u0A26\u0A3E \u0A15\u0A4B\u0A21 \u0A2D\u0A47\u0A1C\u0A3E\u0A02\u0A17\u0A47\u0964",
  "email.invalid": "\u0A35\u0A48\u0A27 \u0A08\u0A2E\u0A47\u0A32 \u0A10\u0A21\u0A30\u0A48\u0A71\u0A38 \u0A26\u0A3E\u0A16\u0A32 \u0A15\u0A30\u0A4B",
  "email.sendOtp": "\u0A15\u0A4B\u0A21 \u0A2D\u0A47\u0A1C\u0A4B",
  "email.error": "\u0A15\u0A4B\u0A21 \u0A28\u0A39\u0A40\u0A02 \u0A2D\u0A47\u0A1C\u0A3F\u0A06 \u0A1C\u0A3E \u0A38\u0A15\u0A3F\u0A06, \u0A15\u0A3F\u0A30\u0A2A\u0A3E \u0A15\u0A30\u0A15\u0A47 \u0A26\u0A41\u0A2C\u0A3E\u0A30\u0A3E \u0A15\u0A4B\u0A38\u0A3C\u0A3F\u0A38\u0A3C \u0A15\u0A30\u0A4B",
  "otp.title": "\u0A06\u0A2A\u0A23\u0A3E \u0A08\u0A2E\u0A47\u0A32 \u0A24\u0A38\u0A26\u0A40\u0A15 \u0A15\u0A30\u0A4B",
  "otp.subtitle": "\u0A2D\u0A47\u0A1C\u0A47 \u0A17\u0A0F 4-\u0A05\u0A70\u0A15 \u0A15\u0A4B\u0A21 \u0A28\u0A42\u0A70 \u0A26\u0A30\u0A1C \u0A15\u0A30\u0A4B",
  "otp.emailUndelivered": "\u0A05\u0A38\u0A40\u0A02 \u0A08\u0A2E\u0A47\u0A32 \u0A28\u0A39\u0A40\u0A02 \u0A2D\u0A47\u0A1C \u0A38\u0A15\u0A47\u0964 \u0A21\u0A48\u0A2E\u0A4B \u0A15\u0A4B\u0A21 \u0A32\u0A08 \u0A06\u0A2A\u0A23\u0A40 \u0A1F\u0A40\u0A2E \u0A28\u0A3E\u0A32 \u0A38\u0A70\u0A2A\u0A30\u0A15 \u0A15\u0A30\u0A4B\u0964",
  "otp.changeEmail": "\u0A08\u0A2E\u0A47\u0A32 \u0A2C\u0A26\u0A32\u0A4B",
  "otp.verify": "\u0A24\u0A38\u0A26\u0A40\u0A15 \u0A15\u0A30\u0A4B",
  "otp.invalid": "\u0A38\u0A3E\u0A30\u0A47 4 \u0A05\u0A70\u0A15 \u0A26\u0A30\u0A1C \u0A15\u0A30\u0A4B",
  "otp.wrong": "\u0A17\u0A32\u0A24 OTP, \u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "otp.resend": "OTP \u0A2E\u0A41\u0A5C \u0A2D\u0A47\u0A1C\u0A4B",
  "otp.resendIn": "OTP {n}s \u0A35\u0A3F\u0A71\u0A1A \u0A2E\u0A41\u0A5C \u0A2D\u0A47\u0A1C\u0A4B",
  "otp.resendError": "OTP \u0A2E\u0A41\u0A5C \u0A28\u0A39\u0A40\u0A02 \u0A2D\u0A47\u0A1C \u0A38\u0A15\u0A47, \u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "camera.capture": "\u0A2B\u0A4B\u0A1F\u0A4B \u0A32\u0A13",
  "camera.unavailable": "\u0A15\u0A48\u0A2E\u0A30\u0A3E \u0A09\u0A2A\u0A32\u0A2C\u0A27 \u0A28\u0A39\u0A40\u0A02, \u0A2C\u0A26\u0A32\u0A47 \u0A35\u0A3F\u0A71\u0A1A \u0A2B\u0A4B\u0A1F\u0A4B \u0A1A\u0A41\u0A23\u0A4B\u0964",
  "camera.choosePhoto": "\u0A2B\u0A4B\u0A1F\u0A4B \u0A1A\u0A41\u0A23\u0A4B",
  "camera.retake": "\u0A2B\u0A4B\u0A1F\u0A4B \u0A2E\u0A41\u0A5C \u0A32\u0A13",
  "camera.usePhoto": "\u0A07\u0A39 \u0A2B\u0A4B\u0A1F\u0A4B \u0A35\u0A30\u0A24\u0A4B",
  "camera.enhancing": "\u0A2B\u0A4B\u0A1F\u0A4B \u0A28\u0A42\u0A70 \u0A38\u0A41\u0A27\u0A3E\u0A30\u0A3F\u0A06 \u0A1C\u0A3E \u0A30\u0A3F\u0A39\u0A3E \u0A39\u0A48...",
  "camera.enhanceError": "\u0A2B\u0A4B\u0A1F\u0A4B \u0A28\u0A42\u0A70 \u0A38\u0A41\u0A27\u0A3E\u0A30\u0A3F\u0A06 \u0A28\u0A39\u0A40\u0A02 \u0A1C\u0A3E \u0A38\u0A15\u0A3F\u0A06",
  "camera.retry": "\u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "camera.before": "\u0A2E\u0A42\u0A32",
  "camera.after": "\u0A38\u0A41\u0A27\u0A3E\u0A30\u0A3F\u0A06",
  "camera.compareHint": "\u0A24\u0A41\u0A32\u0A28\u0A3E \u0A32\u0A08 \u0A38\u0A32\u0A3E\u0A08\u0A21\u0A30 \u0A16\u0A3F\u0A71\u0A1A\u0A4B",
  "camera.continue": "\u0A1C\u0A3E\u0A30\u0A40 \u0A30\u0A71\u0A16\u0A4B",
  "studio.title": "\u0A2B\u0A4B\u0A1F\u0A4B \u0A28\u0A42\u0A70 \u0A38\u0A41\u0A27\u0A3E\u0A30\u0A4B",
  "studio.original": "\u0A2E\u0A42\u0A32",
  "studio.processed": "\u0A2A\u0A4D\u0A30\u0A4B\u0A38\u0A48\u0A38 \u0A15\u0A40\u0A24\u0A3E",
  "studio.removeBackground": "\u0A2A\u0A3F\u0A1B\u0A4B\u0A15\u0A5C \u0A39\u0A1F\u0A3E\u0A13",
  "studio.removingBackground": "\u0A2A\u0A3F\u0A1B\u0A4B\u0A15\u0A5C \u0A39\u0A1F\u0A3E \u0A30\u0A39\u0A47 \u0A39\u0A3E\u0A02...",
  "studio.keepOriginalBackground": "\u0A2E\u0A42\u0A32 \u0A2A\u0A3F\u0A1B\u0A4B\u0A15\u0A5C \u0A30\u0A71\u0A16\u0A4B",
  "studio.backgroundWhite": "\u0A38\u0A2B\u0A3C\u0A48\u0A26",
  "studio.backgroundNeutral": "\u0A28\u0A30\u0A2E \u0A15\u0A4D\u0A30\u0A40\u0A2E",
  "studio.backgroundBlur": "\u0A27\u0A41\u0A70\u0A26\u0A32\u0A3E",
  "studio.backgroundUnavailableNotice": "\u0A2A\u0A3F\u0A1B\u0A4B\u0A15\u0A5C \u0A39\u0A1F\u0A3E\u0A09\u0A23\u0A3E \u0A07\u0A38 \u0A35\u0A47\u0A32\u0A47 \u0A09\u0A2A\u0A32\u0A2C\u0A27 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A48\u0964 \u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A2B\u0A4B\u0A1F\u0A4B \u0A05\u0A23\u0A2C\u0A26\u0A32\u0A40 \u0A30\u0A39\u0A40 \u0A39\u0A48\u0964",
  "studio.backgroundTimedOutNotice": "\u0A2A\u0A3F\u0A1B\u0A4B\u0A15\u0A5C \u0A39\u0A1F\u0A3E\u0A09\u0A23 \u0A35\u0A3F\u0A71\u0A1A \u0A2C\u0A39\u0A41\u0A24 \u0A38\u0A2E\u0A3E\u0A02 \u0A32\u0A71\u0A17 \u0A17\u0A3F\u0A06 \u0A05\u0A24\u0A47 \u0A07\u0A38\u0A28\u0A42\u0A70 \u0A1B\u0A71\u0A21 \u0A26\u0A3F\u0A71\u0A24\u0A3E \u0A17\u0A3F\u0A06\u0964 \u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A2B\u0A4B\u0A1F\u0A4B \u0A05\u0A23\u0A2C\u0A26\u0A32\u0A40 \u0A30\u0A39\u0A40 \u0A39\u0A48\u0964",
  "studio.backgroundQuotaNotice": "\u0A2A\u0A3F\u0A1B\u0A4B\u0A15\u0A5C \u0A39\u0A1F\u0A3E\u0A09\u0A23 \u0A26\u0A40 \u0A15\u0A4B\u0A1F\u0A3E \u0A39\u0A41\u0A23 \u0A32\u0A08 \u0A2A\u0A42\u0A30\u0A40 \u0A39\u0A4B \u0A17\u0A08 \u0A39\u0A48\u0964 \u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A2B\u0A4B\u0A1F\u0A4B \u0A05\u0A23\u0A2C\u0A26\u0A32\u0A40 \u0A30\u0A39\u0A40 \u0A39\u0A48\u0964",
  "studio.backgroundFailedNotice": "\u0A2A\u0A3F\u0A1B\u0A4B\u0A15\u0A5C \u0A39\u0A1F\u0A3E\u0A09\u0A23\u0A3E \u0A2B\u0A47\u0A32\u0A4D\u0A39 \u0A39\u0A4B \u0A17\u0A3F\u0A06\u0964 \u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A2B\u0A4B\u0A1F\u0A4B \u0A05\u0A23\u0A2C\u0A26\u0A32\u0A40 \u0A30\u0A39\u0A40 \u0A39\u0A48\u0964",
  "studio.brightness": "\u0A1A\u0A2E\u0A15",
  "studio.contrast": "\u0A15\u0A3E\u0A02\u0A1F\u0A4D\u0A30\u0A3E\u0A38\u0A1F",
  "studio.sharpen": "\u0A27\u0A3E\u0A30\u0A26\u0A3E\u0A30",
  "studio.autoLighting": "\u0A06\u0A1F\u0A4B \u0A32\u0A3E\u0A08\u0A1F\u0A3F\u0A70\u0A17",
  "studio.crop": "\u0A15\u0A71\u0A1F\u0A4B",
  "studio.cropOriginal": "\u0A2E\u0A42\u0A32",
  "studio.cropSquare": "\u0A1A\u0A4C\u0A30\u0A38",
  "studio.cropPortrait": "\u0A2A\u0A4B\u0A30\u0A1F\u0A30\u0A47\u0A1F",
  "studio.accept": "\u0A07\u0A39 \u0A2B\u0A4B\u0A1F\u0A4B \u0A35\u0A30\u0A24\u0A4B",
  "studio.retake": "\u0A2B\u0A3F\u0A30 \u0A32\u0A13",
  "studio.finalizing": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A47 \u0A38\u0A70\u0A2A\u0A3E\u0A26\u0A28 \u0A32\u0A3E\u0A17\u0A42 \u0A39\u0A4B \u0A30\u0A39\u0A47 \u0A39\u0A28...",
  "studio.on": "\u0A1A\u0A3E\u0A32\u0A42",
  "studio.off": "\u0A2C\u0A70\u0A26",
  "category.title": "\u0A24\u0A41\u0A38\u0A40\u0A02 \u0A15\u0A40 \u0A35\u0A47\u0A1A \u0A30\u0A39\u0A47 \u0A39\u0A4B?",
  "category.continue": "\u0A1C\u0A3E\u0A30\u0A40 \u0A30\u0A71\u0A16\u0A4B",
  "category.materialQuestion": "\u0A07\u0A39 \u0A15\u0A3F\u0A38 \u0A38\u0A2E\u0A71\u0A17\u0A30\u0A40 \u0A24\u0A4B\u0A02 \u0A2C\u0A23\u0A3F\u0A06 \u0A39\u0A48? (\u0A35\u0A3F\u0A15\u0A32\u0A2A\u0A3F\u0A15)",
  "category.textiles": "\u0A15\u0A2A\u0A5C\u0A47",
  "category.pottery": "\u0A2E\u0A3F\u0A71\u0A1F\u0A40 \u0A26\u0A47 \u0A2C\u0A30\u0A24\u0A28",
  "category.jewelry": "\u0A17\u0A39\u0A3F\u0A23\u0A47",
  "category.woodwork": "\u0A32\u0A71\u0A15\u0A5C\u0A40 \u0A15\u0A3E\u0A30\u0A40\u0A17\u0A30\u0A40",
  "category.bambooCane": "\u0A2C\u0A3E\u0A02\u0A38 \u0A05\u0A24\u0A47 \u0A15\u0A48\u0A28",
  "category.other": "\u0A39\u0A4B\u0A30",
  "voice.tapToRecord": "\u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A26\u0A40 \u0A35\u0A30\u0A23\u0A28\u0A3E \u0A30\u0A3F\u0A15\u0A3E\u0A30\u0A21 \u0A15\u0A30\u0A28 \u0A32\u0A08 \u0A1F\u0A48\u0A2A \u0A15\u0A30\u0A4B",
  "voice.recording": "\u0A30\u0A3F\u0A15\u0A3E\u0A30\u0A21\u0A3F\u0A70\u0A17...",
  "voice.stop": "\u0A30\u0A3F\u0A15\u0A3E\u0A30\u0A21\u0A3F\u0A70\u0A17 \u0A2C\u0A70\u0A26 \u0A15\u0A30\u0A4B",
  "voice.record": "\u0A30\u0A3F\u0A15\u0A3E\u0A30\u0A21",
  "voice.reviewRecording": "\u0A38\u0A41\u0A23\u0A4B, \u0A2B\u0A3F\u0A30 \u0A1C\u0A3E\u0A30\u0A40 \u0A30\u0A71\u0A16\u0A4B \u0A1C\u0A3E\u0A02 \u0A26\u0A41\u0A2C\u0A3E\u0A30\u0A3E \u0A30\u0A3F\u0A15\u0A3E\u0A30\u0A21 \u0A15\u0A30\u0A4B\u0964",
  "voice.reRecord": "\u0A2B\u0A3F\u0A30 \u0A30\u0A3F\u0A15\u0A3E\u0A30\u0A21 \u0A15\u0A30\u0A4B",
  "voice.continue": "\u0A1C\u0A3E\u0A30\u0A40 \u0A30\u0A71\u0A16\u0A4B",
  "describe.transcribing": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A35\u0A30\u0A23\u0A28\u0A3E \u0A38\u0A2E\u0A1D \u0A30\u0A39\u0A40 \u0A39\u0A48...",
  "describe.transcribeError": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A35\u0A30\u0A23\u0A28\u0A3E \u0A38\u0A2E\u0A1D \u0A28\u0A39\u0A40\u0A02 \u0A06\u0A08",
  "describe.retry": "\u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "describe.reviewHint": "\u0A32\u0A4B\u0A5C \u0A2A\u0A48\u0A23 \u2019\u0A24\u0A47 \u0A38\u0A2E\u0A40\u0A16\u0A3F\u0A06 \u0A05\u0A24\u0A47 \u0A38\u0A4B\u0A27\u0A4B",
  "describe.fallbackNote": "\u0A2E\u0A3E\u0A08\u0A15\u0A30\u0A4B\u0A2B\u0A4B\u0A28 \u0A09\u0A2A\u0A32\u0A2C\u0A27 \u0A28\u0A39\u0A40\u0A02, \u0A06\u0A2A\u0A23\u0A40 \u0A35\u0A30\u0A23\u0A28\u0A3E \u0A1F\u0A3E\u0A08\u0A2A \u0A15\u0A30\u0A4B\u0964",
  "describe.placeholderEn": "\u0A06\u0A2A\u0A23\u0A47 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A28\u0A42\u0A70 \u0A05\u0A70\u0A17\u0A30\u0A47\u0A1C\u0A3C\u0A40 \u0A35\u0A3F\u0A71\u0A1A \u0A35\u0A30\u0A23\u0A28 \u0A15\u0A30\u0A4B",
  "describe.continue": "\u0A1C\u0A3E\u0A30\u0A40 \u0A30\u0A71\u0A16\u0A4B",
  "pricing.title": "\u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A26\u0A40 \u0A15\u0A40\u0A2E\u0A24 \u0A26\u0A3F\u0A13",
  "pricing.summaryEdit": "\u0A38\u0A4B\u0A27\u0A4B",
  "pricing.materialCostLabel": "\u0A38\u0A2E\u0A71\u0A17\u0A30\u0A40 \u0A26\u0A40 \u0A32\u0A3E\u0A17\u0A24",
  "pricing.materialCostHelper": "\u0A30\u0A41\u0A2A\u0A0F \u0A35\u0A3F\u0A71\u0A1A \u0A15\u0A71\u0A1A\u0A47 \u0A2E\u0A3E\u0A32 '\u0A24\u0A47 \u0A16\u0A30\u0A1A\u0A40 \u0A30\u0A15\u0A2E \u0A26\u0A30\u0A1C \u0A15\u0A30\u0A4B\u0964",
  "pricing.materialCostInvalid": "0 \u0A24\u0A4B\u0A02 \u0A35\u0A71\u0A27 \u0A2E\u0A3E\u0A32 \u0A26\u0A40 \u0A32\u0A3E\u0A17\u0A24 \u0A26\u0A30\u0A1C \u0A15\u0A30\u0A4B\u0964",
  "pricing.getSuggestion": "\u0A15\u0A40\u0A2E\u0A24 \u0A26\u0A40 \u0A38\u0A32\u0A3E\u0A39 \u0A32\u0A35\u0A4B",
  "pricing.suggestError": "\u0A15\u0A40\u0A2E\u0A24 \u0A26\u0A40 \u0A38\u0A32\u0A3E\u0A39 \u0A28\u0A39\u0A40\u0A02 \u0A2E\u0A3F\u0A32\u0A40",
  "pricing.retry": "\u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "pricing.rangeLabel": "\u0A38\u0A41\u0A1D\u0A3E\u0A08 \u0A15\u0A40\u0A2E\u0A24 \u0A26\u0A40 \u0A30\u0A47\u0A02\u0A1C",
  "pricing.sellingPriceLabel": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A35\u0A3F\u0A15\u0A30\u0A40 \u0A15\u0A40\u0A2E\u0A24",
  "pricing.sellingPriceNote": "\u0A07\u0A39 \u0A38\u0A32\u0A3E\u0A39 \u0A39\u0A48, \u0A24\u0A41\u0A38\u0A40\u0A02 \u0A06\u0A2A\u0A23\u0A40 \u0A2E\u0A28\u0A2A\u0A38\u0A70\u0A26 \u0A15\u0A40\u0A2E\u0A24 \u0A30\u0A71\u0A16 \u0A38\u0A15\u0A26\u0A47 \u0A39\u0A4B\u0964",
  "pricing.sellingPriceInvalid": "0 \u0A24\u0A4B\u0A02 \u0A35\u0A71\u0A27 \u0A35\u0A3F\u0A15\u0A30\u0A40 \u0A15\u0A40\u0A2E\u0A24 \u0A26\u0A30\u0A1C \u0A15\u0A30\u0A4B\u0964",
  "pricing.publish": "\u0A2A\u0A4B\u0A38\u0A1F \u0A15\u0A30\u0A4B",
  "pricing.publishError": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A3E \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A2A\u0A4B\u0A38\u0A1F \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A3F\u0A06\u0964",
  "pricing.successTitle": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A3E \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A39\u0A41\u0A23 \u0A32\u0A3E\u0A08\u0A35 \u0A39\u0A48!",
  "pricing.successMessage": "\u0A16\u0A30\u0A40\u0A26\u0A26\u0A3E\u0A30 \u0A39\u0A41\u0A23 \u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A26\u0A41\u0A15\u0A3E\u0A28 \u0A35\u0A3F\u0A71\u0A1A \u0A07\u0A38 \u0A28\u0A42\u0A70 \u0A32\u0A71\u0A2D \u0A38\u0A15\u0A26\u0A47 \u0A39\u0A28\u0964",
  "pricing.viewShop": "\u0A2E\u0A47\u0A30\u0A40 \u0A26\u0A41\u0A15\u0A3E\u0A28 \u0A35\u0A3F\u0A71\u0A1A \u0A35\u0A47\u0A16\u0A4B",
  "home.title": "\u0A2E\u0A47\u0A30\u0A40 \u0A26\u0A41\u0A15\u0A3E\u0A28",
  "home.gemBannerTitle": "GeM / ONDC \u0A28\u0A3E\u0A32 \u0A1C\u0A41\u0A5C\u0A4B",
  "home.gemBannerBadge": "\u0A1C\u0A32\u0A26\u0A40 \u0A06 \u0A30\u0A3F\u0A39\u0A3E \u0A39\u0A48",
  "home.gemBannerMessage": "\u0A07\u0A39 \u0A07\u0A70\u0A1F\u0A40\u0A17\u0A4D\u0A30\u0A47\u0A36\u0A28 \u0A1C\u0A32\u0A26\u0A40 \u0A06 \u0A30\u0A39\u0A40 \u0A39\u0A48\u0964",
  "home.loading": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A47 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A32\u0A4B\u0A21 \u0A39\u0A4B \u0A30\u0A39\u0A47 \u0A39\u0A28...",
  "home.loadError": "\u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A32\u0A4B\u0A21 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A47",
  "home.retry": "\u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "home.emptyTitle": "\u0A39\u0A3E\u0A32\u0A47 \u0A15\u0A4B\u0A08 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A28\u0A39\u0A40\u0A02",
  "home.emptyMessage": "KalaSetu '\u0A24\u0A47 \u0A35\u0A47\u0A1A\u0A23\u0A3E \u0A38\u0A3C\u0A41\u0A30\u0A42 \u0A15\u0A30\u0A28 \u0A32\u0A08 \u0A06\u0A2A\u0A23\u0A3E \u0A2A\u0A39\u0A3F\u0A32\u0A3E \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A1C\u0A4B\u0A5C\u0A4B\u0964",
  "home.addFirstProduct": "\u0A06\u0A2A\u0A23\u0A3E \u0A2A\u0A39\u0A3F\u0A32\u0A3E \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A1C\u0A4B\u0A5C\u0A4B",
  "home.statusPublished": "\u0A2A\u0A2C\u0A32\u0A3F\u0A38\u0A3C \u0A15\u0A40\u0A24\u0A3E",
  "home.statusDraft": "\u0A21\u0A30\u0A3E\u0A2B\u0A1F",
  "home.statusFailed": "\u0A05\u0A38\u0A2B\u0A32",
  "home.detailCategory": "\u0A38\u0A3C\u0A4D\u0A30\u0A47\u0A23\u0A40",
  "home.detailEdit": "\u0A38\u0A4B\u0A27\u0A4B",
  "home.detailDelete": "\u0A2E\u0A3F\u0A1F\u0A3E\u0A13",
  "home.detailClose": "\u0A2C\u0A70\u0A26 \u0A15\u0A30\u0A4B",
  "home.editPriceLabel": "\u0A15\u0A40\u0A2E\u0A24",
  "home.editDescriptionLabel": "\u0A35\u0A47\u0A30\u0A35\u0A3E",
  "home.editSave": "\u0A2C\u0A26\u0A32\u0A3E\u0A05 \u0A38\u0A70\u0A2D\u0A3E\u0A32\u0A4B",
  "home.editCancel": "\u0A30\u0A71\u0A26 \u0A15\u0A30\u0A4B",
  "home.editPriceInvalid": "0 \u0A24\u0A4B\u0A02 \u0A35\u0A71\u0A27 \u0A15\u0A40\u0A2E\u0A24 \u0A26\u0A30\u0A1C \u0A15\u0A30\u0A4B",
  "home.editDescriptionRequired": "\u0A35\u0A47\u0A30\u0A35\u0A3E \u0A15\u0A3F\u0A38\u0A47 \u0A35\u0A40 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A35\u0A3F\u0A71\u0A1A \u0A16\u0A3E\u0A32\u0A40 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A26\u0A3E",
  "home.editError": "\u0A2C\u0A26\u0A32\u0A3E\u0A05 \u0A38\u0A70\u0A2D\u0A3E\u0A32\u0A47 \u0A28\u0A39\u0A40\u0A02 \u0A17\u0A0F, \u0A15\u0A3F\u0A30\u0A2A\u0A3E \u0A15\u0A30\u0A15\u0A47 \u0A26\u0A41\u0A2C\u0A3E\u0A30\u0A3E \u0A15\u0A4B\u0A38\u0A3C\u0A3F\u0A38\u0A3C \u0A15\u0A30\u0A4B",
  "home.deleteConfirm": "\u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A2E\u0A3F\u0A1F\u0A3E\u0A09\u0A23\u0A3E? \u0A07\u0A39 \u0A35\u0A3E\u0A2A\u0A38 \u0A28\u0A39\u0A40\u0A02 \u0A15\u0A40\u0A24\u0A3E \u0A1C\u0A3E \u0A38\u0A15\u0A26\u0A3E\u0964",
  "home.deleteConfirmYes": "\u0A39\u0A3E\u0A02, \u0A2E\u0A3F\u0A1F\u0A3E\u0A13",
  "home.deleteError": "\u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A2E\u0A3F\u0A1F\u0A3E\u0A07\u0A06 \u0A28\u0A39\u0A40\u0A02 \u0A1C\u0A3E \u0A38\u0A15\u0A3F\u0A06, \u0A15\u0A3F\u0A30\u0A2A\u0A3E \u0A15\u0A30\u0A15\u0A47 \u0A26\u0A41\u0A2C\u0A3E\u0A30\u0A3E \u0A15\u0A4B\u0A38\u0A3C\u0A3F\u0A38\u0A3C \u0A15\u0A30\u0A4B",
  "profile.title": "\u0A2A\u0A4D\u0A30\u0A4B\u0A2B\u0A3E\u0A08\u0A32",
  "profile.emailLabel": "\u0A08\u0A2E\u0A47\u0A32 \u0A2A\u0A24\u0A3E",
  "profile.emailUnknown": "\u0A09\u0A2A\u0A32\u0A2C\u0A27 \u0A28\u0A39\u0A40\u0A02",
  "profile.loading": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A3E \u0A2A\u0A4D\u0A30\u0A4B\u0A2B\u0A3E\u0A08\u0A32 \u0A32\u0A4B\u0A21 \u0A39\u0A4B \u0A30\u0A3F\u0A39\u0A3E \u0A39\u0A48...",
  "profile.loadError": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A3E \u0A2A\u0A4D\u0A30\u0A4B\u0A2B\u0A3E\u0A08\u0A32 \u0A32\u0A4B\u0A21 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A3F\u0A06",
  "profile.displayNameLabel": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A3E \u0A28\u0A3E\u0A2E",
  "profile.shopNameLabel": "\u0A26\u0A41\u0A15\u0A3E\u0A28 \u0A26\u0A3E \u0A28\u0A3E\u0A2E",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u0A2A\u0A4D\u0A30\u0A4B\u0A2B\u0A3E\u0A08\u0A32 \u0A38\u0A70\u0A2D\u0A3E\u0A32\u0A4B",
  "profile.saved": "\u0A2A\u0A4D\u0A30\u0A4B\u0A2B\u0A3E\u0A08\u0A32 \u0A38\u0A70\u0A2D\u0A3E\u0A32\u0A3F\u0A06",
  "profile.saveError": "\u0A2A\u0A4D\u0A30\u0A4B\u0A2B\u0A3E\u0A08\u0A32 \u0A38\u0A70\u0A2D\u0A3E\u0A32\u0A3F\u0A06 \u0A28\u0A39\u0A40\u0A02, \u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "profile.logout": "\u0A32\u0A3E\u0A17 \u0A06\u0A09\u0A1F",
  "install.message": "\u0A24\u0A47\u0A1C\u0A3C \u0A2A\u0A39\u0A41\u0A70\u0A1A \u0A32\u0A08 KalaSetu \u0A07\u0A70\u0A38\u0A1F\u0A3E\u0A32 \u0A15\u0A30\u0A4B",
  "install.action": "\u0A07\u0A70\u0A38\u0A1F\u0A3E\u0A32",
  "install.dismiss": "\u0A2C\u0A70\u0A26 \u0A15\u0A30\u0A4B",
  "offline.message": "\u0A24\u0A41\u0A38\u0A40\u0A02 \u0A06\u0A2B\u0A32\u0A3E\u0A08\u0A28 \u0A39\u0A4B, \u0A15\u0A41\u0A1D \u0A2B\u0A40\u0A1A\u0A30 \u0A15\u0A70\u0A2E \u0A28\u0A39\u0A40\u0A02 \u0A15\u0A30 \u0A38\u0A15\u0A26\u0A47",
  "welcome.languageHint": "\u0A38\u0A3E\u0A30\u0A3E \u0A10\u0A2A \u0A07\u0A38 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A35\u0A3F\u0A71\u0A1A \u0A39\u0A4B\u0A35\u0A47\u0A17\u0A3E\u0964",
  "welcome.regionalLanguages": "\u0A2D\u0A3E\u0A30\u0A24\u0A40 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E\u0A35\u0A3E\u0A02",
  "describe.localTab": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E",
  "describe.placeholderLocal": "\u0A06\u0A2A\u0A23\u0A40 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A35\u0A3F\u0A71\u0A1A \u0A06\u0A2A\u0A23\u0A47 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A26\u0A3E \u0A35\u0A30\u0A23\u0A28 \u0A15\u0A30\u0A4B",
  "describe.syncing": "\u0A26\u0A42\u0A1C\u0A40 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A05\u0A2A\u0A21\u0A47\u0A1F \u0A39\u0A4B \u0A30\u0A39\u0A40 \u0A39\u0A48...",
  "describe.syncFailed": "\u0A26\u0A42\u0A1C\u0A40 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A05\u0A2A\u0A21\u0A47\u0A1F \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A40\u0964 \u0A32\u0A4B\u0A5C \u0A39\u0A4B\u0A35\u0A47 \u0A24\u0A3E\u0A02 \u0A06\u0A2A \u0A39\u0A40 \u0A38\u0A4B\u0A27\u0A4B\u0964",
  "describe.syncHint": "\u0A38\u0A4B\u0A27\u0A3E\u0A02 \u0A26\u0A42\u0A1C\u0A40 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A35\u0A3F\u0A71\u0A1A \u0A06\u0A2A\u0A47 \u0A39\u0A40 \u0A15\u0A3E\u0A2A\u0A40 \u0A39\u0A4B \u0A1C\u0A3E\u0A02\u0A26\u0A40\u0A06\u0A02 \u0A39\u0A28\u0964",
  "pricing.updating": "\u0A28\u0A35\u0A40\u0A02 \u0A38\u0A2E\u0A71\u0A17\u0A30\u0A40 \u0A26\u0A40 \u0A32\u0A3E\u0A17\u0A24 \u0A32\u0A08 \u0A05\u0A2A\u0A21\u0A47\u0A1F \u0A15\u0A40\u0A24\u0A3E \u0A1C\u0A3E \u0A30\u0A3F\u0A39\u0A3E \u0A39\u0A48...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0A15\u0A48\u0A1F\u0A3E\u0A32\u0A3E\u0A17 \u0A28\u0A3F\u0A30\u0A2F\u0A3E\u0A24 (ONDC \u0A2B\u0A3E\u0A30\u0A2E\u0A48\u0A1F)",
  "home.exportCatalogNote": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40\u0A06\u0A02 \u0A2A\u0A4D\u0A30\u0A15\u0A3E\u0A38\u0A3C\u0A3F\u0A24 \u0A32\u0A3F\u0A38\u0A1F\u0A3F\u0A70\u0A17\u0A3E\u0A02 \u0A28\u0A42\u0A70 ONDC \u0A30\u0A40\u0A1F\u0A47\u0A32 \u0A15\u0A48\u0A1F\u0A3E\u0A32\u0A3E\u0A17 \u0A22\u0A3E\u0A02\u0A1A\u0A47 \u0A28\u0A3E\u0A32 \u0A2E\u0A3F\u0A32\u0A3E \u0A15\u0A47 \u0A21\u0A3E\u0A0A\u0A28\u0A32\u0A4B\u0A21 \u0A15\u0A30\u0A26\u0A3E \u0A39\u0A48\u0964 \u0A07\u0A70\u0A1F\u0A40\u0A17\u0A4D\u0A30\u0A47\u0A36\u0A28 \u0A24\u0A3F\u0A06\u0A30: \u0A2E\u0A48\u0A2A\u0A3F\u0A70\u0A17 \u0A39\u0A4B \u0A1A\u0A41\u0A71\u0A15\u0A40 \u0A39\u0A48, \u0A28\u0A48\u0A71\u0A1F\u0A35\u0A30\u0A15 \u2018\u0A24\u0A47 \u0A32\u0A3E\u0A08\u0A35 \u0A1C\u0A3E\u0A23 \u0A32\u0A08 ONDC \u0A30\u0A1C\u0A3F\u0A38\u0A1F\u0A4D\u0A30\u0A47\u0A36\u0A28 \u0A32\u0A3E\u0A1C\u0A3C\u0A2E\u0A40 \u0A39\u0A48\u0964",
  "home.exportOndcSingle": "\u0A07\u0A38 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A28\u0A42\u0A70 \u0A28\u0A3F\u0A30\u0A2F\u0A3E\u0A24 \u0A15\u0A30\u0A4B (ONDC \u0A2B\u0A3E\u0A30\u0A2E\u0A48\u0A1F)",
  "profile.relocalising": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A47 \u0A09\u0A24\u0A2A\u0A3E\u0A26\u0A3E\u0A02 \u0A28\u0A42\u0A70 \u0A07\u0A38 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A35\u0A3F\u0A71\u0A1A \u0A05\u0A2A\u0A21\u0A47\u0A1F \u0A15\u0A40\u0A24\u0A3E \u0A1C\u0A3E \u0A30\u0A3F\u0A39\u0A3E \u0A39\u0A48...",
  "profile.relocalised": "{n} \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A07\u0A38 \u0A2D\u0A3E\u0A38\u0A3C\u0A3E \u0A35\u0A3F\u0A71\u0A1A \u0A05\u0A2A\u0A21\u0A47\u0A1F \u0A39\u0A4B\u0A0F\u0964",
  "profile.relocaliseFailed": "\u0A15\u0A41\u0A1D \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A05\u0A2A\u0A21\u0A47\u0A1F \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A47\u0964 \u0A2C\u0A3E\u0A05\u0A26 \u0A35\u0A3F\u0A71\u0A1A \u0A26\u0A41\u0A2C\u0A3E\u0A30\u0A3E \u0A15\u0A4B\u0A38\u0A3C\u0A3F\u0A38\u0A3C \u0A15\u0A30\u0A4B\u0964",
  "marketplace.navBrowse": "\u0A16\u0A4B\u0A1C\u0A4B",
  "marketplace.navProfile": "\u0A2A\u0A4D\u0A30\u0A4B\u0A2B\u0A3E\u0A08\u0A32",
  "marketplace.browseTitle": "\u0A2C\u0A3E\u0A1C\u0A3C\u0A3E\u0A30",
  "marketplace.searchPlaceholder": "\u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A32\u0A71\u0A2D\u0A4B...",
  "marketplace.filtersTitle": "\u0A2B\u0A3F\u0A32\u0A1F\u0A30",
  "marketplace.filtersClear": "\u0A38\u0A2D \u0A38\u0A3E\u0A2B\u0A3C \u0A15\u0A30\u0A4B",
  "marketplace.filterAll": "\u0A38\u0A3E\u0A30\u0A47",
  "marketplace.filterMaterial": "\u0A38\u0A2E\u0A71\u0A17\u0A30\u0A40",
  "marketplace.filterRegion": "\u0A16\u0A47\u0A24\u0A30",
  "marketplace.filterPrice": "\u0A15\u0A40\u0A2E\u0A24 \u0A30\u0A47\u0A02\u0A1C (\u20B9)",
  "marketplace.filterPriceMin": "\u0A18\u0A71\u0A1F\u0A4B-\u0A18\u0A71\u0A1F",
  "marketplace.filterPriceMax": "\u0A05\u0A27\u0A3F\u0A15\u0A24\u0A2E",
  "marketplace.sortLabel": "\u0A15\u0A4D\u0A30\u0A2E\u0A2C\u0A71\u0A27 \u0A15\u0A30\u0A4B",
  "marketplace.sortNewest": "\u0A28\u0A35\u0A3E\u0A02 \u0A2A\u0A39\u0A3F\u0A32\u0A3E\u0A02",
  "marketplace.sortPriceAsc": "\u0A15\u0A40\u0A2E\u0A24: \u0A18\u0A71\u0A1F \u0A24\u0A4B\u0A02 \u0A35\u0A71\u0A27",
  "marketplace.sortPriceDesc": "\u0A15\u0A40\u0A2E\u0A24: \u0A35\u0A71\u0A27 \u0A24\u0A4B\u0A02 \u0A18\u0A71\u0A1F",
  "marketplace.resultCount": "{n} \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A2E\u0A3F\u0A32\u0A47",
  "marketplace.loadMore": "\u0A39\u0A4B\u0A30 \u0A32\u0A4B\u0A21 \u0A15\u0A30\u0A4B",
  "marketplace.loadError": "\u0A2E\u0A3E\u0A30\u0A15\u0A40\u0A1F\u0A2A\u0A32\u0A47\u0A38 \u0A32\u0A4B\u0A21 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A3F\u0A06, \u0A2B\u0A3F\u0A30 \u0A15\u0A4B\u0A36\u0A3F\u0A36 \u0A15\u0A30\u0A4B",
  "marketplace.emptyTitle": "\u0A07\u0A28\u0A4D\u0A39\u0A3E\u0A02 \u0A2B\u0A3F\u0A32\u0A1F\u0A30\u0A3E\u0A02 \u0A28\u0A3E\u0A32 \u0A15\u0A4B\u0A08 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A28\u0A39\u0A40\u0A02 \u0A2E\u0A3F\u0A32\u0A3F\u0A06",
  "marketplace.emptyFiltered": "\u0A2B\u0A3F\u0A32\u0A1F\u0A30 \u0A39\u0A1F\u0A3E\u0A13 \u0A1C\u0A3E\u0A02 \u0A15\u0A41\u0A1D \u0A39\u0A4B\u0A30 \u0A16\u0A4B\u0A1C\u0A4B",
  "marketplace.emptyNoProducts": "\u0A39\u0A3E\u0A32\u0A47 \u0A15\u0A4B\u0A08 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A28\u0964 \u0A1C\u0A32\u0A26\u0A40 \u0A35\u0A3E\u0A2A\u0A38 \u0A06\u0A13\u0964",
  "marketplace.artisanUnnamed": "KalaSetu \u0A15\u0A3E\u0A30\u0A40\u0A17\u0A30",
  "marketplace.backToBrowse": "\u0A2C\u0A3E\u0A1C\u0A3C\u0A3E\u0A30 '\u0A1A \u0A35\u0A3E\u0A2A\u0A38",
  "marketplace.detailNotFoundTitle": "\u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A28\u0A39\u0A40\u0A02 \u0A2E\u0A3F\u0A32\u0A3F\u0A06",
  "marketplace.detailNotFoundMessage": "\u0A07\u0A39 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A39\u0A1F\u0A3E\u0A07\u0A06 \u0A17\u0A3F\u0A06 \u0A39\u0A4B \u0A38\u0A15\u0A26\u0A3E \u0A39\u0A48 \u0A1C\u0A3E\u0A02 \u0A39\u0A41\u0A23 \u0A09\u0A2A\u0A32\u0A2C\u0A27 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A48\u0964",
  "marketplace.artisanSummaryTitle": "\u0A15\u0A3E\u0A30\u0A40\u0A17\u0A30 \u0A2C\u0A3E\u0A30\u0A47",
  "marketplace.artisanProductCount": "{n} \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A15\u0A3E\u0A32\u0A3E\u0A38\u0A47\u0A1F\u0A42 '\u0A24\u0A47 \u0A32\u0A3F\u0A38\u0A1F \u0A15\u0A40\u0A24\u0A47",
  "marketplace.inquiryTitle": "\u0A07\u0A38 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A35\u0A3F\u0A71\u0A1A \u0A30\u0A41\u0A1A\u0A40?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0A15\u0A3E\u0A30\u0A40\u0A17\u0A30 \u0A28\u0A42\u0A70 \u0A26\u0A71\u0A38\u0A4B \u0A15\u0A3F \u0A24\u0A41\u0A38\u0A40\u0A02 \u0A15\u0A40 \u0A1A\u0A3E\u0A39\u0A41\u0A70\u0A26\u0A47 \u0A39\u0A4B: \u0A2E\u0A3E\u0A24\u0A30\u0A3E, \u0A15\u0A38\u0A1F\u0A2E\u0A3E\u0A08\u0A1C\u0A3C\u0A47\u0A38\u0A3C\u0A28, \u0A21\u0A3F\u0A32\u0A3F\u0A35\u0A30\u0A40 \u0A38\u0A2E\u0A3E\u0A02...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0A2A\u0A41\u0A71\u0A1B\u0A17\u0A3F\u0A71\u0A1B \u0A2D\u0A47\u0A1C\u0A4B",
  "marketplace.inquirySent": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40 \u0A2A\u0A41\u0A71\u0A1B\u0A17\u0A3F\u0A71\u0A1B \u0A2D\u0A47\u0A1C\u0A40 \u0A17\u0A08 \u0A39\u0A48\u0964 \u0A15\u0A3E\u0A30\u0A40\u0A17\u0A30 \u0A24\u0A41\u0A39\u0A3E\u0A21\u0A47 \u0A28\u0A3E\u0A32 \u0A38\u0A70\u0A2A\u0A30\u0A15 \u0A15\u0A30\u0A47\u0A17\u0A3E\u0964",
  "marketplace.inquiryError": "\u0A2A\u0A41\u0A71\u0A1B\u0A17\u0A3F\u0A71\u0A1B \u0A28\u0A39\u0A40\u0A02 \u0A2D\u0A47\u0A1C\u0A40 \u0A1C\u0A3E \u0A38\u0A15\u0A40, \u0A15\u0A3F\u0A30\u0A2A\u0A3E \u0A15\u0A30\u0A15\u0A47 \u0A26\u0A41\u0A2C\u0A3E\u0A30\u0A3E \u0A15\u0A4B\u0A38\u0A3C\u0A3F\u0A38\u0A3C \u0A15\u0A30\u0A4B\u0964",
  "marketplace.regionLabel": "\u0A16\u0A47\u0A24\u0A30",
  "marketplace.regionUnspecified": "\u0A28\u0A3F\u0A30\u0A27\u0A3E\u0A30\u0A24 \u0A28\u0A39\u0A40\u0A02",
  "marketplace.myInquiriesTitle": "\u0A2E\u0A47\u0A30\u0A40\u0A06\u0A02 \u0A2A\u0A41\u0A71\u0A1B\u0A17\u0A3F\u0A71\u0A1B\u0A3E\u0A02",
  "marketplace.inquiriesLoading": "\u0A24\u0A41\u0A39\u0A3E\u0A21\u0A40\u0A06\u0A02 \u0A2A\u0A41\u0A71\u0A1B\u0A17\u0A3F\u0A71\u0A1B\u0A3E\u0A02 \u0A32\u0A4B\u0A21 \u0A39\u0A4B \u0A30\u0A39\u0A40\u0A06\u0A02 \u0A39\u0A28...",
  "marketplace.inquiriesLoadError": "\u0A2A\u0A41\u0A71\u0A1B\u0A17\u0A3F\u0A71\u0A1B\u0A3E\u0A02 \u0A32\u0A4B\u0A21 \u0A28\u0A39\u0A40\u0A02 \u0A39\u0A4B \u0A38\u0A15\u0A40\u0A06\u0A02",
  "marketplace.noInquiries": "\u0A24\u0A41\u0A38\u0A40\u0A02 \u0A39\u0A3E\u0A32\u0A47 \u0A15\u0A4B\u0A08 \u0A2A\u0A41\u0A71\u0A1B\u0A17\u0A3F\u0A71\u0A1B \u0A28\u0A39\u0A40\u0A02 \u0A2D\u0A47\u0A1C\u0A40\u0964 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A32\u0A71\u0A2D\u0A23 \u0A32\u0A08 \u0A2E\u0A3E\u0A30\u0A15\u0A40\u0A1F\u0A2A\u0A32\u0A47\u0A38 \u0A35\u0A47\u0A16\u0A4B\u0964",
  "marketplace.inquiryProductRemoved": "\u0A07\u0A39 \u0A09\u0A24\u0A2A\u0A3E\u0A26 \u0A39\u0A41\u0A23 \u0A09\u0A2A\u0A32\u0A2C\u0A27 \u0A28\u0A39\u0A40\u0A02",
  "marketplace.inquiryStatusOpen": "\u0A1C\u0A35\u0A3E\u0A2C \u0A26\u0A40 \u0A09\u0A21\u0A40\u0A15",
  "marketplace.inquiryStatusClosed": "\u0A2C\u0A70\u0A26",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/sa.json
var sa_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0938\u094D\u0935\u0938\u094D\u092F \u0936\u093F\u0932\u094D\u092A\u0902 \u0911\u0928\u0932\u093E\u0907\u0928 \u0935\u093F\u0915\u094D\u0930\u092F\u0903, \u0938\u0930\u0932\u0924\u092F\u093E",
  "welcome.languageLabel": "\u092D\u093E\u0937\u093E \u091A\u092F\u0928\u0902 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "welcome.getStarted": "\u0906\u0930\u092E\u094D\u092D",
  "language.en": "\u0905\u0902\u0917\u094D\u0930\u0947\u091C\u0940",
  "language.hi": "\u0939\u093F\u0928\u094D\u0926\u0940",
  "email.title": "\u0908\u092E\u0947\u0932 \u092A\u0924\u0947\u0928 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902",
  "email.roleQuestion": "\u0905\u0939\u0902 \u0905\u0924\u094D\u0930",
  "email.roleSell": "\u092E\u092E \u0935\u0938\u094D\u0924\u0941 \u0935\u093F\u0915\u094D\u0930\u092F",
  "email.roleBuy": "\u0939\u0938\u094D\u0924\u0928\u093F\u0930\u094D\u092E\u093F\u0924 \u0935\u0938\u094D\u0924\u0941 \u0915\u094D\u0930\u0940\u0923",
  "email.label": "\u0908\u092E\u0947\u0932 \u092A\u0924\u093E",
  "email.helper": "\u096A \u0905\u0902\u0915\u0940\u092F \u0915\u094B\u0921\u0903 \u092A\u094D\u0930\u0947\u0937\u092F\u093F\u0937\u094D\u092F\u093E\u092E\u0903 \u0924\u0935 \u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930\u0923\u093E\u0930\u094D\u0925\u092E\u094D",
  "email.invalid": "\u0935\u0948\u0927\u0902 \u0908\u092E\u0947\u0932 \u092A\u0924\u0947\u0928 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902",
  "email.sendOtp": "\u0915\u094B\u0921\u0903 \u092A\u094D\u0930\u0947\u0937\u092F",
  "email.error": "\u0915\u094B\u0921\u0903 \u092A\u094D\u0930\u0947\u0937\u0923\u0902 \u0928 \u0936\u0915\u094D\u092F\u0924\u0947, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u0924\u094D\u0928\u0902 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "otp.title": "\u0908\u092E\u0947\u0932\u094D \u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930",
  "otp.subtitle": "\u096A \u0905\u0902\u0915\u0940\u092F \u0915\u094B\u0921\u094D \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902 \u092F\u0903 \u092A\u094D\u0930\u0947\u0937\u093F\u0924\u0903",
  "otp.emailUndelivered": "\u0908\u092E\u0947\u0932\u094D \u0928 \u092A\u094D\u0930\u0947\u0937\u093F\u0924\u0903\u0964 \u0924\u0935 \u0926\u0932\u093E\u0924\u094D \u0921\u0947\u092E\u094B \u0915\u094B\u0921\u094D \u092F\u093E\u091A\u092F",
  "otp.changeEmail": "\u0908\u092E\u0947\u0932\u094D \u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928\u0902",
  "otp.verify": "\u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930",
  "otp.invalid": "\u0938\u0930\u094D\u0935\u0902 \u096A \u0905\u0902\u0915\u0903 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902",
  "otp.wrong": "\u0905\u0938\u0924\u094D\u092F OTP, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938\u0903",
  "otp.resend": "OTP \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u0947\u0937\u092F",
  "otp.resendIn": "OTP \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u0947\u0937\u092F {n}\u0938\u0947\u0915\u0923\u094D\u0921\u094D",
  "otp.resendError": "OTP \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u0947\u0937\u092F \u0928 \u0936\u0915\u094D\u0928\u094B\u0924\u093F, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938\u0903",
  "camera.capture": "\u091B\u093E\u092F\u093E\u091A\u093F\u0924\u094D\u0930\u0902 \u0917\u094D\u0930\u0939\u0923\u0902",
  "camera.unavailable": "\u0915\u0948\u092E\u0930\u093E \u0905\u0928\u0941\u092A\u0932\u092C\u094D\u0927\u0903, \u092C\u0926\u0932\u0947 \u091B\u093E\u092F\u093E\u091A\u093F\u0924\u094D\u0930\u0902 \u091A\u092F\u0928\u0902",
  "camera.choosePhoto": "\u091B\u093E\u092F\u093E\u091A\u093F\u0924\u094D\u0930\u0902 \u091A\u092F\u0928",
  "camera.retake": "\u092A\u0941\u0928\u0903\u091A\u093F\u0924\u094D\u0930\u0923",
  "camera.usePhoto": "\u090F\u0924\u0924\u094D \u091B\u093E\u092F\u093E\u091A\u093F\u0924\u094D\u0930\u0902 \u0909\u092A\u092F\u094B\u0917",
  "camera.enhancing": "\u0924\u0935 \u091B\u093E\u092F\u093E\u091A\u093F\u0924\u094D\u0930\u0902 \u0938\u0902\u0935\u0930\u094D\u0927\u0928\u092E\u094D\u2026",
  "camera.enhanceError": "\u091B\u093E\u092F\u093E\u091A\u093F\u0924\u094D\u0930\u0902 \u0938\u0902\u0935\u0930\u094D\u0927\u093F\u0924\u0941\u0902 \u0928 \u0936\u0915\u094D\u092F\u0924\u0947",
  "camera.retry": "\u092A\u0941\u0928\u0903\u092A\u094D\u0930\u092F\u0924\u094D\u0928",
  "camera.before": "\u092E\u0942\u0932\u092E\u094D",
  "camera.after": "\u0938\u0902\u0935\u0930\u094D\u0927\u093F\u0924\u092E\u094D",
  "camera.compareHint": "\u0938\u094D\u0932\u093E\u0907\u0921\u0930\u094D \u0924\u093E\u0928\u094D \u0924\u0941\u0932\u092F\u093F\u0924\u0941\u0902",
  "camera.continue": "\u0905\u0917\u094D\u0930\u0917\u0924\u093F",
  "studio.title": "\u091A\u093F\u0924\u094D\u0930\u0902 \u0909\u0928\u094D\u0928\u092F",
  "studio.original": "\u092E\u0942\u0932",
  "studio.processed": "\u0938\u0902\u0938\u093E\u0927\u093F\u0924",
  "studio.removeBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F\u0902 \u0939\u091F",
  "studio.removingBackground": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F\u0902 \u0939\u091F\u094D\u092F\u092E\u094D...",
  "studio.keepOriginalBackground": "\u092E\u0942\u0932 \u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F\u0902 \u0930\u0915\u094D\u0937",
  "studio.backgroundWhite": "\u0936\u094D\u0935\u0947\u0924",
  "studio.backgroundNeutral": "\u092E\u0943\u0926\u0941 \u0915\u094D\u0930\u0940\u092E",
  "studio.backgroundBlur": "\u0927\u0941\u0902\u0927",
  "studio.backgroundUnavailableNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F\u0902 \u0928\u093F\u0937\u094D\u0915\u093E\u0938\u0928\u0902 \u0907\u0926\u093E\u0928\u0940\u0902 \u0909\u092A\u0932\u092C\u094D\u0927\u0902 \u0928\u093E\u0938\u094D\u0924\u093F\u0964 \u0924\u0935 \u091A\u093F\u0924\u094D\u0930\u0902 \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924\u092E\u094D\u0964",
  "studio.backgroundTimedOutNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F\u0902 \u0928\u093F\u0937\u094D\u0915\u093E\u0938\u0928\u0902 \u0926\u0940\u0930\u094D\u0918\u0915\u093E\u0932\u0902 \u0905\u0924\u0940\u0924\u0902 \u091A \u0924\u094D\u092F\u0915\u094D\u0924\u092E\u094D\u0964 \u0924\u0935 \u091A\u093F\u0924\u094D\u0930\u0902 \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924\u092E\u094D\u0964",
  "studio.backgroundQuotaNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F\u0902 \u0928\u093F\u0937\u094D\u0915\u093E\u0938\u0928\u0938\u094D\u092F \u0915\u094B\u091F\u093E \u0907\u0926\u093E\u0928\u0940\u0902 \u092A\u094D\u0930\u093E\u092A\u094D\u0924\u0903\u0964 \u0924\u0935 \u091A\u093F\u0924\u094D\u0930\u0902 \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924\u092E\u094D\u0964",
  "studio.backgroundFailedNotice": "\u092A\u0943\u0937\u094D\u0920\u092D\u0942\u092E\u093F\u0903 \u0939\u091F\u093E\u0928\u0947 \u0935\u093F\u092B\u0932\u0964 \u091A\u093F\u0924\u094D\u0930\u092E\u094D \u0905\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u093F\u0924\u092E\u094D\u0964",
  "studio.brightness": "\u092A\u094D\u0930\u0915\u093E\u0936\u0924\u093E",
  "studio.contrast": "\u0935\u093F\u0930\u094B\u0927",
  "studio.sharpen": "\u0924\u0940\u0915\u094D\u0937\u094D\u0923",
  "studio.autoLighting": "\u0938\u094D\u0935\u091A\u093E\u0932\u093F\u0924 \u092A\u094D\u0930\u0915\u093E\u0936",
  "studio.crop": "\u091B\u0947\u0926\u0928",
  "studio.cropOriginal": "\u092E\u0942\u0932",
  "studio.cropSquare": "\u0935\u0930\u094D\u0917",
  "studio.cropPortrait": "\u0932\u0902\u092C",
  "studio.accept": "\u0907\u0926\u0902 \u091A\u093F\u0924\u094D\u0930\u0902 \u092A\u094D\u0930\u092F\u094B\u0917\u092F",
  "studio.retake": "\u092A\u0941\u0928\u0903 \u0932\u0947",
  "studio.finalizing": "\u0938\u0902\u092A\u093E\u0926\u0928\u0902 \u0932\u093E\u0917\u0942...",
  "studio.on": "\u091A\u093E\u0932\u0941",
  "studio.off": "\u092C\u0928\u094D\u0926",
  "category.title": "\u0915\u093F\u0902 \u0935\u093F\u0915\u094D\u0930\u092F\u0924\u093F?",
  "category.continue": "\u0905\u0917\u094D\u0930\u0917\u0924\u093F",
  "category.materialQuestion": "\u090F\u0924\u0924\u094D \u0915\u093F\u092E\u094D \u0928\u093F\u0930\u094D\u092E\u093F\u0924\u092E\u094D? (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)",
  "category.textiles": "\u0935\u0938\u094D\u0924\u094D\u0930",
  "category.pottery": "\u092E\u0943\u0926\u094D\u092D\u0942\u0924",
  "category.jewelry": "\u0917\u0939\u0928\u093E",
  "category.woodwork": "\u0932\u0915\u0921\u093C\u0940\u0915\u0932\u093E",
  "category.bambooCane": "\u092C\u093E\u0901\u0938 \u0935 \u0915\u093E\u0920",
  "category.other": "\u0905\u0928\u094D\u092F",
  "voice.tapToRecord": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0938\u094D\u092F \u0935\u0930\u094D\u0923\u0928\u0902 \u0930\u0947\u0915\u0949\u0930\u094D\u0921 \u0915\u0930\u093F\u0924\u0941\u0902 \u0938\u094D\u092A\u0930\u094D\u0936 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "voice.recording": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0919\u094D...",
  "voice.stop": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u093F\u0919\u094D \u0930\u094B\u0915\u094B",
  "voice.record": "\u0930\u0947\u0915\u0949\u0930\u094D\u0921\u094D",
  "voice.reviewRecording": "\u092A\u0941\u0928\u0903 \u0936\u094D\u0930\u0935\u0923\u0902 \u0915\u0943\u0924\u094D\u0935\u093E, \u0924\u0926\u0941\u092A\u0930\u093F \u091C\u093E\u0930\u0940 \u0935\u093E \u092A\u0941\u0928\u0903 \u0930\u0947\u0915\u0949\u0930\u094D\u0921\u094D \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "voice.reRecord": "\u092A\u0941\u0928\u0903 \u0930\u0947\u0915\u0949\u0930\u094D\u0921\u094D",
  "voice.continue": "\u0905\u0917\u094D\u0930\u0917\u091A\u094D\u091B",
  "describe.transcribing": "\u0924\u0935 \u0935\u0930\u094D\u0923\u0928\u092E\u094D \u0905\u0935\u0917\u091A\u094D\u091B\u0924\u093F...",
  "describe.transcribeError": "\u0924\u0935 \u0935\u0930\u094D\u0923\u0928\u092E\u094D \u0928 \u0905\u0935\u0917\u091A\u094D\u091B\u0924\u094D",
  "describe.retry": "\u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938",
  "describe.reviewHint": "\u0906\u0935\u0936\u094D\u092F\u0915\u092E\u094D \u091A\u0947\u0924\u094D \u092A\u0941\u0928\u0930\u093E\u0935\u0932\u094B\u0915\u0928\u0902 \u0938\u0902\u092A\u093E\u0926\u092F",
  "describe.fallbackNote": "\u092E\u093E\u0907\u0915\u094D\u0930\u094B\u092B\u094B\u0928 \u0905\u0928\u0941\u092A\u0932\u092C\u094D\u0927\u0903, \u0924\u0935 \u0935\u0930\u094D\u0923\u0928\u0902 \u0932\u093F\u0916\u093F\u0924\u0941\u0902",
  "describe.placeholderEn": "\u0907\u0902\u0917\u094D\u0930\u091C\u0940\u092D\u093E\u0937\u093E\u092F\u093E\u092E\u094D \u0924\u0935 \u0909\u0924\u094D\u092A\u093E\u0926\u0902 \u0935\u0930\u094D\u0923\u092F",
  "describe.continue": "\u0905\u0917\u094D\u0930\u0917\u091A\u094D\u091B",
  "pricing.title": "\u0924\u0935 \u0909\u0924\u094D\u092A\u093E\u0926\u0938\u094D\u092F \u092E\u0942\u0932\u094D\u092F\u0902 \u0928\u093F\u0930\u094D\u0927\u093E\u0930\u0923\u092E\u094D",
  "pricing.summaryEdit": "\u0938\u0902\u092A\u093E\u0926\u0928\u092E\u094D",
  "pricing.materialCostLabel": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940 \u0935\u094D\u092F\u092F\u0903",
  "pricing.materialCostHelper": "\u0915\u091A\u094D\u091A\u093E \u0938\u093E\u092E\u0917\u094D\u0930\u0940\u0902 \u0930\u0941\u092A\u092F\u0947\u0923 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902",
  "pricing.materialCostInvalid": "\u0936\u0942\u0928\u094D\u092F\u0938\u0947 \u0905\u0927\u093F\u0915\u0902 \u092A\u0926\u093E\u0930\u094D\u0925 \u0932\u093E\u0917\u0924 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902",
  "pricing.getSuggestion": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935\u0902 \u092A\u094D\u0930\u093E\u092A\u094D\u0924\u0941\u0902",
  "pricing.suggestError": "\u092E\u0942\u0932\u094D\u092F \u0938\u0941\u091D\u093E\u0935\u0902 \u092A\u094D\u0930\u093E\u092A\u094D\u0924 \u0928 \u0915\u0930\u094D\u0924\u0941\u0902 \u0936\u0915\u094D\u092F\u0924\u0947",
  "pricing.retry": "\u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938",
  "pricing.rangeLabel": "\u0938\u0941\u091D\u093E\u0935\u093F\u0924 \u092E\u0942\u0932\u094D\u092F \u0936\u094D\u0930\u0947\u0923\u0940",
  "pricing.sellingPriceLabel": "\u0924\u0935 \u0935\u093F\u0915\u094D\u0930\u092F \u092E\u0942\u0932\u094D\u092F",
  "pricing.sellingPriceNote": "\u090F\u0924\u0924\u094D \u0938\u0941\u091D\u093E\u0935\u0903 \u0905\u0938\u094D\u0924\u093F, \u0924\u094D\u0935\u0902 \u0907\u091A\u094D\u091B\u093E\u0928\u0941\u0938\u093E\u0930\u0902 \u0915\u093F\u0902\u092E\u0924\u0902 \u0938\u094D\u0925\u093E\u092A\u092F\u093F\u0924\u0941\u0902 \u0936\u0915\u094D\u0928\u094B\u0937\u093F.",
  "pricing.sellingPriceInvalid": "\u0936\u0942\u0928\u094D\u092F\u0938\u0947 \u0905\u0927\u093F\u0915\u0902 \u0935\u093F\u0915\u094D\u0930\u092F \u092E\u0942\u0932\u094D\u092F \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902",
  "pricing.publish": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "pricing.publishError": "\u0924\u0935 \u0909\u0924\u094D\u092A\u093E\u0926 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0928 \u0915\u0930\u094D\u0924\u0941\u0902 \u0936\u0915\u094D\u092F\u0924\u0947",
  "pricing.successTitle": "\u0924\u0935 \u0909\u0924\u094D\u092A\u093E\u0926 \u091C\u0940\u0935\u093F\u0924\u0903 \u0905\u0938\u094D\u0924\u093F!",
  "pricing.successMessage": "\u0915\u094D\u0930\u0947\u0924\u093E\u0903 \u0905\u092C \u0924\u0935 \u0926\u0942\u0915\u093E\u0928\u0902 \u0924\u0926\u094D \u092A\u0936\u094D\u092F\u0928\u094D\u0924\u093F.",
  "pricing.viewShop": "\u092E\u092E \u0926\u0942\u0915\u093E\u0928\u0902 \u0926\u094D\u0930\u0937\u094D\u091F\u0941\u0902",
  "home.title": "\u092E\u092E \u0926\u0942\u0915\u093E\u0928\u092E\u094D",
  "home.gemBannerTitle": "GeM / ONDC \u0936\u0940 \u091C\u0921\u094D",
  "home.gemBannerBadge": "\u0938\u092E\u0940\u092A\u0902 \u0906\u0917\u091A\u094D\u091B\u0924\u093F",
  "home.gemBannerMessage": "\u090F\u0924\u0924\u094D \u0938\u092E\u093E\u0915\u0932\u0928\u0902 \u0938\u092E\u0940\u092A\u0902 \u0906\u0917\u091A\u094D\u091B\u0924\u093F.",
  "home.loading": "\u0924\u0935 \u0909\u0924\u094D\u092A\u093E\u0926\u093E\u0903 \u0932\u094B\u0921\u094D \u0915\u0930\u094D\u0924\u0941\u0902...",
  "home.loadError": "\u0924\u0935 \u0909\u0924\u094D\u092A\u093E\u0926\u093E\u0903 \u0932\u094B\u0921\u094D \u0928 \u0915\u0930\u094D\u0924\u0941\u0902 \u0936\u0915\u094D\u092F\u0924\u0947",
  "home.retry": "\u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938",
  "home.emptyTitle": "\u0905\u0926\u094D\u092F\u093E\u092A\u093F \u0909\u0924\u094D\u092A\u093E\u0926\u0903 \u0928\u093E\u0938\u094D\u0924\u093F",
  "home.emptyMessage": "KalaSetu \u092A\u0930 \u092A\u094D\u0930\u0925\u092E\u0902 \u0909\u0924\u094D\u092A\u093E\u0926\u0902 \u0938\u092E\u093E\u0935\u093F\u0937\u094D\u091F\u094D\u092F \u0935\u093F\u0915\u094D\u0930\u092F\u0902 \u0906\u0930\u092D\u0924\u0941.",
  "home.addFirstProduct": "KalaSetu \u092A\u0930 \u092A\u094D\u0930\u0925\u092E\u0902 \u0909\u0924\u094D\u092A\u093E\u0926\u0902 \u0938\u092E\u093E\u0935\u093F\u0937\u094D\u091F\u094D\u092F",
  "home.statusPublished": "\u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924",
  "home.statusDraft": "\u092E\u0938\u0941\u0926\u093E",
  "home.statusFailed": "\u0935\u093F\u092B\u0932",
  "home.detailCategory": "\u0935\u0930\u094D\u0917",
  "home.detailEdit": "\u0938\u0902\u092A\u093E\u0926\u0928",
  "home.detailDelete": "\u0935\u093F\u0932\u094B\u092A",
  "home.detailClose": "\u092C\u0902\u0926",
  "home.editPriceLabel": "\u092E\u0942\u0932\u094D\u092F",
  "home.editDescriptionLabel": "\u0935\u093F\u0935\u0930\u0923",
  "home.editSave": "\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928\u0902 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924",
  "home.editCancel": "\u0930\u0926\u094D\u0926",
  "home.editPriceInvalid": "\u0936\u0942\u0928\u094D\u092F\u0938\u0947 \u0905\u0927\u093F\u0915 \u092E\u0942\u0932\u094D\u092F\u0902 \u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u0941\u0902",
  "home.editDescriptionRequired": "\u0935\u093F\u0935\u0930\u0923\u0902 \u0926\u094B\u092D\u093E\u0937\u093E\u092F\u093E\u092E\u094D \u0930\u093F\u0915\u094D\u0924\u0902 \u0928 \u092D\u0935\u0947\u0924\u094D",
  "home.editError": "\u092A\u0930\u093F\u0935\u0930\u094D\u0924\u0928\u0902 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924\u0941\u0902 \u0928 \u0936\u0915\u094D\u092F\u0924\u0947, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938\u0903 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "home.deleteConfirm": "\u090F\u0924\u0924\u094D \u0909\u0924\u094D\u092A\u093E\u0926\u0902 \u0928\u0937\u094D\u091F\u0902 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941? \u092A\u0941\u0928\u0903 \u0928 \u0915\u0930\u094D\u0924\u0941\u0902 \u0936\u0915\u094D\u092F\u0924\u0947.",
  "home.deleteConfirmYes": "\u0928\u093F\u0936\u094D\u091A\u093F\u0924\u092E\u094D, \u0928\u0937\u094D\u091F\u0902 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "home.deleteError": "\u090F\u0924\u0924\u094D \u0909\u0924\u094D\u092A\u093E\u0926\u0902 \u0928\u0937\u094D\u091F\u0941\u0902 \u0928 \u0936\u0915\u094D\u092F\u0924\u0947, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938\u0903 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "profile.title": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932",
  "profile.emailLabel": "\u0908\u092E\u0947\u0932 \u092A\u0924\u0947",
  "profile.emailUnknown": "\u0909\u092A\u0932\u092C\u094D\u0927 \u0928\u093E\u0938\u094D\u0924\u093F",
  "profile.loading": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932\u0902 \u0932\u094B\u0921\u094D \u0915\u0930\u094D\u0924\u0941\u0902...",
  "profile.loadError": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932\u0902 \u0932\u094B\u0921\u094D \u0928 \u0936\u0915\u094D\u092F\u0924\u0947",
  "profile.displayNameLabel": "\u0924\u0935 \u0928\u093E\u092E",
  "profile.shopNameLabel": "\u0926\u0941\u0915\u093E\u0928\u0938\u094D\u092F \u0928\u093E\u092E",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932\u0902 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924\u0941\u0902",
  "profile.saved": "\u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0941\u0930\u0915\u094D\u0937\u093F\u0924",
  "profile.saveError": "\u0924\u0935 \u092A\u094D\u0930\u094B\u092B\u093C\u093E\u0907\u0932 \u0938\u0939\u0947\u091C\u093F\u0924\u0941\u0902 \u0928 \u0936\u0915\u094D\u092F\u0924\u0947, \u0915\u0943\u092A\u092F\u093E \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u093E\u0938 \u0915\u0930\u0903",
  "profile.logout": "\u0928\u093F\u0930\u094D\u0917\u092E",
  "install.message": "\u0924\u094D\u0935\u0930\u093F\u0924 \u092A\u094D\u0930\u0935\u0947\u0936\u093E\u092F KalaSetu \u0938\u094D\u0925\u093E\u092A\u092F",
  "install.action": "\u0938\u094D\u0925\u093E\u092A\u092F",
  "install.dismiss": "\u0905\u0938\u094D\u0935\u0940\u0915\u093E\u0930",
  "offline.message": "\u0924\u094D\u0935\u0902 \u0911\u092B\u093C\u0932\u093E\u0907\u0928 \u0905\u0938\u093F, \u0915\u093F\u091E\u094D\u091A\u093F\u0926\u094D \u0938\u0941\u0935\u093F\u0927\u093E\u0903 \u0915\u093E\u0930\u094D\u092F\u0902 \u0928 \u0915\u0930\u094D\u0924\u0941\u0902 \u0936\u0915\u094D\u0928\u0941\u0935\u0928\u094D\u0924\u093F",
  "welcome.languageHint": "\u0938\u0902\u092A\u0942\u0930\u094D\u0923 \u0905\u0928\u0941\u092A\u094D\u0930\u092F\u094B\u0917 \u090F\u0937\u093E \u092D\u093E\u0937\u093E \u092E\u0927\u094D\u092F\u0947 \u0939\u094B\u092F\u093F\u0937\u094D\u092F\u0924\u093F",
  "welcome.regionalLanguages": "\u092D\u093E\u0930\u0924\u0940\u092F \u092D\u093E\u0937\u093E\u0903",
  "describe.localTab": "\u0924\u0935 \u092D\u093E\u0937\u093E",
  "describe.placeholderLocal": "\u0924\u0935 \u0938\u094D\u0935\u092D\u093E\u0937\u093E\u092F\u093E\u092E\u094D \u0909\u0924\u094D\u092A\u093E\u0926\u0902 \u0935\u0930\u094D\u0923\u092F",
  "describe.syncing": "\u0905\u0928\u094D\u092F\u092D\u093E\u0937\u093E \u0905\u0926\u094D\u092F\u0924\u0928\u0902\u2026",
  "describe.syncFailed": "\u0905\u0928\u094D\u092F\u092D\u093E\u0937\u093E \u0905\u0926\u094D\u092F\u0924\u0928\u0902 \u0928 \u0915\u0930\u094D\u0924\u0941\u0902 \u0936\u0915\u094D\u092F\u0902\u0964 \u0906\u0935\u0936\u094D\u092F\u0915\u092E\u094D \u091A\u0947\u0924\u094D \u0938\u094D\u0935\u092F\u0902 \u0938\u092E\u094D\u092A\u093E\u0926\u092F\u0964",
  "describe.syncHint": "\u0938\u0902\u092A\u093E\u0926\u0928\u093E\u0928\u093F \u0905\u0928\u094D\u092F\u092D\u093E\u0937\u093E\u092F\u093E\u092E\u094D \u0938\u094D\u0935\u092F\u092E\u0947\u0935 \u092A\u094D\u0930\u0924\u093F\u0932\u093F\u092A\u094D\u092F\u0928\u094D\u0924\u0947\u0964",
  "pricing.updating": "\u0928\u0935\u0903 \u092A\u0926\u093E\u0930\u094D\u0925\u092E\u0942\u0932\u094D\u092F\u0938\u094D\u092F \u0905\u0926\u094D\u092F\u0924\u0928\u092E\u094D...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0938\u0942\u091A\u0940 \u0928\u093F\u0930\u094D\u092F\u093E\u0924 (ONDC \u0930\u0942\u092A)",
  "home.exportCatalogNote": "\u0906\u092A\u0915\u0947 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924 \u0938\u0942\u091A\u0940 \u0915\u094B ONDC \u0916\u0941\u0926\u0930\u093E \u0938\u0942\u091A\u0940 \u0930\u0942\u092A \u092E\u0947\u0902 \u0921\u093E\u0909\u0928\u0932\u094B\u0921 \u0915\u0930\u0924\u093E \u0939\u0948\u0964 \u090F\u0915\u0940\u0915\u0930\u0923-\u0924\u0948\u092F\u093E\u0930: \u092E\u093E\u0928\u091A\u093F\u0924\u094D\u0930\u0923 \u092A\u0942\u0930\u094D\u0923, \u0928\u0947\u091F\u0935\u0930\u094D\u0915 \u092A\u0930 \u0932\u093E\u0907\u0935 \u0939\u094B\u0928\u0947 \u0915\u0947 \u0932\u093F\u092F\u0947 \u0905\u092D\u0940 \u092D\u0940 ONDC \u092A\u0902\u091C\u0940\u0915\u0930\u0923 \u0906\u0935\u0936\u094D\u092F\u0915 \u0939\u0948\u0964",
  "home.exportOndcSingle": "\u0907\u0938 \u0935\u0938\u094D\u0924\u0941 \u0915\u094B \u0928\u093F\u0930\u094D\u092F\u093E\u0924 (ONDC \u0930\u0942\u092A)",
  "profile.relocalising": "\u0905\u0938\u094D\u092E\u093E\u0915\u0902 \u0909\u0924\u094D\u092A\u093E\u0926\u093E\u0928\u094D \u090F\u0937\u093E \u092D\u093E\u0937\u093E\u092F\u093E\u092E\u094D \u0905\u0926\u094D\u092F\u0924\u0928\u0902 \u0915\u0930\u094D\u0924\u0941\u0902...",
  "profile.relocalised": "\u0905\u0926\u094D\u092F\u0924\u0928\u0902 \u0915\u0943\u0924\u093E\u0903 {n} \u0909\u0924\u094D\u092A\u093E\u0926\u093E\u0903 \u090F\u0937\u093E \u092D\u093E\u0937\u093E\u092F\u093E\u092E\u094D.",
  "profile.relocaliseFailed": "\u0915\u093F\u091E\u094D\u091A\u093F\u0926\u094D \u0909\u0924\u094D\u092A\u093E\u0926\u093E\u0928\u094D \u0905\u0926\u094D\u092F\u0924\u0928\u0902 \u0928 \u0915\u0930\u094D\u0924\u0941\u0902 \u0936\u0915\u094D\u092F\u0924\u093E\u092E\u094D\u0964 \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u0924\u094D\u0928\u0903 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941\u0964",
  "marketplace.navBrowse": "\u0926\u0947\u0916\u0947\u0902",
  "marketplace.navProfile": "\u092A\u0930\u093F\u091A\u092F",
  "marketplace.browseTitle": "\u092C\u093E\u091C\u093E\u0930",
  "marketplace.searchPlaceholder": "\u0909\u0924\u094D\u092A\u093E\u0926 \u0916\u094B\u091C\u0947\u0902...",
  "marketplace.filtersTitle": "\u091B\u093E\u0928\u0928",
  "marketplace.filtersClear": "\u0938\u092D\u0940 \u0938\u093E\u092B\u093C \u0915\u0930\u0947\u0902",
  "marketplace.filterAll": "\u0938\u092D\u0940",
  "marketplace.filterMaterial": "\u0938\u093E\u092E\u0917\u094D\u0930\u0940",
  "marketplace.filterRegion": "\u0915\u094D\u0937\u0947\u0924\u094D\u0930",
  "marketplace.filterPrice": "\u092E\u0942\u0932\u094D\u092F \u0938\u0940\u092E\u093E (\u20B9)",
  "marketplace.filterPriceMin": "\u0928\u094D\u092F\u0942\u0928\u0924\u092E",
  "marketplace.filterPriceMax": "\u0905\u0927\u093F\u0915\u0924\u092E",
  "marketplace.sortLabel": "\u0915\u094D\u0930\u092E \u0905\u0928\u0941\u0938\u093E\u0930",
  "marketplace.sortNewest": "\u0928\u0935\u0940\u0928\u0924\u092E \u092A\u094D\u0930\u0925\u092E",
  "marketplace.sortPriceAsc": "\u092E\u0942\u0932\u094D\u092F: \u0928\u094D\u092F\u0942\u0928\u0924\u092E\u2011\u0909\u091A\u094D\u091A\u0924\u092E",
  "marketplace.sortPriceDesc": "\u092E\u0942\u0932\u094D\u092F: \u0909\u091A\u094D\u091A\u0924\u092E\u2011\u0928\u094D\u092F\u0942\u0928\u0924\u092E",
  "marketplace.resultCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u093E\u0903 \u092A\u094D\u0930\u093E\u092A\u094D\u0924\u093E\u0903",
  "marketplace.loadMore": "\u0905\u0927\u093F\u0915 \u0932\u094B\u0921",
  "marketplace.loadError": "\u092C\u093E\u091C\u093E\u0930\u0902 \u0932\u094B\u0921\u094D \u0928 \u0936\u0915\u094D\u092F\u0902, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u0924\u094D\u0928\u0902 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941",
  "marketplace.emptyTitle": "\u0907\u092D\u093F\u0903 \u092B\u093F\u0932\u094D\u091F\u0930\u0948\u0903 \u0928 \u0915\u0936\u094D\u091A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926\u0903",
  "marketplace.emptyFiltered": "\u090F\u0915\u0902 \u092B\u093F\u0932\u094D\u091F\u0930\u092E\u094D \u0905\u092A\u0938\u093E\u0930\u093F\u0924\u0941\u0902 \u0935\u093E \u0905\u0928\u094D\u092F\u0902 \u0905\u0928\u094D\u0935\u0947\u0937\u094D\u091F\u0941\u0902",
  "marketplace.emptyNoProducts": "\u0905\u0926\u094D\u092F\u093E\u092A\u093F \u0915\u0936\u094D\u091A\u0928 \u0909\u0924\u094D\u092A\u093E\u0926\u0903 \u092A\u094D\u0930\u0915\u093E\u0936\u093F\u0924\u0903 \u0928 \u0905\u0938\u094D\u0924\u093F\u0964 \u0936\u0940\u0918\u094D\u0930\u0902 \u092A\u0941\u0928\u0930\u092A\u093F \u092A\u0936\u094D\u092F\u0924\u0964",
  "marketplace.artisanUnnamed": "KalaSetu \u0915\u093E\u0930\u0940\u0917\u0930",
  "marketplace.backToBrowse": "\u092C\u093E\u091C\u093E\u0930 \u092E\u0947\u0902 \u0935\u093E\u092A\u0938",
  "marketplace.detailNotFoundTitle": "\u0909\u0924\u094D\u092A\u093E\u0926\u0903 \u0928 \u0932\u092D\u094D\u092F\u0924\u0947",
  "marketplace.detailNotFoundMessage": "\u0909\u0924\u094D\u092A\u093E\u0926\u0903 \u0939\u091F\u093F\u0924\u0903 \u0935\u093E \u0909\u092A\u0932\u092C\u094D\u0927\u0903 \u0928\u093E\u0938\u094D\u0924\u093F\u0964",
  "marketplace.artisanSummaryTitle": "\u0936\u093F\u0932\u094D\u092A\u0940 \u0935\u093F\u0937\u092F\u0947",
  "marketplace.artisanProductCount": "{n} \u0909\u0924\u094D\u092A\u093E\u0926\u093E\u0903 \u0915\u093E\u0932\u093E\u0938\u0947\u0924\u0941 \u092E\u0927\u094D\u092F\u0947 \u0938\u0942\u091A\u0940\u092D\u0942\u0924\u093E\u0903",
  "marketplace.inquiryTitle": "\u0909\u0924\u094D\u092A\u093E\u0926\u0947 \u0930\u0941\u091A\u093F\u0903?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0936\u093F\u0932\u094D\u092A\u0940\u0923\u093E\u0902 \u0907\u091A\u094D\u091B\u093F\u0924\u0902 \u0932\u093F\u0916\u0924\u0941: \u092E\u093E\u0924\u094D\u0930\u093E, \u0905\u0928\u0941\u0915\u0942\u0932\u0928, \u0935\u093F\u0924\u0930\u0923\u0915\u093E\u0932\u0903...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u092A\u094D\u0930\u0936\u094D\u0928\u0902 \u092A\u094D\u0930\u0947\u0937\u092F",
  "marketplace.inquirySent": "\u0924\u0935 \u092A\u094D\u0930\u0936\u094D\u0928\u0903 \u092A\u094D\u0930\u0947\u0937\u093F\u0924\u0903\u0964 \u0936\u093F\u0932\u094D\u092A\u0940 \u0936\u0940\u0918\u094D\u0930\u0902 \u0938\u092E\u094D\u092A\u0930\u094D\u0915\u0902 \u0915\u0930\u093F\u0937\u094D\u092F\u0924\u093F\u0964",
  "marketplace.inquiryError": "\u092A\u094D\u0930\u0936\u094D\u0928\u0902 \u092A\u094D\u0930\u0947\u0937\u093F\u0924\u0941\u0902 \u0928 \u0936\u0915\u094D\u0928\u094B\u0924\u093F, \u092A\u0941\u0928\u0903 \u092A\u094D\u0930\u092F\u0924\u094D\u0928\u0902 \u0915\u0941\u0930\u094D\u0935\u0928\u094D\u0924\u0941\u0964",
  "marketplace.regionLabel": "\u092A\u094D\u0930\u0926\u0947\u0936\u0903",
  "marketplace.regionUnspecified": "\u0928\u093F\u0930\u094D\u0926\u093F\u0937\u094D\u091F\u092E\u094D \u0928",
  "marketplace.myInquiriesTitle": "\u092E\u092E \u092A\u094D\u0930\u0936\u094D\u0928\u093E\u0903",
  "marketplace.inquiriesLoading": "\u0924\u0935 \u092A\u094D\u0930\u0936\u094D\u0928\u093E\u0928\u094D \u0932\u094B\u0921\u094D \u0915\u094D\u0930\u0940\u0921\u0928\u094D\u0924\u093F...",
  "marketplace.inquiriesLoadError": "\u0924\u0935 \u092A\u094D\u0930\u0936\u094D\u0928\u093E\u0928\u094D \u0932\u094B\u0921\u094D \u0915\u0930\u094D\u0924\u0941\u0902 \u0928 \u0936\u0915\u094D\u0928\u094B\u0924\u093F",
  "marketplace.noInquiries": "\u0924\u094D\u0935\u0902 \u0905\u0926\u094D\u092F\u093E\u092A\u093F \u092A\u094D\u0930\u0936\u094D\u0928\u0902 \u0928 \u092A\u094D\u0930\u0947\u0937\u093F\u0924\u0935\u093E\u0928\u094D\u0964 \u0909\u0924\u094D\u092A\u093E\u0926\u0928\u0947\u0937\u0941 \u0916\u094B\u091C\u094D\u092F\u0902 \u092C\u093E\u091C\u093E\u0930\u092E\u094D \u0905\u0928\u094D\u0935\u0947\u0937\u094D\u091F\u0941\u0964",
  "marketplace.inquiryProductRemoved": "\u0909\u0924\u094D\u092A\u093E\u0926\u0928\u092E\u094D \u0907\u0926\u093E\u0928\u0940\u0902 \u0928 \u0909\u092A\u0932\u092C\u094D\u0927\u092E\u094D",
  "marketplace.inquiryStatusOpen": "\u0909\u0924\u094D\u0924\u0930\u0938\u094D\u092F \u092A\u094D\u0930\u0924\u0940\u0915\u094D\u0937\u093E",
  "marketplace.inquiryStatusClosed": "\u0938\u092E\u093E\u092A\u094D\u0924\u092E\u094D",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/sat.json
var sat_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u1C5F\u1C5E\u1C62\u1C5F\u1C5D \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C5E\u1C6E\u1C60\u1C5F\u1C5B\u1C6E \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "welcome.languageLabel": "\u1C5F\u1C5E\u1C62\u1C5F\u1C5D \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C5E\u1C6E\u1C60\u1C5F\u1C5B\u1C6E \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "welcome.getStarted": "\u1C6E\u1C65\u1C5F\u1C68 \u1C6E\u1C66\u1C5F\u1C68\u1C6E\u1C65\u1C5F\u1C68",
  "language.en": "\u1C65\u1C5F\u1C71\u1C5B\u1C5F\u1C72\u1C64",
  "language.hi": "\u1C75\u1C77\u1C5F\u1C68\u1C5A\u1C62\u1C64",
  "email.title": "\u1C5F\u1C5E\u1C62\u1C5F\u1C5D \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C5E\u1C6E\u1C60\u1C5F\u1C5B\u1C6E \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "email.roleQuestion": "\u1C5F\u1C79\u1C5C\u1C5F \u1C5F\u1C79\u1C68\u1C64 \u1C5F\u1C79\u1C71\u1C5F",
  "email.roleSell": "\u1C5A\u1C71\u1C5A \u1C5F\u1C79\u1C72\u1C64 \u1C5A\u1C71\u1C5A",
  "email.roleBuy": "\u1C5A\u1C71\u1C5A \u1C5F\u1C79\u1C72\u1C64 \u1C5A\u1C71\u1C5A",
  "email.label": "\u1C65\u1C5F\u1C71\u1C5B\u1C5F\u1C72\u1C64 \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F",
  "email.helper": "\u1C5F\u1C5E\u1C62\u1C5F\u1C5D \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C5E\u1C6E\u1C60\u1C5F\u1C5B\u1C6E \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "email.invalid": "\u1C5F\u1C5E\u1C62\u1C5F\u1C5D \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C5E\u1C6E\u1C60\u1C5F\u1C5B\u1C6E \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "email.sendOtp": "\u1C65\u1C5F\u1C71\u1C5B\u1C5F\u1C72\u1C64 \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C5E\u1C6E\u1C60\u1C5F\u1C5B\u1C6E \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "email.error": "\u1C5F\u1C5E\u1C62\u1C5F\u1C5D \u1C60\u1C69\u1C5E\u1C5F\u1C79\u1C5C\u1C7C\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C5E\u1C6E\u1C60\u1C5F\u1C5B\u1C6E \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "otp.title": "\u1C5F\u1C5E\u1C5F\u1C5C \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C79\u1C5C\u1C69\u1C6D \u1C62\u1C6E",
  "otp.subtitle": "\u1C5F\u1C5E\u1C5F\u1C5C \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C62\u1C6E",
  "otp.emailUndelivered": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C66\u1C5F\u1C79\u1C75\u1C64 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C7E \u1C5F\u1C5E\u1C5F\u1C5C \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C62\u1C6E",
  "otp.changeEmail": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C6E",
  "otp.verify": "\u1C65\u1C5F\u1C79\u1C5C\u1C69\u1C6D \u1C62\u1C6E",
  "otp.invalid": "\u1C62\u1C64\u1C6B\u1C74\u1C5F\u1C5D \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C62\u1C6E",
  "otp.wrong": "\u1C65\u1C5F\u1C79\u1C5C\u1C69\u1C6D \u1C62\u1C6E",
  "otp.resend": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C66\u1C5F\u1C79\u1C75\u1C64 \u1C62\u1C6E",
  "otp.resendIn": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C66\u1C5F\u1C79\u1C75\u1C64 \u1C62\u1C6E {n}s",
  "otp.resendError": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C66\u1C5F\u1C79\u1C75\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C7E \u1C65\u1C5F\u1C79\u1C5C\u1C69\u1C6D \u1C62\u1C6E",
  "camera.capture": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C6E",
  "camera.unavailable": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C7E \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C6E",
  "camera.choosePhoto": "\u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "camera.retake": "\u1C62\u1C64\u1C6B \u1C60\u1C77\u1C5A\u1C75 \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62",
  "camera.usePhoto": "\u1C71\u1C5A\u1C76\u1C5F \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B",
  "camera.enhancing": "\u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C62\u1C6E\u1C71\u1C6E\u1C5B \u1C60\u1C5F\u1C71\u1C5F...",
  "camera.enhanceError": "\u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C62\u1C6E\u1C71\u1C6E\u1C5B \u1C66\u1C69\u1C6D\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C62",
  "camera.retry": "\u1C62\u1C64\u1C6B \u1C60\u1C77\u1C5A\u1C75 \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62",
  "camera.before": "\u1C61\u1C77\u1C64\u1C61\u1C7D \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62",
  "camera.after": "\u1C62\u1C6E\u1C71\u1C6E\u1C5B \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62",
  "camera.compareHint": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C68 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "camera.continue": "\u1C6E\u1C5E\u1C5F\u1C62 \u1C62\u1C6E",
  "studio.title": "\u1C5A\u1C71\u1C5A\u1C5E \u1C5A\u1C71 \u1C6A\u1C64\u1C71\u1C5F",
  "studio.original": "\u1C5A\u1C71\u1C5A\u1C5E\u1C5A\u1C71",
  "studio.processed": "\u1C66\u1C5A\u1C71\u1C5A\u1C5E\u1C5A\u1C71",
  "studio.removeBackground": "\u1C75\u1C5F\u1C60\u1C5C\u1C7D\u1C68\u1C5A\u1C71\u1C70 \u1C66\u1C5F\u1C79\u1C5E\u1C64",
  "studio.removingBackground": "\u1C75\u1C5F\u1C60\u1C5C\u1C7D\u1C68\u1C5A\u1C71\u1C70 \u1C66\u1C5F\u1C79\u1C5E\u1C64 \u1C5A\u1C71...",
  "studio.keepOriginalBackground": "\u1C5A\u1C71\u1C5A\u1C5E\u1C5A\u1C71 \u1C75\u1C5F\u1C60\u1C5C\u1C7D\u1C68\u1C5A\u1C71\u1C70 \u1C66\u1C5F\u1C79\u1C5E\u1C64",
  "studio.backgroundWhite": "\u1C5A\u1C71\u1C5A\u1C5E",
  "studio.backgroundNeutral": "\u1C5F\u1C71\u1C5F\u1C72\u1C64 \u1C60\u1C68\u1C64\u1C62",
  "studio.backgroundBlur": "\u1C5A\u1C71\u1C5A\u1C5E\u1C5A\u1C71 \u1C5A\u1C71\u1C5F",
  "studio.backgroundUnavailableNotice": "\u1C75\u1C5F\u1C60\u1C5C\u1C7D\u1C68\u1C5A\u1C71\u1C70 \u1C66\u1C5F\u1C79\u1C5E\u1C64 \u1C5F\u1C79\u1C71\u1C5F \u1C5F\u1C79\u1C71\u1C5F \u1C5F\u1C79\u1C71\u1C5A\u1C72 \u1C5A\u1C71\u1C5A\u1C5E \u16B1\u16B1\u16B1. \u1C5A\u1C71\u1C5A\u1C5E \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1.",
  "studio.backgroundTimedOutNotice": "\u1C75\u1C5F\u1C60\u1C5C\u1C7D\u1C68\u1C5A\u1C71\u1C70 \u1C66\u1C5F\u1C79\u1C5E\u1C64 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1. \u1C5A\u1C71\u1C5A\u1C5E \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1.",
  "studio.backgroundQuotaNotice": "\u1C75\u1C5F\u1C60\u1C5C\u1C7D\u1C68\u1C5A\u1C71\u1C70 \u1C66\u1C5F\u1C79\u1C5E\u1C64 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1. \u1C5A\u1C71\u1C5A\u1C5E \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1 \u16B1\u16B1\u16B1.",
  "studio.backgroundFailedNotice": "Background removal failed. Your photo is unchanged.",
  "studio.brightness": "Brightness",
  "studio.contrast": "Contrast",
  "studio.sharpen": "Sharpen",
  "studio.autoLighting": "Auto lighting",
  "studio.crop": "Crop",
  "studio.cropOriginal": "Original",
  "studio.cropSquare": "Square",
  "studio.cropPortrait": "Portrait",
  "studio.accept": "Use this photo",
  "studio.retake": "Retake",
  "studio.finalizing": "Applying your edits...",
  "studio.on": "\u1C5A\u1C71",
  "studio.off": "\u1C5A\u1C6F",
  "category.title": "\u1C71\u1C5A\u1C76\u1C5F \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C60\u1C5F\u1C79\u1C62\u1C64?",
  "category.continue": "\u1C6E\u1C5E\u1C5F\u1C62 \u1C62\u1C6E",
  "category.materialQuestion": "What is it made of? (optional)",
  "category.textiles": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79",
  "category.pottery": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "category.jewelry": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "category.woodwork": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "category.bambooCane": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "category.other": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79",
  "voice.tapToRecord": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "voice.recording": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64...",
  "voice.stop": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "voice.record": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79",
  "voice.reviewRecording": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64, \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "voice.reRecord": "\u1C6F\u1C5F\u1C79\u1C6B\u1C5F\u1C79 \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "voice.continue": "\u1C60\u1C5F\u1C79\u1C5E\u1C64\u1C6D\u1C5F\u1C79",
  "describe.transcribing": "\u1C71\u1C5F\u1C76 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79...",
  "describe.transcribeError": "\u1C71\u1C5F\u1C76 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C75\u1C5F\u1C79\u1C72\u1C5B\u1C64\u1C6D\u1C5F",
  "describe.retry": "\u1C61\u1C5F\u1C66\u1C5F\u1C78 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79",
  "describe.reviewHint": "\u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79, \u1C5F\u1C68 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79",
  "describe.fallbackNote": "\u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C75\u1C5F\u1C79\u1C72\u1C5B\u1C64\u1C6D\u1C5F, \u1C71\u1C5F\u1C76 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79",
  "describe.placeholderEn": "\u1C71\u1C5F\u1C76 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79",
  "describe.continue": "\u1C60\u1C5F\u1C79\u1C5E\u1C64\u1C6D\u1C5F\u1C79",
  "pricing.title": "\u1C71\u1C5F\u1C76 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79",
  "pricing.summaryEdit": "\u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79",
  "pricing.materialCostLabel": "\u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C62\u1C5F\u1C71\u1C5F\u1C63",
  "pricing.materialCostHelper": "\u1C71\u1C5F\u1C76 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79, \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C79",
  "pricing.materialCostInvalid": "\u1C75\u1C5F\u1C5D\u1C6E\u1C65\u1C5F\u1C68 \u1C60\u1C5F\u1C5B\u1C77\u1C5F \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D \u1C5F\u1C6B\u1C5F\u1C6D \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D",
  "pricing.getSuggestion": "\u1C60\u1C5F\u1C5B\u1C77\u1C5F \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C67\u1C5F\u1C62\u1C5F\u1C62",
  "pricing.suggestError": "\u1C60\u1C5F\u1C5B\u1C77\u1C5F \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C67\u1C5F\u1C62\u1C5F\u1C62 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C75\u1C5F\u1C79\u1C72\u1C5B\u1C64 \u1C5F\u1C60\u1C5F\u1C71\u1C5F",
  "pricing.retry": "\u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D",
  "pricing.rangeLabel": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C60\u1C5F\u1C5B\u1C77\u1C5F \u1C62\u1C5F\u1C68\u1C5F\u1C5D",
  "pricing.sellingPriceLabel": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C60\u1C5F\u1C5B\u1C77\u1C5F",
  "pricing.sellingPriceNote": "\u1C71\u1C5A\u1C76\u1C5F \u1C6B\u1C5A \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C60\u1C5F\u1C71\u1C5F, \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C60\u1C5F\u1C5B\u1C77\u1C5F \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D \u1C5F\u1C6B\u1C5F\u1C6D \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D",
  "pricing.sellingPriceInvalid": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C60\u1C5F\u1C5B\u1C77\u1C5F \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D \u1C5F\u1C6B\u1C5F\u1C6D \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D",
  "pricing.publish": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "pricing.publishError": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C75\u1C5F\u1C79\u1C72\u1C5B\u1C64 \u1C5F\u1C60\u1C5F\u1C71\u1C5F",
  "pricing.successTitle": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "pricing.successMessage": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "pricing.viewShop": "\u1C5F\u1C5E\u1C5F \u1C68\u1C6E\u1C6D\u1C5F\u1C5C \u1C6A\u1C5F\u1C79\u1C5E\u1C69 \u1C68\u1C6E \u1C67\u1C6E\u1C5E \u1C62\u1C6E",
  "home.title": "\u1C5F\u1C5E\u1C5F \u1C68\u1C6E\u1C6D\u1C5F\u1C5C \u1C6A\u1C5F\u1C79\u1C5E\u1C69",
  "home.gemBannerTitle": "GeM / ONDC \u1C68\u1C6E \u1C75\u1C5F\u1C6A\u1C77\u1C5F\u1C63 \u1C62\u1C6E",
  "home.gemBannerBadge": "\u1C61\u1C5F\u1C66\u1C5F\u1C78 \u1C5B\u1C6E \u1C66\u1C69\u1C6D\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.gemBannerMessage": "\u1C71\u1C5A\u1C76\u1C5F \u1C75\u1C5F\u1C6A\u1C77\u1C5F\u1C63 \u1C61\u1C5F\u1C66\u1C5F\u1C78 \u1C5B\u1C6E \u1C66\u1C69\u1C6D\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C7E",
  "home.loading": "\u1C5F\u1C5E\u1C5F \u1C68\u1C6E\u1C6D\u1C5F\u1C5C \u1C60\u1C69\u1C6D\u1C5F\u1C79\u1C68\u1C64 \u1C60\u1C5A \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F...",
  "home.loadError": "\u1C5F\u1C5E\u1C5F \u1C68\u1C6E\u1C6D\u1C5F\u1C5C \u1C60\u1C69\u1C6D\u1C5F\u1C79\u1C68\u1C64 \u1C60\u1C5A \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D",
  "home.retry": "\u1C75\u1C5F\u1C79\u1C70\u1C64\u1C6D\u1C5F\u1C79\u1C5C \u1C62\u1C6E",
  "home.emptyTitle": "\u1C60\u1C69\u1C6D\u1C5F\u1C79\u1C68\u1C64 \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C6D \u1C66\u1C69\u1C6D\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.emptyMessage": "KalaSetu \u1C68\u1C6E \u1C60\u1C69\u1C6D\u1C5F\u1C79\u1C68\u1C64 \u1C60\u1C5A \u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F\u1C5C \u1C5B\u1C6E \u1C6E\u1C65\u1C5F\u1C6D \u1C60\u1C69\u1C6D\u1C5F\u1C79\u1C68\u1C64 \u1C60\u1C5A \u1C75\u1C5F\u1C6A\u1C77\u1C5F\u1C63 \u1C62\u1C6E\u1C7E",
  "home.addFirstProduct": "\u1C6E\u1C65\u1C5F\u1C6D \u1C60\u1C69\u1C6D\u1C5F\u1C79\u1C68\u1C64 \u1C75\u1C5F\u1C6A\u1C77\u1C5F\u1C63 \u1C62\u1C6E",
  "home.statusPublished": "\u1C60\u1C5F\u1C79\u1C62\u1C64\u1C6D\u1C5F",
  "home.statusDraft": "\u1C60\u1C5F\u1C79\u1C62\u1C64",
  "home.statusFailed": "\u1C75\u1C5F\u1C79\u1C72\u1C5B\u1C64",
  "home.detailCategory": "\u1C6F\u1C5F\u1C79\u1C68\u1C65\u1C64",
  "home.detailEdit": "\u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.detailDelete": "\u1C65\u1C5F\u1C79\u1C75\u1C64",
  "home.detailClose": "\u1C6E\u1C62\u1C5F",
  "home.editPriceLabel": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D",
  "home.editDescriptionLabel": "\u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C79\u1C62\u1C64",
  "home.editSave": "\u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C65\u1C5F\u1C79\u1C75\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.editCancel": "\u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C65\u1C5F\u1C79\u1C75\u1C64",
  "home.editPriceInvalid": "0 \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.editDescriptionRequired": "\u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.editError": "\u1C5F\u1C5E\u1C5F\u1C5C \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C75\u1C5F\u1C79\u1C71\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F, \u1C62\u1C64\u1C6B \u1C66\u1C5F\u1C79\u1C70\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C5E\u1C6E\u1C71\u1C5F\u1C5C \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.deleteConfirm": "\u1C71\u1C5A\u1C76\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C75\u1C5F\u1C79\u1C71\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F? \u1C71\u1C5A\u1C76\u1C5F \u1C75\u1C5F\u1C79\u1C71\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C6D\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "home.deleteConfirmYes": "\u1C65\u1C5F\u1C71\u1C5F\u1C62, \u1C75\u1C5F\u1C79\u1C71\u1C69\u1C5C",
  "home.deleteError": "\u1C71\u1C5A\u1C76\u1C5F \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C75\u1C5F\u1C79\u1C71\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F, \u1C62\u1C64\u1C6B \u1C66\u1C5F\u1C79\u1C70\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C5E\u1C6E\u1C71\u1C5F\u1C5C \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F",
  "profile.title": "\u1C6F\u1C5F\u1C79\u1C68\u1C65\u1C64",
  "profile.emailLabel": "\u1C61\u1C64\u1C5E\u1C64 \u1C60\u1C77\u1C5A\u1C71\u1C70\u1C5A\u1C71",
  "profile.emailUnknown": "\u1C65\u1C5F\u1C79\u1C5B \u1C60\u1C5F\u1C71\u1C5F",
  "profile.loading": "\u1C5F\u1C5E\u1C5F\u1C5C \u1C6F\u1C5F\u1C79\u1C68\u1C65\u1C64 \u1C60\u1C77\u1C5A\u1C71\u1C70\u1C5A\u1C71 \u1C60\u1C5F\u1C71\u1C5F...",
  "profile.loadError": "\u1C5F\u1C5E\u1C5F\u1C5C \u1C6F\u1C5F\u1C79\u1C68\u1C65\u1C64 \u1C60\u1C77\u1C5A\u1C71\u1C70\u1C5A\u1C71 \u1C60\u1C5F\u1C71\u1C5F",
  "profile.displayNameLabel": "\u1C5F\u1C5E\u1C5F\u1C5C \u1C62\u1C69\u1C71\u1C69\u1C62",
  "profile.shopNameLabel": "\u1C65\u1C5F\u1C79\u1C5B \u1C62\u1C69\u1C71\u1C69\u1C62",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u1C6F\u1C5F\u1C79\u1C68\u1C65\u1C64 \u1C75\u1C5F\u1C79\u1C71\u1C69\u1C5C",
  "profile.saved": "\u1C6F\u1C77\u1C64\u1C5E\u1C64\u1C5E\u1C64 \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5F\u1C60\u1C5F\u1C71\u1C5F",
  "profile.saveError": "\u1C6F\u1C77\u1C64\u1C5E\u1C64\u1C5E\u1C64 \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C60\u1C5F\u1C71\u1C5F, \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C6E\u1C60\u1C5F \u1C62\u1C5F\u1C71\u1C5F\u1C63 \u1C62\u1C5F\u1C71\u1C5F\u1C63",
  "profile.logout": "\u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "install.message": "KalaSetu \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B",
  "install.action": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "install.dismiss": "\u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "offline.message": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63, \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "welcome.languageHint": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "welcome.regionalLanguages": "\u1C6F\u1C5F\u1C79\u1C68\u1C65\u1C64 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "describe.localTab": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "describe.placeholderLocal": "\u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63 \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C5E\u1C5F\u1C79\u1C5C\u1C64\u1C6B \u1C65\u1C5F\u1C68\u1C66\u1C5F\u1C63",
  "describe.syncing": "\u1C5F\u1C68\u1C64 \u1C6A\u1C64\u1C60\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C60\u1C5F\u1C71\u1C5F...",
  "describe.syncFailed": "\u1C5F\u1C68\u1C64 \u1C6A\u1C64\u1C60\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C66\u1C69\u1C6D\u1C69\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C7E \u1C62\u1C5F\u1C68\u1C5F\u1C5D \u1C60\u1C5F\u1C71\u1C5F\u1C5C \u1C60\u1C77\u1C5A\u1C71 \u1C5F\u1C61\u1C5F\u1C5C \u1C6A\u1C64\u1C60\u1C64 \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C62\u1C6E\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "describe.syncHint": "\u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C5F\u1C68\u1C64 \u1C6A\u1C64\u1C60\u1C64 \u1C6B\u1C64\u1C65\u1C5A\u1C62 \u1C6B\u1C5F\u1C5C \u1C62\u1C6E\u1C71\u1C5F\u1C5C\u1C7C\u1C5F\u1C7E",
  "pricing.updating": "\u1C71\u1C5A\u1C5C \u1C60\u1C5A \u1C5A\u1C71 \u1C60\u1C5A\u1C5C \u1C60\u1C5A\u1C5C \u1C60\u1C5A...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u1C71\u1C5A\u1C76\u1C5F \u1C6A\u1C5F\u1C79\u1C5E\u1C69 \u1C68\u1C6E \u1C5F\u1C62\u1C5F\u1C5C \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C66\u1C5F\u1C79\u1C75\u1C64\u1C61...",
  "profile.relocalised": "\u1C71\u1C5A\u1C76\u1C5F \u1C6A\u1C5F\u1C79\u1C5E\u1C69 \u1C68\u1C6E {n} \u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C60\u1C5F\u1C79\u1C62\u1C64 \u1C66\u1C5F\u1C79\u1C75\u1C64\u1C61 \u1C5F\u1C60\u1C5F\u1C71\u1C5F\u1C62\u1C7E",
  "profile.relocaliseFailed": "\u1C6F\u1C5F\u1C68\u1C65\u1C5F\u1C62 \u1C60\u1C5A \u1C66\u1C5F\u1C79\u1C75\u1C64\u1C61 \u1C75\u1C5F\u1C79\u1C72\u1C5B\u1C64\u1C6D\u1C5F\u1C79\u1C5C \u1C60\u1C5F\u1C71\u1C5F\u1C62\u1C7E \u1C62\u1C64\u1C6B \u1C75\u1C5F\u1C79\u1C71\u1C69\u1C5C \u1C68\u1C6E \u1C62\u1C6E\u1C71\u1C5F\u1C5C \u1C5E\u1C6E\u1C71\u1C5F\u1C62\u1C7E",
  "marketplace.navBrowse": "Browse",
  "marketplace.navProfile": "Profile",
  "marketplace.browseTitle": "Marketplace",
  "marketplace.searchPlaceholder": "Search products...",
  "marketplace.filtersTitle": "Filters",
  "marketplace.filtersClear": "Clear all",
  "marketplace.filterAll": "All",
  "marketplace.filterMaterial": "Material",
  "marketplace.filterRegion": "Region",
  "marketplace.filterPrice": "Price range (\u20B9)",
  "marketplace.filterPriceMin": "Min",
  "marketplace.filterPriceMax": "Max",
  "marketplace.sortLabel": "Sort by",
  "marketplace.sortNewest": "Newest first",
  "marketplace.sortPriceAsc": "Price: low to high",
  "marketplace.sortPriceDesc": "Price: high to low",
  "marketplace.resultCount": "{n} products found",
  "marketplace.loadMore": "Load more",
  "marketplace.loadError": "Could not load the marketplace, please try again",
  "marketplace.emptyTitle": "No products match these filters",
  "marketplace.emptyFiltered": "Try clearing a filter or searching for something else.",
  "marketplace.emptyNoProducts": "No products have been published yet. Check back soon.",
  "marketplace.artisanUnnamed": "KalaSetu artisan",
  "marketplace.backToBrowse": "Back to marketplace",
  "marketplace.detailNotFoundTitle": "Product not found",
  "marketplace.detailNotFoundMessage": "This product may have been removed or is no longer available.",
  "marketplace.artisanSummaryTitle": "About the artisan",
  "marketplace.artisanProductCount": "{n} products listed on KalaSetu",
  "marketplace.inquiryTitle": "Interested in this product?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "Tell the artisan what you're looking for: quantity, customisation, delivery timeline...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "Send inquiry",
  "marketplace.inquirySent": "Your inquiry has been sent. The artisan will be in touch.",
  "marketplace.inquiryError": "Could not send your inquiry, please try again",
  "marketplace.regionLabel": "Region",
  "marketplace.regionUnspecified": "Not specified",
  "marketplace.myInquiriesTitle": "My inquiries",
  "marketplace.inquiriesLoading": "Loading your inquiries...",
  "marketplace.inquiriesLoadError": "Could not load your inquiries",
  "marketplace.noInquiries": "You haven't sent any inquiries yet. Browse the marketplace to find products.",
  "marketplace.inquiryProductRemoved": "This product is no longer available",
  "marketplace.inquiryStatusOpen": "Awaiting reply",
  "marketplace.inquiryStatusClosed": "Closed",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/sd.json
var sd_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u067E\u0646\u06BE\u0646\u062C\u064A \u062F\u0633\u062A\u06AA\u0627\u0631\u064A \u0622\u0646\u0644\u0627\u0626\u0646 \u0648\u06AA\u0631\u0648 \u06AA\u0631\u064A\u0648\u060C \u0622\u0633\u0627\u0646 \u0637\u0631\u064A\u0642\u064A \u0633\u0627\u0646.",
  "welcome.languageLabel": "\u067E\u0646\u06BE\u0646\u062C\u0648 \u067B\u0648\u0644\u064A \u0686\u0648\u0646\u068A\u064A\u0648",
  "welcome.getStarted": "\u0634\u0631\u0648\u0639 \u06AA\u0631\u064A\u0648",
  "language.en": "\u0627\u0646\u06AF\u0631\u064A\u0632\u064A",
  "language.hi": "\u0647\u0646\u062F\u064A",
  "email.title": "\u067E\u0646\u06BE\u0646\u062C\u0648 \u0627\u064A \u0645\u064A\u0644 \u067E\u062A\u0648 \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648",
  "email.roleQuestion": "\u0645\u0627\u0646 \u0647\u062A\u064A \u0622\u06BE\u064A\u0627\u0646",
  "email.roleSell": "\u0645\u0646\u0647\u0646\u062C\u0627 \u0634\u064A\u0648\u0646 \u0648\u06AA\u0631\u0648 \u06AA\u0631\u064A\u0648",
  "email.roleBuy": "\u0647\u067F \u067A\u0647\u064A\u0644 \u0634\u064A\u0648\u0646 \u062E\u0631\u064A\u062F \u06AA\u0631\u064A\u0648",
  "email.label": "\u0627\u064A \u0645\u064A\u0644 \u067E\u062A\u0648",
  "email.helper": "\u0627\u0633\u0627\u0646 4 \u0627\u0646\u06AF\u0646 \u0648\u0627\u0631\u0648 \u06AA\u0648\u068A \u0645\u0648\u06AA\u0644\u064A\u0646\u062F\u0627\u0633\u064A\u0646 \u062A\u0635\u062F\u064A\u0642 \u0644\u0627\u0621\u0650 \u062A\u0647 \u0627\u0648\u06BE\u0627\u0646 \u0627\u06BE\u0648 \u0622\u0647\u064A\u0648.",
  "email.invalid": "\u0627\u0686\u0648 \u062A\u0647 \u0635\u062D\u064A\u062D \u0627\u064A \u0645\u064A\u0644 \u067E\u062A\u0648 \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648",
  "email.sendOtp": "\u06AA\u0648\u068A \u0645\u0648\u06AA\u0644\u064A\u0648",
  "email.error": "\u06AA\u0648\u068A \u0645\u0648\u06AA\u0644\u064A \u0646\u0647 \u0633\u06AF\u0647\u064A\u0648\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "otp.title": "\u067E\u0646\u06BE\u0646\u062C\u0648 \u0627\u064A \u0645\u064A\u0644 \u062A\u0635\u062F\u064A\u0642 \u06AA\u0631\u064A\u0648",
  "otp.subtitle": "4 \u0639\u062F\u062F \u06AA\u0648\u068A \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648 \u062C\u064A\u06AA\u0648 \u0645\u0648\u06AA\u0644\u064A\u0648 \u0648\u064A\u0648 \u0622\u0647\u064A",
  "otp.emailUndelivered": "\u0627\u0633\u0627\u0646 \u0627\u064A \u0645\u064A\u0644 \u0645\u0648\u06AA\u0644\u064A \u0646\u0647 \u0633\u06AF\u0647\u064A\u0627. \u067E\u0646\u0647\u0646\u062C\u064A \u067D\u064A\u0645 \u06A9\u0627\u0646 \u068A\u064A\u0645\u0648 \u06AA\u0648\u068A \u067E\u0687\u0648.",
  "otp.changeEmail": "\u0627\u064A \u0645\u064A\u0644 \u062A\u0628\u062F\u064A\u0644 \u06AA\u0631\u064A\u0648",
  "otp.verify": "\u062A\u0635\u062F\u06CC\u0642 \u06AA\u0631\u064A\u0648",
  "otp.invalid": "\u0633\u0680 4 \u0639\u062F\u062F \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648",
  "otp.wrong": "\u063A\u0644\u0637 OTP\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "otp.resend": "OTP \u067B\u064A\u0647\u0631 \u0645\u0648\u06AA\u0644\u064A\u0648",
  "otp.resendIn": "OTP \u067B\u064A\u0647\u0631 \u0645\u0648\u06AA\u0644\u064A\u0648 {n}s \u0627\u0646\u062F\u0631",
  "otp.resendError": "OTP \u067B\u064A\u0647\u0631 \u0645\u0648\u06AA\u0644\u064A \u0646\u0647 \u0633\u06AF\u0647\u064A\u0648\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "camera.capture": "\u062A\u0635\u0648\u064A\u0631 \u0648\u067A\u0648",
  "camera.unavailable": "\u06AA\u064A\u0645\u0631\u0627 \u062F\u0633\u062A\u064A\u0627\u0628 \u0646\u0627\u0647\u064A\u060C \u0627\u0646 \u062C\u064A \u062C\u06B3\u0647\u0647 \u062A\u064A \u062A\u0635\u0648\u064A\u0631 \u0686\u0648\u0646\u068A\u064A\u0648.",
  "camera.choosePhoto": "\u062A\u0635\u0648\u064A\u0631 \u0686\u0648\u0646\u068A\u064A\u0648",
  "camera.retake": "\u067B\u064A\u0647\u0631 \u0648\u067A\u0648",
  "camera.usePhoto": "\u0627\u0647\u0627 \u062A\u0635\u0648\u064A\u0631 \u0627\u0633\u062A\u0639\u0645\u0627\u0644 \u06AA\u0631\u064A\u0648",
  "camera.enhancing": "\u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u062A\u0635\u0648\u064A\u0631 \u0628\u0647\u062A\u0631 \u06AA\u0631\u064A \u0631\u0647\u064A\u0648 \u0622\u0647\u064A...",
  "camera.enhanceError": "\u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u062A\u0635\u0648\u064A\u0631 \u0628\u0647\u062A\u0631 \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A",
  "camera.retry": "\u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634",
  "camera.before": "\u0627\u0635\u0644",
  "camera.after": "\u0628\u0647\u062A\u0631 \u067F\u064A\u0644",
  "camera.compareHint": "\u0633\u0644\u0627\u064A\u062F\u0631 \u06A9\u064A \u0687\u06AA\u064A\u0648 \u0645\u0642\u0627\u0628\u0644\u0648 \u06AA\u0631\u06BB \u0644\u0627\u0621\u0650",
  "camera.continue": "\u062C\u0627\u0631\u064A \u0631\u06A9\u0648",
  "studio.title": "\u062A\u0648\u06BE\u0627\u0646 \u062C\u064A \u062A\u0635\u0648\u064A\u0631 \u06A9\u064A \u0628\u06BE\u062A\u0631 \u0628\u0646\u0627\u064A\u0648",
  "studio.original": "\u0627\u0635\u0644",
  "studio.processed": "\u067E\u0631\u0648\u0633\u06CC\u0633 \u067F\u064A\u0644",
  "studio.removeBackground": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u062E\u062A\u0645 \u06AA\u0631\u064A\u0648",
  "studio.removingBackground": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u062E\u062A\u0645 \u06AA\u0631\u064A \u0631\u06BE\u064A\u0648 \u0622\u06BE\u064A\u2026",
  "studio.keepOriginalBackground": "\u0627\u0635\u0644 \u067E\u0633 \u0645\u0646\u0638\u0631 \u0631\u06A9\u0648",
  "studio.backgroundWhite": "\u0627\u0687\u0648",
  "studio.backgroundNeutral": "\u0646\u0631\u0645 \u06AA\u0631\u064A\u0645",
  "studio.backgroundBlur": "\u068C\u0646\u062F\u0644\u0648",
  "studio.backgroundUnavailableNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u062E\u062A\u0645 \u06AA\u0631\u06BB \u06BE\u0646 \u0648\u0642\u062A \u062F\u0633\u062A\u064A\u0627\u0628 \u0646\u0627\u06BE\u064A. \u062A\u0635\u0648\u064A\u0631 \u062A\u0628\u062F\u064A\u0644 \u0646\u0647 \u067F\u064A.",
  "studio.backgroundTimedOutNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u062E\u062A\u0645 \u06AA\u0631\u06BB \u06AF\u06BE\u06BB\u0648 \u0648\u0642\u062A \u0648\u067A\u064A \u0648\u064A\u0648 \u06FD \u0687\u068F\u064A \u068F\u0646\u0644. \u062A\u0635\u0648\u064A\u0631 \u062A\u0628\u062F\u064A\u0644 \u0646\u0647 \u067F\u064A.",
  "studio.backgroundQuotaNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u062E\u062A\u0645 \u06AA\u0631\u06BB \u062C\u064A \u062D\u062F \u06BE\u0646 \u0648\u0642\u062A \u067E\u0648\u0631\u064A \u067F\u064A \u0648\u0626\u064A. \u062A\u0635\u0648\u064A\u0631 \u062A\u0628\u062F\u064A\u0644 \u0646\u0647 \u067F\u064A.",
  "studio.backgroundFailedNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u062E\u062A\u0645 \u06AA\u0631\u06BB \u06FE \u0646\u0627\u06AA\u0627\u0645 \u067F\u064A\u0648. \u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u062A\u0635\u0648\u064A\u0631 \u06FE \u06AA\u0627 \u062A\u0628\u062F\u064A\u0644\u064A \u0646\u0647 \u0622\u0626\u064A.",
  "studio.brightness": "\u0631\u0648\u0634\u0646\u064A",
  "studio.contrast": "\u062A\u0636\u0627\u062F",
  "studio.sharpen": "\u062A\u064A\u0632",
  "studio.autoLighting": "\u062E\u0648\u062F\u06AA\u0627\u0631 \u0631\u0648\u0634\u0646\u064A",
  "studio.crop": "\u06AA\u067D",
  "studio.cropOriginal": "\u0627\u0635\u0644",
  "studio.cropSquare": "\u0686\u0648\u0631\u0633",
  "studio.cropPortrait": "\u067E\u0648\u0631\u067D\u0631\u064A\u067D",
  "studio.accept": "\u0647\u064A \u062A\u0635\u0648\u064A\u0631 \u0627\u0633\u062A\u0639\u0645\u0627\u0644 \u06AA\u0631\u064A\u0648",
  "studio.retake": "\u067B\u064A\u0647\u0631 \u06AA\u068D\u0648",
  "studio.finalizing": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0648\u0646 \u062A\u0631\u0645\u064A\u0645\u0646 \u0644\u0627\u06B3\u0648 \u06AA\u0631\u064A \u0631\u0647\u064A\u0627 \u0622\u0647\u064A\u0648\u0646...",
  "studio.on": "\u0686\u0627\u0644\u0648",
  "studio.off": "\u0628\u0646\u062F",
  "category.title": "\u062A\u0648\u0647\u0627\u0646 \u0687\u0627 \u0648\u06AA\u0631\u0648 \u06AA\u0631\u064A \u0631\u0647\u064A\u0627 \u0622\u0647\u064A\u0648\u061F",
  "category.continue": "\u062C\u0627\u0631\u064A \u0631\u06A9\u0648",
  "category.materialQuestion": "\u0627\u06BE\u0648 \u06AA\u06BE\u0699\u064A \u0634\u064A\u0621\u0650 \u0645\u0627\u0646 \u067A\u0647\u064A\u0644 \u0622\u06BE\u064A\u061F (\u0627\u062E\u062A\u064A\u0627\u0631\u064A)",
  "category.textiles": "\u06AA\u067E\u0699\u0627",
  "category.pottery": "\u0645\u067D\u064A\u0621\u064E \u062C\u0627 \u0628\u0631\u062A\u0646",
  "category.jewelry": "\u062C\u0648\u0627\u0647\u0631\u0627\u062A",
  "category.woodwork": "\u06AA\u067A \u062C\u0648 \u06AA\u0645",
  "category.bambooCane": "\u0628\u0627\u0646\u0633 \u06FD \u06AA\u064A\u06BB",
  "category.other": "\u067B\u064A\u0648",
  "voice.tapToRecord": "\u067E\u0646\u06BE\u0646\u062C\u064A \u067E\u0631\u0627\u068A\u06AA\u067D \u062C\u0648 \u062A\u0641\u0635\u064A\u0644 \u0631\u06AA\u0627\u0631\u068A \u06AA\u0631\u06BB \u0644\u0627\u0621\u0650 \u067D\u064A\u067E \u06AA\u0631\u064A\u0648",
  "voice.recording": "\u0631\u06AA\u0627\u0631\u068A\u0646\u06AF \u062C\u0627\u0631\u064A \u0622\u0647\u064A",
  "voice.stop": "\u0631\u06AA\u0627\u0631\u068A\u0646\u06AF \u0631\u0648\u06AA\u064A\u0648",
  "voice.record": "\u0631\u06AA\u0627\u0631\u068A \u06AA\u0631\u064A\u0648",
  "voice.reviewRecording": "\u067B\u064A\u0647\u0631 \u067B\u068C\u0648\u060C \u067E\u0648\u0621\u0650 \u062C\u0627\u0631\u064A \u0631\u06A9\u0648 \u064A\u0627 \u067B\u064A\u0647\u0631 \u0631\u06AA\u0627\u0631\u068A \u06AA\u0631\u064A\u0648",
  "voice.reRecord": "\u067B\u064A\u0647\u0631 \u0631\u06AA\u0627\u0631\u068A \u06AA\u0631\u064A\u0648",
  "voice.continue": "\u062C\u0627\u0631\u064A \u0631\u06A9\u0648",
  "describe.transcribing": "\u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u0648\u0636\u0627\u062D\u062A \u0633\u0645\u062C\u0647\u064A \u0631\u0647\u064A\u0648 \u0622\u0647\u064A...",
  "describe.transcribeError": "\u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u0648\u0636\u0627\u062D\u062A \u0633\u0645\u062C\u0647\u064A \u0646\u0647 \u0633\u06AF\u0647\u064A\u0648",
  "describe.retry": "\u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634",
  "describe.reviewHint": "\u062C\u0627\u0626\u0632\u0648 \u0648\u067A\u0648 \u06FD \u0636\u0631\u0648\u0631\u062A \u067E\u0648\u06BB \u062A\u064A \u062A\u0631\u0645\u064A\u0645",
  "describe.fallbackNote": "\u0645\u064A\u06AA\u0631\u0648\u0641\u0648\u0646 \u062F\u0633\u062A\u064A\u0627\u0628 \u0646\u0627\u0647\u064A\u060C \u0627\u0646 \u062C\u064A \u062C\u06B3\u0647\u0647 \u062A\u064A \u067E\u0646\u0647\u0646\u062C\u0648 \u0628\u064A\u0627\u0646 \u0644\u06A9\u0648.",
  "describe.placeholderEn": "\u067E\u0646\u0647\u0646\u062C\u064A \u067E\u0631\u0627\u068A\u06AA\u067D \u0627\u0646\u06AF\u0631\u064A\u0632\u064A \u06FE \u0628\u064A\u0627\u0646 \u06AA\u0631\u064A\u0648",
  "describe.continue": "\u062C\u0627\u0631\u064A \u0631\u06A9\u0648",
  "pricing.title": "\u067E\u0646\u0647\u0646\u062C\u064A \u067E\u0631\u0627\u068A\u06AA\u067D \u062C\u064A \u0642\u064A\u0645\u062A \u0645\u0642\u0631\u0631 \u06AA\u0631\u064A\u0648",
  "pricing.summaryEdit": "\u062A\u0628\u062F\u064A\u0644",
  "pricing.materialCostLabel": "\u0645\u0648\u0627\u062F \u062C\u0648 \u062E\u0631\u0686",
  "pricing.materialCostHelper": "\u0631\u0648 \u0645\u0627\u062F\u064A \u062A\u064A \u062E\u0631\u0686 \u06AA\u064A\u0644 \u0631\u0642\u0645 \u0631\u0648\u067E\u0646 \u06FE \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648.",
  "pricing.materialCostInvalid": "0 \u06A9\u0627\u0646 \u0648\u068F\u0648 \u0645\u0648\u0627\u062F \u062C\u0648 \u062E\u0631\u0686 \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648",
  "pricing.getSuggestion": "\u0642\u064A\u0645\u062A \u062C\u0648 \u062A\u062C\u0648\u064A\u0632 \u0648\u067A\u0648",
  "pricing.suggestError": "\u0642\u064A\u0645\u062A \u062C\u0648 \u062A\u062C\u0648\u064A\u0632 \u062D\u0627\u0635\u0644 \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A\u0648",
  "pricing.retry": "\u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634",
  "pricing.rangeLabel": "\u062A\u062C\u0648\u064A\u0632 \u06AA\u064A\u0644 \u0642\u064A\u0645\u062A \u062C\u0648 \u062F\u0627\u0626\u0631\u0648",
  "pricing.sellingPriceLabel": "\u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u0648\u06AA\u0631\u0648 \u0642\u064A\u0645\u062A",
  "pricing.sellingPriceNote": "\u0647\u064A \u0635\u0631\u0641 \u062A\u062C\u0648\u064A\u0632 \u0622\u0647\u064A\u060C \u062A\u0648\u0647\u0627\u0646 \u06AA\u0646\u0647\u0646 \u0628\u0647 \u0642\u064A\u0645\u062A \u0645\u0642\u0631\u0631 \u06AA\u0631\u064A \u0633\u06AF\u0647\u0648 \u067F\u0627.",
  "pricing.sellingPriceInvalid": "0 \u06A9\u0627\u0646 \u0648\u068F\u0648 \u0648\u06AA\u0631\u0648 \u0642\u064A\u0645\u062A \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648",
  "pricing.publish": "\u0627\u0634\u0627\u0639\u062A",
  "pricing.publishError": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0648 \u067E\u0631\u0627\u068A\u06AA\u067D \u0627\u0634\u0627\u0639\u062A \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A\u0648",
  "pricing.successTitle": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0648 \u067E\u0631\u0627\u068A\u06AA\u067D \u0644\u0627\u0626\u064A\u0648 \u0622\u0647\u064A!",
  "pricing.successMessage": "\u062E\u0631\u064A\u062F\u0627\u0631 \u0647\u0627\u06BB\u064A \u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u062F\u06AA\u0627\u0646 \u06FE \u0627\u0646 \u06A9\u064A \u06B3\u0648\u0644\u064A \u0633\u06AF\u0647\u0646 \u067F\u0627.",
  "pricing.viewShop": "\u0645\u0646\u0647\u0646\u062C\u064A \u062F\u06AA\u0627\u0646 \u06FE \u068F\u0633\u0648",
  "home.title": "\u0645\u0646\u0647\u0646\u062C\u0648 \u062F\u06AA\u0627\u0646",
  "home.gemBannerTitle": "GeM / ONDC \u0633\u0627\u0646 \u06B3\u0646\u068D\u064A\u0648",
  "home.gemBannerBadge": "\u062C\u0644\u062F\u064A \u0627\u064A\u0646\u062F\u0648",
  "home.gemBannerMessage": "\u0647\u064A \u0627\u0646\u0636\u0645\u0627\u0645 \u062C\u0644\u062F \u0627\u064A\u0646\u062F\u0648.",
  "home.loading": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0627 \u067E\u0631\u0627\u068A\u06AA\u067D \u0644\u0648\u068A \u067F\u064A \u0631\u0647\u064A\u0627 \u0622\u0647\u0646...",
  "home.loadError": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0627 \u067E\u0631\u0627\u068A\u06AA\u067D \u0644\u0648\u068A \u0646\u0647 \u067F\u064A \u0633\u06AF\u064A\u0627.",
  "home.retry": "\u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634",
  "home.emptyTitle": "\u0627\u0683\u0627 \u062A\u0627\u0626\u064A\u0646 \u06AA\u0627 \u067E\u0631\u0627\u068A\u06AA\u067D \u0646\u0627\u0647\u064A",
  "home.emptyMessage": "KalaSetu \u062A\u064A \u0648\u06AA\u0631\u0648 \u0634\u0631\u0648\u0639 \u06AA\u0631\u06BB \u0644\u0627\u0621\u0650 \u067E\u0646\u0647\u0646\u062C\u0648 \u067E\u0647\u0631\u064A\u0648\u0646 \u067E\u0631\u0627\u068A\u06AA\u067D \u0634\u0627\u0645\u0644 \u06AA\u0631\u064A\u0648.",
  "home.addFirstProduct": "\u067E\u0646\u0647\u0646\u062C\u0648 \u067E\u0647\u0631\u064A\u0648\u0646 \u067E\u0631\u0627\u068A\u06AA\u067D \u0634\u0627\u0645\u0644 \u06AA\u0631\u064A\u0648",
  "home.statusPublished": "\u0627\u0634\u0627\u0639\u062A \u067F\u064A\u0644",
  "home.statusDraft": "\u0645\u0633\u0648\u062F\u0648",
  "home.statusFailed": "\u0646\u0627\u06A9\u0627\u0645",
  "home.detailCategory": "\u06AA\u064A\u067D\u064A\u06AF\u0631\u064A",
  "home.detailEdit": "\u062A\u0628\u062F\u064A\u0644",
  "home.detailDelete": "\u062D\u0630\u0641",
  "home.detailClose": "\u0628\u0646\u062F",
  "home.editPriceLabel": "\u0642\u064A\u0645\u062A",
  "home.editDescriptionLabel": "\u062A\u0641\u0635\u064A\u0644",
  "home.editSave": "\u0645\u062D\u0641\u0648\u0638 \u06AA\u0631\u064A\u0648",
  "home.editCancel": "\u0645\u0646\u0633\u0648\u062E",
  "home.editPriceInvalid": "0 \u06A9\u0627\u0646 \u0648\u068F\u0648 \u0642\u064A\u0645\u062A \u062F\u0627\u062E\u0644 \u06AA\u0631\u064A\u0648",
  "home.editDescriptionRequired": "\u0647\u06AA \u067B\u0648\u0644\u064A\u0621\u064E \u06FE \u062A\u0641\u0635\u064A\u0644 \u062E\u0627\u0644\u064A \u0646\u0647 \u0647\u062C\u064A",
  "home.editError": "\u062A\u0628\u062F\u064A\u0644\u064A\u0646 \u06A9\u064A \u0645\u062D\u0641\u0648\u0638 \u0646\u0647 \u06AA\u0631\u064A \u0633\u06AF\u0647\u064A\u0648\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "home.deleteConfirm": "\u0687\u0627 \u062A\u0648\u0647\u0627\u0646 \u0647\u0646 \u067E\u0631\u0627\u068A\u06AA\u067D \u06A9\u064A \u062D\u0630\u0641 \u06AA\u0631\u06BB \u0686\u0627\u0647\u064A\u0648 \u067F\u0627\u061F \u0627\u0647\u0648 \u0648\u0627\u067E\u0633 \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u0646\u062F\u0648.",
  "home.deleteConfirmYes": "\u0647\u0627\u060C \u062D\u0630\u0641 \u06AA\u0631\u064A\u0648",
  "home.deleteError": "\u067E\u0631\u0627\u068A\u06AA\u067D \u062D\u0630\u0641 \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A\u0648\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "profile.title": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644",
  "profile.emailLabel": "\u0627\u064A \u0645\u064A\u0644 \u067E\u062A\u0648",
  "profile.emailUnknown": "\u0645\u062A\u0648\u0641\u0651\u0631 \u0646\u0627\u0647\u064A",
  "profile.loading": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0648 \u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0644\u0648\u068A \u067F\u064A \u0631\u0647\u064A\u0648 \u0622\u0647\u064A...",
  "profile.loadError": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0644\u0648\u068A \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A\u0648",
  "profile.displayNameLabel": "\u062A\u0648\u0647\u0627\u0646\u062C\u0648 \u0646\u0627\u0644\u0648",
  "profile.shopNameLabel": "\u062F\u0648\u06AA\u0627\u0646 \u062C\u0648 \u0646\u0627\u0644\u0648",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638 \u06AA\u0631\u064A\u0648",
  "profile.saved": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638 \u067F\u064A\u0648",
  "profile.saveError": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0648 \u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638 \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A\u0648\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "profile.logout": "\u0644\u0627\u06AF \u0622\u0626\u0648\u067D",
  "install.message": "\u062C\u0644\u062F\u064A \u0631\u0633\u0627\u0626\u064A \u0644\u0627\u0621\u0650 KalaSetu \u0627\u0646\u0633\u067D\u0627\u0644 \u06AA\u0631\u064A\u0648",
  "install.action": "\u0627\u0646\u0633\u067D\u0627\u0644",
  "install.dismiss": "\u0627\u0646\u06AA\u0627\u0631",
  "offline.message": "\u062A\u0648\u0647\u0627\u0646 \u0622\u0641 \u0644\u0627\u0626\u0646 \u0622\u0647\u064A\u0648\u060C \u06AA\u062C\u0647\u0647 \u062E\u0627\u0635\u064A\u062A\u0648\u0646 \u06AA\u0645 \u0646\u0647 \u06AA\u0646\u062F\u064A\u0648\u0646",
  "welcome.languageHint": "\u0633\u0684\u0648 \u0627\u064A\u067E \u0647\u0646 \u067B\u0648\u0644\u064A\u0621\u064E \u06FE \u0647\u0648\u0646\u062F\u0648.",
  "welcome.regionalLanguages": "\u0680\u0627\u0631\u062A \u062C\u0648\u0646 \u067B\u0648\u0644\u064A\u0648\u0646",
  "describe.localTab": "\u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u067B\u0648\u0644\u064A",
  "describe.placeholderLocal": "\u067E\u0646\u0647\u0646\u062C\u064A \u067B\u0648\u0644\u064A\u0621\u064E \u06FE \u067E\u0646\u0647\u0646\u062C\u064A \u067E\u0631\u0627\u068A\u06AA\u067D \u062C\u0648 \u0628\u064A\u0627\u0646 \u06AA\u0631\u064A\u0648",
  "describe.syncing": "\u067B\u064A \u067B\u0648\u0644\u064A \u0627\u067E\u068A\u064A\u067D \u067F\u064A \u0631\u0647\u064A \u0622\u0647\u064A...",
  "describe.syncFailed": "\u067B\u064A \u067B\u0648\u0644\u064A \u0627\u067E\u068A\u064A\u067D \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A. \u0636\u0631\u0648\u0631\u062A \u067E\u0648\u06BB \u062A\u064A \u067E\u0627\u06BB \u0626\u064A \u062A\u0631\u0645\u064A\u0645 \u06AA\u0631\u064A\u0648.",
  "describe.syncHint": "\u062A\u0631\u0645\u064A\u0645\u0648\u0646 \u067E\u0627\u06BB\u0645\u0631\u0627\u062F\u0648 \u067B\u064A \u067B\u0648\u0644\u064A\u0621\u064E \u06FE \u0646\u0642\u0644 \u067F\u064A\u0646\u062F\u064A\u0648\u0646.",
  "pricing.updating": "\u0646\u0626\u064A\u0646 \u0645\u0648\u0627\u062F \u062C\u064A \u0642\u064A\u0645\u062A \u0644\u0627\u0621\u0650 \u0627\u067E\u068A\u064A\u067D \u067F\u064A \u0631\u0647\u064A\u0648 \u0622\u0647\u064A...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "Export catalog (ONDC format)",
  "home.exportCatalogNote": "Downloads your published listings mapped to the ONDC retail catalog structure. Integration-ready: the mapping is done, going live on the network still requires ONDC registration.",
  "home.exportOndcSingle": "Export this product (ONDC format)",
  "profile.relocalising": "\u062A\u0648\u0647\u0627\u0646 \u062C\u0627 \u067E\u0631\u0627\u068A\u06AA\u067D\u0633 \u0647\u0646 \u067B\u0648\u0644\u064A\u0621\u064E \u06FE \u0627\u067E\u068A\u064A\u067D \u067F\u064A \u0631\u0647\u064A\u0627 \u0622\u0647\u0646...",
  "profile.relocalised": "{n} \u067E\u0631\u0627\u068A\u06AA\u067D\u0633 \u0647\u0646 \u067B\u0648\u0644\u064A\u0621\u064E \u06FE \u0627\u067E\u068A\u064A\u067D \u067F\u064A \u0648\u064A\u0627.",
  "profile.relocaliseFailed": "\u06AA\u062C\u0647\u0647 \u067E\u0631\u0627\u068A\u06AA\u067D\u0633 \u0627\u067E\u068A\u064A\u067D \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A\u0627. \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648.",
  "marketplace.navBrowse": "\u062F\u0631\u064A\u0627\u0641\u062A",
  "marketplace.navProfile": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644",
  "marketplace.browseTitle": "\u0645\u0627\u0631\u06AA\u064A\u067D",
  "marketplace.searchPlaceholder": "\u0645\u0635\u0646\u0648\u0639\u0627\u062A \u06B3\u0648\u0644\u064A\u0648...",
  "marketplace.filtersTitle": "\u0641\u0644\u067D\u0631\u0632",
  "marketplace.filtersClear": "\u0633\u0680 \u0635\u0627\u0641 \u06AA\u0631\u064A\u0648",
  "marketplace.filterAll": "\u0633\u0680",
  "marketplace.filterMaterial": "\u0645\u0648\u0627\u062F",
  "marketplace.filterRegion": "\u0639\u0644\u0627\u0642\u0648",
  "marketplace.filterPrice": "\u0642\u064A\u0645\u062A \u062C\u064A \u062D\u062F (\u20B9)",
  "marketplace.filterPriceMin": "\u0645\u0646",
  "marketplace.filterPriceMax": "\u0648\u068C",
  "marketplace.sortLabel": "\u062A\u0631\u062A\u064A\u0628",
  "marketplace.sortNewest": "\u0646\u0626\u0648\u0646 \u062A\u0631\u064A\u0646 \u067E\u0647\u0631\u064A\u0646",
  "marketplace.sortPriceAsc": "\u0642\u064A\u0645\u062A: \u06AF\u0647\u067D \u06A9\u0627\u0646 \u0648\u068C\u064A\u06AA",
  "marketplace.sortPriceDesc": "\u0642\u064A\u0645\u062A: \u0648\u068C\u064A\u06AA \u06A9\u0627\u0646 \u06AF\u0647\u067D",
  "marketplace.resultCount": "{n} \u0634\u064A\u0648\u0646 \u0645\u0644\u064A\u0627",
  "marketplace.loadMore": "\u0648\u068C\u064A\u06AA \u0644\u0648\u068A",
  "marketplace.loadError": "\u0645\u0627\u0631\u06AA\u064A\u067D \u0644\u0648\u068A \u0646\u0647 \u067F\u064A \u0633\u06AF\u0647\u064A\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "marketplace.emptyTitle": "\u06AA\u0648 \u0628\u0647 \u0634\u064A\u0648\u0646 \u0641\u0644\u067D\u0631\u0646 \u0633\u0627\u0646 \u0646\u0647 \u0645\u0644\u0646",
  "marketplace.emptyFiltered": "\u0641\u0644\u067D\u0631 \u0635\u0627\u0641 \u06AA\u0631\u064A\u0648 \u064A\u0627 \u067B\u064A\u0648 \u06B3\u0648\u0644\u064A\u0648.",
  "marketplace.emptyNoProducts": "\u0627\u0683\u0627 \u062A\u0627\u0626\u064A\u0646 \u06AA\u0648 \u0628\u0647 \u0634\u064A\u0648\u0646 \u0634\u0627\u064A\u0639 \u0646\u0647 \u067F\u064A\u0648. \u062C\u0644\u062F \u0648\u0627\u067E\u0633 \u068F\u0633\u0648.",
  "marketplace.artisanUnnamed": "KalaSetu \u06AA\u0627\u0631\u064A\u06AF\u0631",
  "marketplace.backToBrowse": "\u0645\u0627\u0631\u06AA\u064A\u067D \u062A\u064A \u0648\u0627\u067E\u0633",
  "marketplace.detailNotFoundTitle": "\u067E\u0631\u0648\u068A\u06AA\u067D \u0646\u0647 \u0645\u0644\u064A\u0648",
  "marketplace.detailNotFoundMessage": "\u0647\u064A \u067E\u0631\u0648\u068A\u06AA\u067D \u0634\u0627\u064A\u062F \u0647\u067D\u0627\u064A\u0648 \u0648\u064A\u0648 \u0622\u0647\u064A \u064A\u0627 \u0647\u0627\u06BB\u064A \u0645\u0648\u062C\u0648\u062F \u0646\u0627\u0647\u064A.",
  "marketplace.artisanSummaryTitle": "\u06AA\u0627\u0631\u06AF\u0631 \u0628\u0627\u0628\u062A",
  "marketplace.artisanProductCount": "{n} \u067E\u0631\u0648\u068A\u06AA\u067D\u0633 KalaSetu \u062A\u064A \u0644\u0633\u067D \u067F\u064A\u0644",
  "marketplace.inquiryTitle": "\u0647\u0646 \u067E\u0631\u0648\u068A\u06AA\u067D \u06FE \u062F\u0644\u0686\u0633\u067E\u064A \u0622\u0647\u064A\u061F",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u06AA\u0627\u0631\u06AF\u0631 \u06A9\u064A \u067B\u068C\u0627\u064A\u0648 \u062A\u0647 \u062A\u0648\u0647\u0627\u0646 \u0687\u0627 \u0686\u0627\u0647\u064A\u0648 \u067F\u0627: \u0645\u0642\u062F\u0627\u0631\u060C \u062D\u0633\u0628 \u0636\u0631\u0648\u0631\u062A\u060C \u067E\u0647\u0686\u0627\u0626\u06BB \u062C\u0648 \u0648\u0642\u062A...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0627\u0646\u06AA\u0648\u0627\u0626\u0631\u064A \u0645\u0648\u06AA\u0644\u0648",
  "marketplace.inquirySent": "\u062A\u0648\u0647\u0627\u0646 \u062C\u064A \u0627\u0646\u06AA\u0648\u0627\u0626\u0631\u064A \u0645\u0648\u06AA\u0644\u064A \u0648\u0626\u064A \u0622\u0647\u064A. \u06AA\u0627\u0631\u06AF\u0631 \u062A\u0648\u0647\u0627\u0646 \u0633\u0627\u0646 \u0631\u0627\u0628\u0637\u0648 \u06AA\u0646\u062F\u0648.",
  "marketplace.inquiryError": "\u0627\u0646\u06AA\u0648\u0627\u0626\u0631\u064A \u0645\u0648\u06AA\u0644\u06BB \u06FE \u0646\u0627\u06AA\u0627\u0645\u060C \u0645\u0647\u0631\u0628\u0627\u0646\u064A \u06AA\u0631\u064A \u067B\u064A\u0647\u0631 \u06AA\u0648\u0634\u0634 \u06AA\u0631\u064A\u0648",
  "marketplace.regionLabel": "\u0639\u0644\u0627\u0642\u0648",
  "marketplace.regionUnspecified": "\u0646\u0627\u0645\u0639\u0644\u0648\u0645",
  "marketplace.myInquiriesTitle": "\u0645\u0646\u0647\u0646\u062C\u0627 \u0627\u0633\u062A\u0641\u0633\u0627\u0631",
  "marketplace.inquiriesLoading": "\u062A\u0648\u06BE\u0627\u0646 \u062C\u0627 \u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0644\u0648\u068A \u067F\u064A \u0631\u06BE\u064A\u0627 \u0622\u06BE\u0646...",
  "marketplace.inquiriesLoadError": "\u062A\u0648\u06BE\u0627\u0646 \u062C\u0627 \u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0644\u0648\u068A \u0646\u06C1 \u067F\u064A \u0633\u06AF\u06BE\u064A\u0627",
  "marketplace.noInquiries": "\u062A\u0648\u06BE\u0627\u0646 \u0627\u0683\u0627 \u06AA\u0648 \u0628\u0647 \u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0646\u0647 \u0645\u0648\u06AA\u0644\u064A\u0648 \u0622\u06BE\u064A. \u0645\u0627\u0631\u06AA\u064A\u067D \u06FE \u06AF\u06BE\u0645\u064A\u0648 \u06FD \u0634\u064A\u0648\u0646 \u06B3\u0648\u0644\u064A\u0648.",
  "marketplace.inquiryProductRemoved": "\u06BE\u064A \u067E\u0631\u0627\u068A\u06AA\u067D \u06BE\u0627\u06BB\u064A \u062F\u0633\u062A\u064A\u0627\u0628 \u0646\u0627\u06BE\u064A",
  "marketplace.inquiryStatusOpen": "\u062C\u0648\u0627\u0628 \u062C\u064A \u0627\u0646\u062A\u0638\u0627\u0631",
  "marketplace.inquiryStatusClosed": "\u0628\u0646\u062F",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/ta.json
var ta_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B95\u0BC8\u0BB5\u0BBF\u0BA9\u0BC8\u0BAF\u0BC8 \u0B86\u0BA9\u0BCD\u0BB2\u0BC8\u0BA9\u0BBF\u0BB2\u0BCD \u0B8E\u0BB3\u0BBF\u0BA4\u0BBE\u0B95 \u0BB5\u0BBF\u0BB1\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD.",
  "welcome.languageLabel": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAE\u0BCA\u0BB4\u0BBF\u0BAF\u0BC8 \u0BA4\u0BC7\u0BB0\u0BCD\u0BA8\u0BCD\u0BA4\u0BC6\u0B9F\u0BC1\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "welcome.getStarted": "\u0BA4\u0BCA\u0B9F\u0B99\u0BCD\u0B95\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD",
  "language.en": "\u0B86\u0B99\u0BCD\u0B95\u0BBF\u0BB2\u0BAE\u0BCD",
  "language.hi": "\u0BB9\u0BBF\u0BA8\u0BCD\u0BA4\u0BBF",
  "email.title": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF\u0BAF\u0BC8 \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BB5\u0BC1\u0BAE\u0BCD",
  "email.roleQuestion": "\u0BA8\u0BBE\u0BA9\u0BCD \u0B87\u0B99\u0BCD\u0B95\u0BC7",
  "email.roleSell": "\u0B8E\u0BA9\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BC8 \u0BB5\u0BBF\u0BB1\u0BCD\u0B95",
  "email.roleBuy": "\u0B95\u0BC8\u0BB5\u0BBF\u0BA9\u0BC8 \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BC8 \u0BB5\u0BBE\u0B99\u0BCD\u0B95",
  "email.label": "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
  "email.helper": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BC8 \u0B89\u0BB1\u0BC1\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4 4 \u0B87\u0BB2\u0B95\u0BCD\u0B95\u0B95\u0BCD \u0B95\u0BC1\u0BB1\u0BBF\u0BAF\u0BC0\u0B9F\u0BCD\u0B9F\u0BC8 \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BBF\u0BB1\u0BCB\u0BAE\u0BCD.",
  "email.invalid": "\u0B9A\u0BB0\u0BBF\u0BAF\u0BBE\u0BA9 \u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF\u0BAF\u0BC8 \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BB5\u0BC1\u0BAE\u0BCD",
  "email.sendOtp": "\u0B95\u0BC1\u0BB1\u0BBF\u0BAF\u0BC0\u0B9F\u0BCD\u0B9F\u0BC8 \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1",
  "email.error": "\u0B95\u0BC1\u0BB1\u0BBF\u0BAF\u0BC0\u0B9F\u0BCD\u0B9F\u0BC8 \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "otp.title": "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BC8 \u0B89\u0BB1\u0BC1\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "otp.subtitle": "\u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F 4 \u0B87\u0BB2\u0B95\u0BCD\u0B95\u0B95\u0BCD \u0B95\u0BC1\u0BB1\u0BBF\u0BAF\u0BC0\u0B9F\u0BCD\u0B9F\u0BC8 \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BB5\u0BC1\u0BAE\u0BCD",
  "otp.emailUndelivered": "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BC8 \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8. \u0B9F\u0BC6\u0BAE\u0BCB \u0B95\u0BC1\u0BB1\u0BBF\u0BAF\u0BC0\u0B9F\u0BCD\u0B9F\u0BC1\u0B95\u0BCD\u0B95\u0BC1 \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B95\u0BC1\u0BB4\u0BC1\u0BB5\u0BC8 \u0BA4\u0BCA\u0B9F\u0BB0\u0BCD\u0BAA\u0BC1 \u0B95\u0BCA\u0BB3\u0BCD\u0BB3\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD.",
  "otp.changeEmail": "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BC8 \u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0BC1",
  "otp.verify": "\u0B89\u0BB1\u0BC1\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "otp.invalid": "\u0B8E\u0BB2\u0BCD\u0BB2\u0BBE 4 \u0B87\u0BB2\u0B95\u0BCD\u0B95\u0B99\u0BCD\u0B95\u0BB3\u0BC8\u0BAF\u0BC1\u0BAE\u0BCD \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BB5\u0BC1\u0BAE\u0BCD",
  "otp.wrong": "\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 OTP, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "otp.resend": "OTP-\u0B90 \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1",
  "otp.resendIn": "OTP-\u0B90 {n}s-\u0BB2\u0BCD \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1",
  "otp.resendError": "OTP-\u0B90 \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "camera.capture": "\u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0B8E\u0B9F\u0BC1",
  "camera.unavailable": "\u0B95\u0BC7\u0BAE\u0BB0\u0BBE \u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0BA4\u0BC7\u0BB0\u0BCD\u0BB5\u0BC1 \u0B9A\u0BC6\u0BAF\u0BCD\u0BAF\u0BB5\u0BC1\u0BAE\u0BCD",
  "camera.choosePhoto": "\u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0BA4\u0BC7\u0BB0\u0BCD\u0BA8\u0BCD\u0BA4\u0BC6\u0B9F\u0BC1",
  "camera.retake": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0B8E\u0B9F\u0BC1",
  "camera.usePhoto": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0BAA\u0BAF\u0BA9\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "camera.enhancing": "\u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BA4\u0BCD\u0BA4\u0BC8 \u0BAE\u0BC7\u0BAE\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "camera.enhanceError": "\u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BA4\u0BCD\u0BA4\u0BC8 \u0BAE\u0BC7\u0BAE\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "camera.retry": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF",
  "camera.before": "\u0BAE\u0BC2\u0BB2",
  "camera.after": "\u0BAE\u0BC7\u0BAE\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1",
  "camera.compareHint": "\u0B92\u0BAA\u0BCD\u0BAA\u0BBF\u0B9F \u0BB8\u0BCD\u0BB2\u0BC8\u0B9F\u0BB0\u0BC8 \u0B87\u0BB4\u0BC1\u0B95\u0BCD\u0B95",
  "camera.continue": "\u0BA4\u0BCA\u0B9F\u0BB0\u0BCD\u0B95",
  "studio.title": "\u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BA4\u0BCD\u0BA4\u0BC8 \u0BAE\u0BC7\u0BAE\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "studio.original": "\u0BAE\u0BC2\u0BB2",
  "studio.processed": "\u0B9A\u0BC6\u0BAF\u0BB2\u0BBE\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1",
  "studio.removeBackground": "\u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BA3\u0BBF \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BC1",
  "studio.removingBackground": "\u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BA3\u0BBF \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "studio.keepOriginalBackground": "\u0BAE\u0BC2\u0BB2 \u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BA3\u0BBF\u0BAF\u0BC8 \u0BB5\u0BC8\u0BA4\u0BCD\u0BA4\u0BBF\u0BB0\u0BC1",
  "studio.backgroundWhite": "\u0BB5\u0BC6\u0BB3\u0BCD\u0BB3\u0BC8",
  "studio.backgroundNeutral": "\u0BAE\u0BC6\u0BA9\u0BCD\u0BAE\u0BC8\u0BAF\u0BBE\u0BA9 \u0B95\u0BBF\u0BB0\u0BC0\u0BAE\u0BCD",
  "studio.backgroundBlur": "\u0BAE\u0B99\u0BCD\u0B95\u0BB2\u0BBE\u0B95\u0BCD\u0B95\u0BC1",
  "studio.backgroundUnavailableNotice": "\u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BA3\u0BBF \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BAE\u0BCD \u0BA4\u0BB1\u0BCD\u0BAA\u0BCB\u0BA4\u0BC1 \u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8. \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0BAE\u0BBF\u0BB2\u0BCD\u0BB2\u0BBE\u0BAE\u0BB2\u0BCD \u0B89\u0BB3\u0BCD\u0BB3\u0BA4\u0BC1.",
  "studio.backgroundTimedOutNotice": "\u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BA3\u0BBF \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BA4\u0BCD\u0BA4\u0BBF\u0BB1\u0BCD\u0B95\u0BC1 \u0B85\u0BA4\u0BBF\u0B95 \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD \u0B8E\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BA4\u0BBE\u0BB2\u0BCD \u0BA4\u0BB5\u0BBF\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1. \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0BAE\u0BBF\u0BB2\u0BCD\u0BB2\u0BBE\u0BAE\u0BB2\u0BCD \u0B89\u0BB3\u0BCD\u0BB3\u0BA4\u0BC1.",
  "studio.backgroundQuotaNotice": "\u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BA3\u0BBF \u0BA8\u0BC0\u0B95\u0BCD\u0B95 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1 \u0BA4\u0BB1\u0BCD\u0BAA\u0BCB\u0BA4\u0BC1 \u0BAE\u0BC1\u0B9F\u0BBF\u0BA8\u0BCD\u0BA4\u0BA4\u0BC1. \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0BAE\u0BBF\u0BB2\u0BCD\u0BB2\u0BBE\u0BAE\u0BB2\u0BCD \u0B89\u0BB3\u0BCD\u0BB3\u0BA4\u0BC1.",
  "studio.backgroundFailedNotice": "\u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BA3\u0BBF \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BAE\u0BCD \u0BA4\u0BCB\u0BB2\u0BCD\u0BB5\u0BBF\u0BAF\u0BC1\u0BB1\u0BCD\u0BB1\u0BA4\u0BC1. \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD \u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8.",
  "studio.brightness": "\u0B92\u0BB3\u0BBF\u0BB0\u0BCD\u0BB5\u0BC1",
  "studio.contrast": "\u0BAE\u0BBE\u0BB1\u0BC1\u0BAA\u0BBE\u0B9F\u0BC1",
  "studio.sharpen": "\u0BAE\u0BC1\u0BA9\u0BC8\u0BAA\u0BCD\u0BAA\u0BC1",
  "studio.autoLighting": "\u0BA4\u0BBE\u0BA9\u0BBF\u0BAF\u0B99\u0BCD\u0B95\u0BBF \u0B92\u0BB3\u0BBF",
  "studio.crop": "\u0BB5\u0BC6\u0B9F\u0BCD\u0B9F\u0BC1\u0B95",
  "studio.cropOriginal": "\u0B85\u0B9A\u0BB2\u0BCD",
  "studio.cropSquare": "\u0B9A\u0BA4\u0BC1\u0BB0\u0BAE\u0BCD",
  "studio.cropPortrait": "\u0BA8\u0BBF\u0BB2\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BAE\u0BCD",
  "studio.accept": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BAA\u0BC1\u0B95\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BA4\u0BCD\u0BA4\u0BC8 \u0BAA\u0BAF\u0BA9\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BB5\u0BC1\u0BAE\u0BCD",
  "studio.retake": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0B8E\u0B9F\u0BC1\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "studio.finalizing": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BBF\u0BB0\u0BC1\u0BA4\u0BCD\u0BA4\u0B99\u0BCD\u0B95\u0BB3\u0BC8\u0BAA\u0BCD \u0BAA\u0BAF\u0BA9\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "studio.on": "\u0B86\u0BA9\u0BCD",
  "studio.off": "\u0B86\u0B83\u0BAA\u0BCD",
  "category.title": "\u0BA8\u0BC0\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B8E\u0BA9\u0BCD\u0BA9 \u0BB5\u0BBF\u0BB1\u0BCD\u0B95\u0BBF\u0BB1\u0BC0\u0BB0\u0BCD\u0B95\u0BB3\u0BCD?",
  "category.continue": "\u0BA4\u0BCA\u0B9F\u0BB0\u0BCD\u0B95",
  "category.materialQuestion": "\u0B87\u0BA4\u0BC1 \u0B8E\u0BA4\u0BA9\u0BBE\u0BB2\u0BCD \u0B9A\u0BC6\u0BAF\u0BCD\u0BAF\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1? (\u0BB5\u0BBF\u0BB0\u0BC1\u0BAA\u0BCD\u0BAA\u0BAE\u0BCD)",
  "category.textiles": "\u0BA8\u0BC6\u0BAF\u0BCD\u0BA4\u0BBF\u0B95\u0BB3\u0BCD",
  "category.pottery": "\u0BAE\u0B9F\u0BCD\u0BAA\u0BBE\u0BA3\u0BCD\u0B9F\u0BAE\u0BCD",
  "category.jewelry": "\u0BA8\u0B95\u0BC8\u0B95\u0BB3\u0BCD",
  "category.woodwork": "\u0BAE\u0BB0\u0B95\u0BCD \u0B95\u0BB2\u0BC8",
  "category.bambooCane": "\u0BAE\u0BC2\u0B99\u0BCD\u0B95\u0BBF\u0BB2\u0BCD \u0BAE\u0BB1\u0BCD\u0BB1\u0BC1\u0BAE\u0BCD \u0BAA\u0BBF\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1",
  "category.other": "\u0BAE\u0BB1\u0BCD\u0BB1\u0BB5\u0BC8",
  "voice.tapToRecord": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BBF\u0BA9\u0BCD \u0BB5\u0BBF\u0BB3\u0B95\u0BCD\u0B95\u0BA4\u0BCD\u0BA4\u0BC8 \u0BAA\u0BA4\u0BBF\u0BB5\u0BC1 \u0B9A\u0BC6\u0BAF\u0BCD\u0BAF\u0BA4\u0BCD \u0BA4\u0B9F\u0BCD\u0B9F\u0BB5\u0BC1\u0BAE\u0BCD",
  "voice.recording": "\u0BAA\u0BA4\u0BBF\u0BB5\u0BBE\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "voice.stop": "\u0BAA\u0BA4\u0BBF\u0BB5\u0BC8 \u0BA8\u0BBF\u0BB1\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "voice.record": "\u0BAA\u0BA4\u0BBF\u0BB5\u0BC1",
  "voice.reviewRecording": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0B95\u0BC7\u0B9F\u0BCD\u0B9F\u0BC1, \u0BA4\u0BCA\u0B9F\u0BB0\u0BB5\u0BC1\u0BAE\u0BCD \u0B85\u0BB2\u0BCD\u0BB2\u0BA4\u0BC1 \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAA\u0BA4\u0BBF\u0BB5\u0BC1 \u0B9A\u0BC6\u0BAF\u0BCD\u0BAF\u0BB5\u0BC1\u0BAE\u0BCD.",
  "voice.reRecord": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAA\u0BA4\u0BBF\u0BB5\u0BC1",
  "voice.continue": "\u0BA4\u0BCA\u0B9F\u0BB0\u0BB5\u0BC1\u0BAE\u0BCD",
  "describe.transcribing": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0BB3\u0B95\u0BCD\u0B95\u0BA4\u0BCD\u0BA4\u0BC8 \u0BAA\u0BC1\u0BB0\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0B95\u0BCA\u0BB3\u0BCD\u0B95\u0BBF\u0BB1\u0BCB\u0BAE\u0BCD...",
  "describe.transcribeError": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0BB3\u0B95\u0BCD\u0B95\u0BA4\u0BCD\u0BA4\u0BC8\u0BAA\u0BCD \u0BAA\u0BC1\u0BB0\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0B95\u0BCA\u0BB3\u0BCD\u0BB3 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "describe.retry": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF",
  "describe.reviewHint": "\u0BA4\u0BC7\u0BB5\u0BC8\u0BAF\u0BC6\u0BA9\u0BBF\u0BB2\u0BCD \u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BBE\u0BAF\u0BCD\u0BB5\u0BC1 \u0B9A\u0BC6\u0BAF\u0BCD\u0BA4\u0BC1 \u0BA4\u0BBF\u0BB0\u0BC1\u0BA4\u0BCD\u0BA4\u0BB5\u0BC1\u0BAE\u0BCD",
  "describe.fallbackNote": "\u0BAE\u0BC8\u0B95\u0BCD\u0BB0\u0BCB\u0B83\u0BAA\u0BCB\u0BA9\u0BCD \u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAA\u0BA4\u0BBF\u0BB2\u0BBE\u0B95 \u0BA4\u0B9F\u0BCD\u0B9F\u0B9A\u0BCD\u0B9A\u0BC1 \u0B9A\u0BC6\u0BAF\u0BCD\u0BAF\u0BB5\u0BC1\u0BAE\u0BCD",
  "describe.placeholderEn": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0B86\u0B99\u0BCD\u0B95\u0BBF\u0BB2\u0BA4\u0BCD\u0BA4\u0BBF\u0BB2\u0BCD \u0BB5\u0BBF\u0BB5\u0BB0\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "describe.continue": "\u0BA4\u0BCA\u0B9F\u0BB0\u0BB5\u0BC1\u0BAE\u0BCD",
  "pricing.title": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BBF\u0BA9\u0BCD \u0BB5\u0BBF\u0BB2\u0BC8\u0BAF\u0BC8 \u0BA8\u0BBF\u0BB0\u0BCD\u0BA3\u0BAF\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "pricing.summaryEdit": "\u0BA4\u0BBF\u0BB0\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "pricing.materialCostLabel": "\u0BAA\u0BCA\u0BB0\u0BC1\u0BB3\u0BCD \u0B9A\u0BC6\u0BB2\u0BB5\u0BC1",
  "pricing.materialCostHelper": "\u0BB0\u0BC2\u0BAA\u0BBE\u0BAF\u0BCD\u0B95\u0BB3\u0BBF\u0BB2\u0BCD, \u0BAE\u0BC2\u0BB2\u0BAA\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BC1\u0B95\u0BCD\u0B95\u0BC1 \u0BA8\u0BC0\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B9A\u0BC6\u0BB2\u0BB5\u0BBF\u0B9F\u0BCD\u0B9F\u0BA4\u0BC8 \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD.",
  "pricing.materialCostInvalid": "0-\u0B95\u0BCD\u0B95\u0BC1 \u0BAE\u0BC7\u0BB1\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F \u0BAA\u0BCA\u0BB0\u0BC1\u0BB3\u0BCD \u0B9A\u0BC6\u0BB2\u0BB5\u0BC8 \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD.",
  "pricing.getSuggestion": "\u0BB5\u0BBF\u0BB2\u0BC8 \u0BAA\u0BB0\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0BB0\u0BC8\u0BAF\u0BC8 \u0BAA\u0BC6\u0BB1\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD",
  "pricing.suggestError": "\u0BB5\u0BBF\u0BB2\u0BC8 \u0BAA\u0BB0\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0BB0\u0BC8\u0BAF\u0BC8 \u0BAA\u0BC6\u0BB1 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "pricing.retry": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF",
  "pricing.rangeLabel": "\u0BAA\u0BB0\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0BB0\u0BC8\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F \u0BB5\u0BBF\u0BB2\u0BC8 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1",
  "pricing.sellingPriceLabel": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0BB1\u0BCD\u0BAA\u0BA9\u0BC8 \u0BB5\u0BBF\u0BB2\u0BC8",
  "pricing.sellingPriceNote": "\u0B87\u0BA4\u0BC1 \u0B92\u0BB0\u0BC1 \u0BAA\u0BB0\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0BB0\u0BC8; \u0BA8\u0BC0\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0BB0\u0BC1\u0BAE\u0BCD\u0BAA\u0BC1\u0BAE\u0BCD \u0B8E\u0BA8\u0BCD\u0BA4 \u0BB5\u0BBF\u0BB2\u0BC8\u0BAF\u0BC8\u0BAF\u0BC1\u0BAE\u0BCD \u0B85\u0BAE\u0BC8\u0B95\u0BCD\u0B95\u0BB2\u0BBE\u0BAE\u0BCD.",
  "pricing.sellingPriceInvalid": "0-\u0B95\u0BCD\u0B95\u0BC1 \u0BAE\u0BC7\u0BB1\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F \u0BB5\u0BBF\u0BB1\u0BCD\u0BAA\u0BA9\u0BC8 \u0BB5\u0BBF\u0BB2\u0BC8\u0BAF\u0BC8 \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD.",
  "pricing.publish": "\u0BB5\u0BC6\u0BB3\u0BBF\u0BAF\u0BBF\u0B9F\u0BC1",
  "pricing.publishError": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0BB5\u0BC6\u0BB3\u0BBF\u0BAF\u0BBF\u0B9F \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "pricing.successTitle": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1 \u0B86\u0BA9\u0BCD\u0BB2\u0BC8\u0BA9\u0BBF\u0BB2\u0BCD \u0B89\u0BB3\u0BCD\u0BB3\u0BA4\u0BC1!",
  "pricing.successMessage": "\u0BB5\u0BBE\u0B99\u0BCD\u0B95\u0BC1\u0BAA\u0BB5\u0BB0\u0BCD\u0B95\u0BB3\u0BCD \u0B87\u0BAA\u0BCD\u0BAA\u0BCB\u0BA4\u0BC1 \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B95\u0B9F\u0BC8\u0BAF\u0BBF\u0BB2\u0BCD \u0B87\u0BA4\u0BC8 \u0B95\u0BBE\u0BA3\u0BB2\u0BBE\u0BAE\u0BCD.",
  "pricing.viewShop": "\u0B8E\u0BA9\u0BCD \u0B95\u0B9F\u0BC8\u0BAF\u0BBF\u0BB2\u0BCD \u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95",
  "home.title": "\u0B8E\u0BA9\u0BCD \u0B95\u0B9F\u0BC8",
  "home.gemBannerTitle": "GeM / ONDC-\u0B95\u0BCD\u0B95\u0BC1 \u0B87\u0BA3\u0BC8\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "home.gemBannerBadge": "\u0BB5\u0BBF\u0BB0\u0BC8\u0BB5\u0BBF\u0BB2\u0BCD",
  "home.gemBannerMessage": "\u0B87\u0BA8\u0BCD\u0BA4 \u0B87\u0BA3\u0BC8\u0BAA\u0BCD\u0BAA\u0BC1 \u0BB5\u0BBF\u0BB0\u0BC8\u0BB5\u0BBF\u0BB2\u0BCD \u0BB5\u0BB0\u0BC1\u0BAE\u0BCD.",
  "home.loading": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "home.loadError": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "home.retry": "\u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF",
  "home.emptyTitle": "\u0B87\u0BA9\u0BCD\u0BA9\u0BC1\u0BAE\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BCD \u0B87\u0BB2\u0BCD\u0BB2\u0BC8",
  "home.emptyMessage": "KalaSetu-\u0BB2\u0BCD \u0BB5\u0BBF\u0BB1\u0BCD\u0B95\u0BA4\u0BCD \u0BA4\u0BCA\u0B9F\u0B99\u0BCD\u0B95 \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAE\u0BC1\u0BA4\u0BB2\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0B9A\u0BC7\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD.",
  "home.addFirstProduct": "\u0BAE\u0BC1\u0BA4\u0BB2\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0B9A\u0BC7\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "home.statusPublished": "\u0BB5\u0BC6\u0BB3\u0BBF\u0BAF\u0BBF\u0B9F\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1",
  "home.statusDraft": "\u0BB5\u0BB0\u0BC8\u0BB5\u0BC1",
  "home.statusFailed": "\u0BA4\u0BCB\u0BB2\u0BCD\u0BB5\u0BBF",
  "home.detailCategory": "\u0BB5\u0B95\u0BC8",
  "home.detailEdit": "\u0BA4\u0BBF\u0BB0\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "home.detailDelete": "\u0B85\u0BB4\u0BBF",
  "home.detailClose": "\u0BAE\u0BC2\u0B9F\u0BC1",
  "home.editPriceLabel": "\u0BB5\u0BBF\u0BB2\u0BC8",
  "home.editDescriptionLabel": "\u0BB5\u0BBF\u0BB3\u0B95\u0BCD\u0B95\u0BAE\u0BCD",
  "home.editSave": "\u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0B99\u0BCD\u0B95\u0BB3\u0BC8 \u0B9A\u0BC7\u0BAE\u0BBF",
  "home.editCancel": "\u0BB0\u0BA4\u0BCD\u0BA4\u0BC1",
  "home.editPriceInvalid": "0-\u0B90 \u0BB5\u0BBF\u0B9F \u0B85\u0BA4\u0BBF\u0B95\u0BAE\u0BBE\u0BA9 \u0BB5\u0BBF\u0BB2\u0BC8\u0BAF\u0BC8 \u0B89\u0BB3\u0BCD\u0BB3\u0BBF\u0B9F\u0BB5\u0BC1\u0BAE\u0BCD",
  "home.editDescriptionRequired": "\u0BB5\u0BBF\u0BB3\u0B95\u0BCD\u0B95\u0BAE\u0BCD \u0B87\u0BB0\u0BC1 \u0BAE\u0BCA\u0BB4\u0BBF\u0B95\u0BB3\u0BBF\u0BB2\u0BC1\u0BAE\u0BCD \u0B95\u0BBE\u0BB2\u0BBF\u0BAF\u0BBE\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0B95\u0BCD \u0B95\u0BC2\u0B9F\u0BBE\u0BA4\u0BC1",
  "home.editError": "\u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0B99\u0BCD\u0B95\u0BB3\u0BC8 \u0B9A\u0BC7\u0BAE\u0BBF\u0B95\u0BCD\u0B95 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "home.deleteConfirm": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BB5\u0BBE? \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0B9A\u0BC6\u0BAF\u0BCD\u0BAF \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BBE\u0BA4\u0BC1.",
  "home.deleteConfirmYes": "\u0B86\u0BAE\u0BCD, \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BC1",
  "home.deleteError": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0BA8\u0BC0\u0B95\u0BCD\u0B95 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "profile.title": "\u0B9A\u0BC1\u0BAF\u0BB5\u0BBF\u0BB5\u0BB0\u0BAE\u0BCD",
  "profile.emailLabel": "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
  "profile.emailUnknown": "\u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "profile.loading": "\u0B9A\u0BC1\u0BAF\u0BB5\u0BBF\u0BB5\u0BB0\u0BA4\u0BCD\u0BA4\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "profile.loadError": "\u0B9A\u0BC1\u0BAF\u0BB5\u0BBF\u0BB5\u0BB0\u0BA4\u0BCD\u0BA4\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "profile.displayNameLabel": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAA\u0BC6\u0BAF\u0BB0\u0BCD",
  "profile.shopNameLabel": "\u0B95\u0B9F\u0BC8 \u0BAA\u0BC6\u0BAF\u0BB0\u0BCD",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u0B9A\u0BC1\u0BAF\u0BB5\u0BBF\u0BB5\u0BB0\u0BA4\u0BCD\u0BA4\u0BC8 \u0B9A\u0BC7\u0BAE\u0BBF",
  "profile.saved": "\u0B9A\u0BC1\u0BAF\u0BB5\u0BBF\u0BB5\u0BB0\u0BAE\u0BCD \u0B9A\u0BC7\u0BAE\u0BBF\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1",
  "profile.saveError": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B9A\u0BC1\u0BAF\u0BB5\u0BBF\u0BB5\u0BB0\u0BA4\u0BCD\u0BA4\u0BC8 \u0B9A\u0BC7\u0BAE\u0BBF\u0B95\u0BCD\u0B95 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "profile.logout": "\u0BB5\u0BC6\u0BB3\u0BBF\u0BAF\u0BC7\u0BB1\u0BC1",
  "install.message": "\u0BB5\u0BBF\u0BB0\u0BC8\u0BB5\u0BBE\u0B95 \u0B85\u0BA3\u0BC1\u0B95 KalaSetu-\u0B90 \u0BA8\u0BBF\u0BB1\u0BC1\u0BB5\u0BC1",
  "install.action": "\u0BA8\u0BBF\u0BB1\u0BC1\u0BB5\u0BC1",
  "install.dismiss": "\u0BAE\u0BB1\u0BC8",
  "offline.message": "\u0BA8\u0BC0\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B86\u0B83\u0BAA\u0BCD\u0BB2\u0BC8\u0BA9\u0BBF\u0BB2\u0BCD \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0BB0\u0BCD\u0B95\u0BB3\u0BCD, \u0B9A\u0BBF\u0BB2 \u0B85\u0BAE\u0BCD\u0B9A\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BC7\u0BB2\u0BC8 \u0B9A\u0BC6\u0BAF\u0BCD\u0BAF\u0BBE\u0BAE\u0BB2\u0BCD \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BB2\u0BBE\u0BAE\u0BCD",
  "welcome.languageHint": "\u0BAE\u0BC1\u0BB4\u0BC1 \u0BAA\u0BAF\u0BA9\u0BCD\u0BAA\u0BBE\u0B9F\u0BC1 \u0B87\u0BA8\u0BCD\u0BA4 \u0BAE\u0BCA\u0BB4\u0BBF\u0BAF\u0BBF\u0BB2\u0BCD \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BC1\u0BAE\u0BCD.",
  "welcome.regionalLanguages": "\u0B87\u0BA8\u0BCD\u0BA4\u0BBF\u0BAF \u0BAE\u0BCA\u0BB4\u0BBF\u0B95\u0BB3\u0BCD",
  "describe.localTab": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAE\u0BCA\u0BB4\u0BBF",
  "describe.placeholderLocal": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B9A\u0BCA\u0BA8\u0BCD\u0BA4 \u0BAE\u0BCA\u0BB4\u0BBF\u0BAF\u0BBF\u0BB2\u0BCD \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0BB5\u0BBF\u0BB5\u0BB0\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "describe.syncing": "\u0BAE\u0BB1\u0BCD\u0BB1 \u0BAE\u0BCA\u0BB4\u0BBF\u0BAF\u0BC8\u0BAA\u0BCD \u0BAA\u0BC1\u0BA4\u0BC1\u0BAA\u0BCD\u0BAA\u0BBF\u0B95\u0BCD\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "describe.syncFailed": "\u0BAE\u0BB1\u0BCD\u0BB1 \u0BAE\u0BCA\u0BB4\u0BBF\u0BAF\u0BC8\u0BAA\u0BCD \u0BAA\u0BC1\u0BA4\u0BC1\u0BAA\u0BCD\u0BAA\u0BBF\u0B95\u0BCD\u0B95 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8. \u0BA4\u0BC7\u0BB5\u0BC8\u0BAF\u0BC6\u0BA9\u0BBF\u0BB2\u0BCD \u0B85\u0BA4\u0BC8\u0BA4\u0BCD \u0BA4\u0BBE\u0BA9\u0BC7 \u0BA4\u0BBF\u0BB0\u0BC1\u0BA4\u0BCD\u0BA4\u0BB5\u0BC1\u0BAE\u0BCD.",
  "describe.syncHint": "\u0BA4\u0BBF\u0BB0\u0BC1\u0BA4\u0BCD\u0BA4\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BAE\u0BB1\u0BCD\u0BB1 \u0BAE\u0BCA\u0BB4\u0BBF\u0B95\u0BCD\u0B95\u0BC1 \u0BA4\u0BBE\u0BA9\u0BBE\u0B95 \u0BA8\u0B95\u0BB2\u0BC6\u0B9F\u0BC1\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0BAE\u0BCD.",
  "pricing.updating": "\u0BAA\u0BC1\u0BA4\u0BBF\u0BAF \u0BAA\u0BCA\u0BB0\u0BC1\u0BB3\u0BCD \u0B9A\u0BC6\u0BB2\u0BB5\u0BC1\u0B95\u0BCD\u0B95\u0BBE\u0B95 \u0BAA\u0BC1\u0BA4\u0BC1\u0BAA\u0BCD\u0BAA\u0BBF\u0B95\u0BCD\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0BAA\u0B9F\u0BCD\u0B9F\u0BBF\u0BAF\u0BB2\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1\u0BC1\u0BAE\u0BA4\u0BBF (ONDC \u0BB5\u0B9F\u0BBF\u0BB5\u0BAE\u0BCD)",
  "home.exportCatalogNote": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BC6\u0BB3\u0BBF\u0BAF\u0BBF\u0B9F\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F \u0BAA\u0B9F\u0BCD\u0B9F\u0BBF\u0BAF\u0BB2\u0BCD\u0B95\u0BB3\u0BC8 ONDC \u0BB5\u0BBF\u0BB1\u0BCD\u0BAA\u0BA9\u0BC8 \u0BAA\u0B9F\u0BCD\u0B9F\u0BBF\u0BAF\u0BB2\u0BCD \u0B85\u0BAE\u0BC8\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BCD\u0B95\u0BC1 \u0B92\u0BA4\u0BCD\u0BA4\u0BBF\u0B9A\u0BC8\u0BA4\u0BCD\u0BA4\u0BC1 \u0BAA\u0BA4\u0BBF\u0BB5\u0BBF\u0BB1\u0B95\u0BCD\u0B95\u0BAE\u0BCD \u0B9A\u0BC6\u0BAF\u0BCD\u0B95\u0BBF\u0BB1\u0BA4\u0BC1. \u0B92\u0BB0\u0BC1\u0B99\u0BCD\u0B95\u0BBF\u0BA3\u0BC8\u0BAA\u0BCD\u0BAA\u0BC1 \u0BA4\u0BAF\u0BBE\u0BB0\u0BBE\u0B95 \u0B89\u0BB3\u0BCD\u0BB3\u0BA4\u0BC1: \u0BB5\u0BB0\u0BC8\u0BAA\u0B9F\u0BAE\u0BCD \u0BAE\u0BC1\u0B9F\u0BBF\u0BA8\u0BCD\u0BA4\u0BA4\u0BC1, \u0BA8\u0BC6\u0B9F\u0BCD\u0BB5\u0BCA\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BBF\u0BB2\u0BCD \u0B9A\u0BC6\u0BAF\u0BB2\u0BCD\u0BAA\u0B9F ONDC \u0BAA\u0BA4\u0BBF\u0BB5\u0BC1 \u0BA4\u0BC7\u0BB5\u0BC8.",
  "home.exportOndcSingle": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1\u0BC1\u0BAE\u0BA4\u0BBF (ONDC \u0BB5\u0B9F\u0BBF\u0BB5\u0BAE\u0BCD)",
  "profile.relocalising": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BC8 \u0B87\u0BA8\u0BCD\u0BA4 \u0BAE\u0BCA\u0BB4\u0BBF\u0B95\u0BCD\u0B95\u0BC1 \u0BAA\u0BC1\u0BA4\u0BC1\u0BAA\u0BCD\u0BAA\u0BBF\u0B95\u0BCD\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "profile.relocalised": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BAE\u0BCA\u0BB4\u0BBF\u0B95\u0BCD\u0B95\u0BC1 {n} \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD \u0BAA\u0BC1\u0BA4\u0BC1\u0BAA\u0BCD\u0BAA\u0BBF\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA9.",
  "profile.relocaliseFailed": "\u0B9A\u0BBF\u0BB2 \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BC8 \u0BAA\u0BC1\u0BA4\u0BC1\u0BAA\u0BCD\u0BAA\u0BBF\u0B95\u0BCD\u0B95 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8. \u0BAA\u0BBF\u0BA9\u0BCD\u0BA9\u0BB0\u0BCD \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD.",
  "marketplace.navBrowse": "\u0B89\u0BB2\u0BBE\u0BB5\u0BC1",
  "marketplace.navProfile": "\u0B9A\u0BC1\u0BAF\u0BB5\u0BBF\u0BB5\u0BB0\u0BAE\u0BCD",
  "marketplace.browseTitle": "\u0B9A\u0BA8\u0BCD\u0BA4\u0BC8",
  "marketplace.searchPlaceholder": "\u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BC8 \u0BA4\u0BC7\u0B9F\u0BC1...",
  "marketplace.filtersTitle": "\u0BB5\u0B9F\u0BBF\u0B95\u0B9F\u0BCD\u0B9F\u0BBF\u0B95\u0BB3\u0BCD",
  "marketplace.filtersClear": "\u0B85\u0BA9\u0BC8\u0BA4\u0BCD\u0BA4\u0BC8\u0BAF\u0BC1\u0BAE\u0BCD \u0B85\u0BB4\u0BBF",
  "marketplace.filterAll": "\u0B85\u0BA9\u0BC8\u0BA4\u0BCD\u0BA4\u0BC1",
  "marketplace.filterMaterial": "\u0BAA\u0BCA\u0BB0\u0BC1\u0BB3\u0BCD",
  "marketplace.filterRegion": "\u0BAA\u0B95\u0BC1\u0BA4\u0BBF",
  "marketplace.filterPrice": "\u0BB5\u0BBF\u0BB2\u0BC8 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1 (\u20B9)",
  "marketplace.filterPriceMin": "\u0B95\u0BC1\u0BB1\u0BC8\u0BA8\u0BCD\u0BA4\u0BA4\u0BC1",
  "marketplace.filterPriceMax": "\u0B85\u0BA4\u0BBF\u0B95\u0BAA\u0B9F\u0BCD\u0B9A\u0BAE\u0BCD",
  "marketplace.sortLabel": "\u0BB5\u0BB0\u0BBF\u0B9A\u0BC8\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1",
  "marketplace.sortNewest": "\u0BAA\u0BC1\u0BA4\u0BBF\u0BAF\u0BB5\u0BC8 \u0BAE\u0BC1\u0BA4\u0BB2\u0BBF\u0BB2\u0BCD",
  "marketplace.sortPriceAsc": "\u0BB5\u0BBF\u0BB2\u0BC8: \u0B95\u0BC1\u0BB1\u0BC8\u0BA8\u0BCD\u0BA4\u0BA4\u0BC1 \u0BAE\u0BC1\u0BA4\u0BB2\u0BCD \u0B85\u0BA4\u0BBF\u0B95\u0BAE\u0BCD",
  "marketplace.sortPriceDesc": "\u0BB5\u0BBF\u0BB2\u0BC8: \u0B85\u0BA4\u0BBF\u0B95\u0BAE\u0BCD \u0BAE\u0BC1\u0BA4\u0BB2\u0BCD \u0B95\u0BC1\u0BB1\u0BC8\u0BB5\u0BC1",
  "marketplace.resultCount": "{n} \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BCD \u0B95\u0BBF\u0B9F\u0BC8\u0BA4\u0BCD\u0BA4\u0BA9",
  "marketplace.loadMore": "\u0BAE\u0BC7\u0BB2\u0BC1\u0BAE\u0BCD \u0B8F\u0BB1\u0BCD\u0BB1\u0BC1",
  "marketplace.loadError": "\u0B9A\u0BA8\u0BCD\u0BA4\u0BC8\u0BAF\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "marketplace.emptyTitle": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BB5\u0B9F\u0BBF\u0B95\u0B9F\u0BCD\u0B9F\u0BB2\u0BCD\u0B95\u0BB3\u0BC1\u0B95\u0BCD\u0B95\u0BC1 \u0BAA\u0BCA\u0BB0\u0BC1\u0BA4\u0BCD\u0BA4\u0BAE\u0BBE\u0BA9 \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BCD \u0B87\u0BB2\u0BCD\u0BB2\u0BC8",
  "marketplace.emptyFiltered": "\u0B92\u0BB0\u0BC1 \u0BB5\u0B9F\u0BBF\u0B95\u0B9F\u0BCD\u0B9F\u0BB2\u0BC8 \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BBF \u0B85\u0BB2\u0BCD\u0BB2\u0BA4\u0BC1 \u0BB5\u0BC7\u0BB1\u0BC1 \u0B92\u0BA9\u0BCD\u0BB1\u0BC8\u0BA4\u0BCD \u0BA4\u0BC7\u0B9F\u0BBF\u0BAA\u0BCD \u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD.",
  "marketplace.emptyNoProducts": "\u0B87\u0BA9\u0BCD\u0BA9\u0BC1\u0BAE\u0BCD \u0B8E\u0BA8\u0BCD\u0BA4\u0BAA\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BC1\u0BAE\u0BCD \u0BB5\u0BC6\u0BB3\u0BBF\u0BAF\u0BBF\u0B9F\u0BAA\u0BCD\u0BAA\u0B9F\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8. \u0BB5\u0BBF\u0BB0\u0BC8\u0BB5\u0BBF\u0BB2\u0BCD \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD.",
  "marketplace.artisanUnnamed": "KalaSetu \u0B95\u0BB2\u0BC8\u0B9E\u0BB0\u0BCD",
  "marketplace.backToBrowse": "\u0BAE\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BC6\u0B9F\u0BCD\u0B9F\u0BCD\u0BAA\u0BBF\u0BB3\u0BC7\u0BB8\u0BC1\u0B95\u0BCD\u0B95\u0BC1 \u0BA4\u0BBF\u0BB0\u0BC1\u0BAE\u0BCD\u0BAA\u0BC1",
  "marketplace.detailNotFoundTitle": "\u0BAA\u0BCA\u0BB0\u0BC1\u0BB3\u0BCD \u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "marketplace.detailNotFoundMessage": "\u0B87\u0BA8\u0BCD\u0BA4\u0BAA\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0BB3\u0BCD \u0BA8\u0BC0\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BB2\u0BBE\u0BAE\u0BCD \u0B85\u0BB2\u0BCD\u0BB2\u0BA4\u0BC1 \u0B87\u0BA9\u0BBF \u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BBE\u0BA4\u0BC1.",
  "marketplace.artisanSummaryTitle": "\u0B95\u0BC8\u0BB5\u0BBF\u0BA9\u0BC8\u0BAF\u0BBE\u0BB3\u0BB0\u0BCD \u0BAA\u0BB1\u0BCD\u0BB1\u0BBF",
  "marketplace.artisanProductCount": "{n} \u0BAA\u0BCA\u0BB0\u0BC1\u0B9F\u0BCD\u0B95\u0BB3\u0BCD KalaSetu-\u0BB2\u0BCD \u0BAA\u0B9F\u0BCD\u0B9F\u0BBF\u0BAF\u0BB2\u0BBF\u0B9F\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BC1\u0BB3\u0BCD\u0BB3\u0BA9",
  "marketplace.inquiryTitle": "\u0B87\u0BA8\u0BCD\u0BA4\u0BAA\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0BB3\u0BBF\u0BB2\u0BCD \u0B86\u0BB0\u0BCD\u0BB5\u0BAE\u0BBE?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0BA8\u0BC0\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BA4\u0BC7\u0B9F\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC8 \u0B95\u0BC8\u0BB5\u0BBF\u0BA9\u0BC8\u0BAF\u0BBE\u0BB3\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BC1 \u0B9A\u0BCA\u0BB2\u0BCD\u0BB2\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD: \u0B85\u0BB3\u0BB5\u0BC1, \u0BA4\u0BA9\u0BBF\u0BAA\u0BCD\u0BAA\u0BAF\u0BA9\u0BCD, \u0BB5\u0BBF\u0BA8\u0BBF\u0BAF\u0BCB\u0B95 \u0B95\u0BBE\u0BB2\u0BAE\u0BCD...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0BB5\u0BBF\u0BA9\u0BB5\u0BB2\u0BC8 \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1",
  "marketplace.inquirySent": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0BA9\u0BB5\u0BB2\u0BCD \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1. \u0B95\u0BC8\u0BB5\u0BBF\u0BA9\u0BC8\u0BAF\u0BBE\u0BB3\u0BB0\u0BCD \u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BC8\u0BA4\u0BCD \u0BA4\u0BCA\u0B9F\u0BB0\u0BCD\u0BAA\u0BC1 \u0B95\u0BCA\u0BB3\u0BCD\u0BB5\u0BBE\u0BB0\u0BCD.",
  "marketplace.inquiryError": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0BA9\u0BB5\u0BB2\u0BC8 \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8, \u0BAE\u0BC0\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD \u0BAE\u0BC1\u0BAF\u0BB1\u0BCD\u0B9A\u0BBF\u0B95\u0BCD\u0B95\u0BB5\u0BC1\u0BAE\u0BCD",
  "marketplace.regionLabel": "\u0BAA\u0BBF\u0BB0\u0BBE\u0BA8\u0BCD\u0BA4\u0BBF\u0BAF\u0BAE\u0BCD",
  "marketplace.regionUnspecified": "\u0B95\u0BC1\u0BB1\u0BBF\u0BAA\u0BCD\u0BAA\u0BBF\u0B9F\u0BAA\u0BCD\u0BAA\u0B9F\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "marketplace.myInquiriesTitle": "\u0B8E\u0BA9\u0BCD \u0BB5\u0BBF\u0B9A\u0BBE\u0BB0\u0BA3\u0BC8\u0B95\u0BB3\u0BCD",
  "marketplace.inquiriesLoading": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0B9A\u0BBE\u0BB0\u0BA3\u0BC8\u0B95\u0BB3\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1\u0BC1\u0B95\u0BBF\u0BB1\u0BA4\u0BC1...",
  "marketplace.inquiriesLoadError": "\u0B89\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0BB5\u0BBF\u0B9A\u0BBE\u0BB0\u0BA3\u0BC8\u0B95\u0BB3\u0BC8 \u0B8F\u0BB1\u0BCD\u0BB1 \u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8",
  "marketplace.noInquiries": "\u0BA8\u0BC0\u0B99\u0BCD\u0B95\u0BB3\u0BCD \u0B87\u0BA4\u0BC1\u0BB5\u0BB0\u0BC8 \u0BB5\u0BBF\u0B9A\u0BBE\u0BB0\u0BA3\u0BC8 \u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BB5\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8. \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BC8 \u0B95\u0BA3\u0BCD\u0B9F\u0BB1\u0BBF\u0BAF \u0B9A\u0BA8\u0BCD\u0BA4\u0BC8\u0BAF\u0BC8\u0BAA\u0BCD \u0BAA\u0BBE\u0BB0\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD.",
  "marketplace.inquiryProductRemoved": "\u0B87\u0BA8\u0BCD\u0BA4 \u0BA4\u0BAF\u0BBE\u0BB0\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1 \u0B87\u0BA9\u0BBF \u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BBE\u0BA4\u0BC1",
  "marketplace.inquiryStatusOpen": "\u0BAA\u0BA4\u0BBF\u0BB2\u0BCD \u0B95\u0BBE\u0BA4\u0BCD\u0BA4\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BBF\u0BB1\u0BA4\u0BC1",
  "marketplace.inquiryStatusClosed": "\u0BAE\u0BC2\u0B9F\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/te.json
var te_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0C2E\u0C40 \u0C39\u0C38\u0C4D\u0C24\u0C15\u0C33\u0C28\u0C41 \u0C06\u0C28\u0C4D\u200C\u0C32\u0C48\u0C28\u0C4D\u200C\u0C32\u0C4B, \u0C38\u0C41\u0C32\u0C2D\u0C02\u0C17\u0C3E \u0C05\u0C2E\u0C4D\u0C2E\u0C02\u0C21\u0C3F.",
  "welcome.languageLabel": "\u0C2E\u0C40 \u0C2D\u0C3E\u0C37\u0C28\u0C41 \u0C0E\u0C02\u0C1A\u0C41\u0C15\u0C4B\u0C02\u0C21\u0C3F",
  "welcome.getStarted": "\u0C2A\u0C4D\u0C30\u0C3E\u0C30\u0C02\u0C2D\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "language.en": "\u0C07\u0C02\u0C17\u0C4D\u0C32\u0C40\u0C37\u0C4D",
  "language.hi": "\u0C39\u0C3F\u0C02\u0C26\u0C40",
  "email.title": "\u0C2E\u0C40 \u0C07\u0C2E\u0C46\u0C2F\u0C3F\u0C32\u0C4D \u0C1A\u0C3F\u0C30\u0C41\u0C28\u0C3E\u0C2E\u0C3E\u0C28\u0C41 \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "email.roleQuestion": "\u0C28\u0C47\u0C28\u0C41 \u0C07\u0C15\u0C4D\u0C15\u0C21",
  "email.roleSell": "\u0C28\u0C3E \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C05\u0C2E\u0C4D\u0C2E\u0C02\u0C21\u0C3F",
  "email.roleBuy": "\u0C1A\u0C47\u0C24\u0C3F\u0C24\u0C4B \u0C24\u0C2F\u0C3E\u0C30\u0C41 \u0C1A\u0C47\u0C38\u0C3F\u0C28 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C15\u0C4A\u0C28\u0C02\u0C21\u0C3F",
  "email.label": "\u0C07\u0C2E\u0C46\u0C2F\u0C3F\u0C32\u0C4D \u0C1A\u0C3F\u0C30\u0C41\u0C28\u0C3E\u0C2E\u0C3E",
  "email.helper": "\u0C2E\u0C40 \u0C17\u0C41\u0C30\u0C4D\u0C24\u0C3F\u0C02\u0C2A\u0C41\u0C28\u0C41 \u0C28\u0C3F\u0C30\u0C4D\u0C27\u0C3E\u0C30\u0C3F\u0C02\u0C1A\u0C21\u0C3E\u0C28\u0C3F\u0C15\u0C3F 4 \u0C05\u0C02\u0C15\u0C46\u0C32 \u0C15\u0C4B\u0C21\u0C4D\u200C\u0C28\u0C41 \u0C2A\u0C02\u0C2A\u0C3F\u0C38\u0C4D\u0C24\u0C3E\u0C2E\u0C41.",
  "email.invalid": "\u0C38\u0C30\u0C48\u0C28 \u0C07\u0C2E\u0C46\u0C2F\u0C3F\u0C32\u0C4D \u0C1A\u0C3F\u0C30\u0C41\u0C28\u0C3E\u0C2E\u0C3E\u0C28\u0C41 \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "email.sendOtp": "\u0C15\u0C4B\u0C21\u0C4D \u0C2A\u0C02\u0C2A\u0C02\u0C21\u0C3F",
  "email.error": "\u0C15\u0C4B\u0C21\u0C4D \u0C2A\u0C02\u0C2A\u0C21\u0C02\u0C32\u0C4B \u0C35\u0C3F\u0C2B\u0C32\u0C2E\u0C48\u0C02\u0C26\u0C3F, \u0C26\u0C2F\u0C1A\u0C47\u0C38\u0C3F \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "otp.title": "\u0C2E\u0C40 \u0C07\u0C2E\u0C46\u0C2F\u0C3F\u0C32\u0C4D\u200C\u0C28\u0C41 \u0C27\u0C43\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "otp.subtitle": "\u0C15\u0C4D\u0C30\u0C3F\u0C02\u0C26 \u0C2A\u0C02\u0C2A\u0C3F\u0C28 4-\u0C05\u0C02\u0C15\u0C46\u0C32 \u0C15\u0C4B\u0C21\u0C4D\u200C\u0C28\u0C41 \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "otp.emailUndelivered": "\u0C07\u0C2E\u0C46\u0C2F\u0C3F\u0C32\u0C4D \u0C2A\u0C02\u0C2A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02. \u0C21\u0C46\u0C2E\u0C4B \u0C15\u0C4B\u0C21\u0C4D \u0C15\u0C4B\u0C38\u0C02 \u0C2E\u0C40 \u0C2C\u0C43\u0C02\u0C26\u0C3E\u0C28\u0C4D\u0C28\u0C3F \u0C05\u0C21\u0C17\u0C02\u0C21\u0C3F.",
  "otp.changeEmail": "\u0C07\u0C2E\u0C46\u0C2F\u0C3F\u0C32\u0C4D \u0C2E\u0C3E\u0C30\u0C4D\u0C1A\u0C02\u0C21\u0C3F",
  "otp.verify": "\u0C27\u0C43\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "otp.invalid": "\u0C05\u0C28\u0C4D\u0C28\u0C3F 4 \u0C05\u0C02\u0C15\u0C46\u0C32\u0C28\u0C41 \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "otp.wrong": "\u0C24\u0C2A\u0C4D\u0C2A\u0C41 OTP, \u0C26\u0C2F\u0C1A\u0C47\u0C38\u0C3F \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "otp.resend": "OTP \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C02\u0C2A\u0C02\u0C21\u0C3F",
  "otp.resendIn": "OTP {n} \u0C38\u0C46\u0C15\u0C28\u0C4D\u0C32\u0C32\u0C4B \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C02\u0C2A\u0C02\u0C21\u0C3F",
  "otp.resendError": "OTP \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C02\u0C2A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02, \u0C26\u0C2F\u0C1A\u0C47\u0C38\u0C3F \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "camera.capture": "\u0C2B\u0C4B\u0C1F\u0C4B \u0C24\u0C40\u0C38\u0C41\u0C15\u0C4B\u0C02\u0C21\u0C3F",
  "camera.unavailable": "\u0C15\u0C46\u0C2E\u0C46\u0C30\u0C3E \u0C05\u0C02\u0C26\u0C41\u0C2C\u0C3E\u0C1F\u0C41\u0C32\u0C4B \u0C32\u0C47\u0C26\u0C41, \u0C2C\u0C26\u0C41\u0C32\u0C41\u0C17\u0C3E \u0C2B\u0C4B\u0C1F\u0C4B \u0C0E\u0C02\u0C1A\u0C41\u0C15\u0C4B\u0C02\u0C21\u0C3F.",
  "camera.choosePhoto": "\u0C2B\u0C4B\u0C1F\u0C4B\u0C28\u0C41 \u0C0E\u0C02\u0C1A\u0C41\u0C15\u0C4B\u0C02\u0C21\u0C3F",
  "camera.retake": "\u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C24\u0C40\u0C38\u0C41\u0C15\u0C4B\u0C02\u0C21\u0C3F",
  "camera.usePhoto": "\u0C08 \u0C2B\u0C4B\u0C1F\u0C4B\u0C28\u0C41 \u0C09\u0C2A\u0C2F\u0C4B\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "camera.enhancing": "\u0C2E\u0C40 \u0C2B\u0C4B\u0C1F\u0C4B\u0C28\u0C41 \u0C2E\u0C46\u0C30\u0C41\u0C17\u0C41\u0C2A\u0C30\u0C41\u0C38\u0C4D\u0C24\u0C4B\u0C02\u0C26\u0C3F...",
  "camera.enhanceError": "\u0C2B\u0C4B\u0C1F\u0C4B\u0C28\u0C41 \u0C2E\u0C46\u0C30\u0C41\u0C17\u0C41\u0C2A\u0C30\u0C1A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3F\u0C02\u0C26\u0C3F",
  "camera.retry": "\u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "camera.before": "\u0C05\u0C38\u0C32\u0C41",
  "camera.after": "\u0C2E\u0C46\u0C30\u0C41\u0C17\u0C41\u0C2A\u0C30\u0C1A\u0C2C\u0C21\u0C3F\u0C02\u0C26\u0C3F",
  "camera.compareHint": "\u0C38\u0C4D\u0C32\u0C48\u0C21\u0C30\u0C4D\u200C\u0C28\u0C41 \u0C32\u0C3E\u0C17\u0C3F \u0C2A\u0C4B\u0C32\u0C4D\u0C1A\u0C02\u0C21\u0C3F",
  "camera.continue": "\u0C15\u0C4A\u0C28\u0C38\u0C3E\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "studio.title": "\u0C2B\u0C4B\u0C1F\u0C4B\u0C28\u0C41 \u0C2E\u0C46\u0C30\u0C41\u0C17\u0C41\u0C2A\u0C30\u0C1A\u0C02\u0C21\u0C3F",
  "studio.original": "\u0C05\u0C38\u0C32\u0C41",
  "studio.processed": "\u0C2A\u0C4D\u0C30\u0C3E\u0C38\u0C46\u0C38\u0C4D \u0C1A\u0C47\u0C2F\u0C2C\u0C21\u0C3F\u0C02\u0C26\u0C3F",
  "studio.removeBackground": "\u0C28\u0C47\u0C2A\u0C25\u0C4D\u0C2F\u0C3E\u0C28\u0C4D\u0C28\u0C3F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "studio.removingBackground": "\u0C28\u0C47\u0C2A\u0C25\u0C4D\u0C2F\u0C3E\u0C28\u0C4D\u0C28\u0C3F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C38\u0C4D\u0C24\u0C4B\u0C02\u0C26\u0C3F...",
  "studio.keepOriginalBackground": "\u0C05\u0C38\u0C32\u0C41 \u0C28\u0C47\u0C2A\u0C25\u0C4D\u0C2F\u0C3E\u0C28\u0C4D\u0C28\u0C3F \u0C09\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "studio.backgroundWhite": "\u0C24\u0C46\u0C32\u0C41\u0C2A\u0C41",
  "studio.backgroundNeutral": "\u0C2E\u0C43\u0C26\u0C41\u0C35\u0C48\u0C28 \u0C15\u0C4D\u0C30\u0C40\u0C2E\u0C4D",
  "studio.backgroundBlur": "\u0C2E\u0C38\u0C15",
  "studio.backgroundUnavailableNotice": "\u0C2A\u0C4D\u0C30\u0C38\u0C4D\u0C24\u0C41\u0C24\u0C02 \u0C28\u0C47\u0C2A\u0C25\u0C4D\u0C2F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C2A\u0C41 \u0C05\u0C02\u0C26\u0C41\u0C2C\u0C3E\u0C1F\u0C41\u0C32\u0C4B \u0C32\u0C47\u0C26\u0C41. \u0C2E\u0C40 \u0C2B\u0C4B\u0C1F\u0C4B \u0C2E\u0C3E\u0C30\u0C32\u0C47\u0C26\u0C41.",
  "studio.backgroundTimedOutNotice": "\u0C28\u0C47\u0C2A\u0C25\u0C4D\u0C2F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C2A\u0C41 \u0C0E\u0C15\u0C4D\u0C15\u0C41\u0C35 \u0C38\u0C2E\u0C2F\u0C02 \u0C24\u0C40\u0C38\u0C41\u0C15\u0C41\u0C28\u0C3F \u0C35\u0C26\u0C3F\u0C32\u0C3F\u0C35\u0C47\u0C2F\u0C2C\u0C21\u0C3F\u0C02\u0C26\u0C3F. \u0C2E\u0C40 \u0C2B\u0C4B\u0C1F\u0C4B \u0C2E\u0C3E\u0C30\u0C32\u0C47\u0C26\u0C41.",
  "studio.backgroundQuotaNotice": "\u0C2A\u0C4D\u0C30\u0C38\u0C4D\u0C24\u0C41\u0C24\u0C02 \u0C28\u0C47\u0C2A\u0C25\u0C4D\u0C2F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C2A\u0C41 \u0C15\u0C4B\u0C1F\u0C3E \u0C2E\u0C41\u0C17\u0C3F\u0C38\u0C3F\u0C02\u0C26\u0C3F. \u0C2E\u0C40 \u0C2B\u0C4B\u0C1F\u0C4B \u0C2E\u0C3E\u0C30\u0C32\u0C47\u0C26\u0C41.",
  "studio.backgroundFailedNotice": "\u0C2C\u0C4D\u0C2F\u0C3E\u0C15\u0C4D\u200C\u0C17\u0C4D\u0C30\u0C4C\u0C02\u0C21\u0C4D \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C2A\u0C41 \u0C35\u0C3F\u0C2B\u0C32\u0C2E\u0C48\u0C02\u0C26\u0C3F. \u0C2E\u0C40 \u0C2B\u0C4B\u0C1F\u0C4B \u0C2E\u0C3E\u0C30\u0C4D\u0C1A\u0C2C\u0C21\u0C32\u0C47\u0C26\u0C41.",
  "studio.brightness": "\u0C2A\u0C4D\u0C30\u0C15\u0C3E\u0C36\u0C02",
  "studio.contrast": "\u0C35\u0C4D\u0C2F\u0C24\u0C3F\u0C30\u0C47\u0C15\u0C24",
  "studio.sharpen": "\u0C24\u0C40\u0C35\u0C4D\u0C30\u0C24",
  "studio.autoLighting": "\u0C38\u0C4D\u0C35\u0C2F\u0C02\u0C1A\u0C3E\u0C32\u0C15 \u0C35\u0C46\u0C32\u0C41\u0C17\u0C41",
  "studio.crop": "\u0C15\u0C24\u0C4D\u0C24\u0C3F\u0C30\u0C3F\u0C02\u0C1A\u0C41",
  "studio.cropOriginal": "\u0C05\u0C38\u0C32\u0C41",
  "studio.cropSquare": "\u0C1A\u0C24\u0C41\u0C30\u0C38\u0C4D\u0C30\u0C02",
  "studio.cropPortrait": "\u0C32\u0C02\u0C2C\u0C1A\u0C3F\u0C24\u0C4D\u0C30\u0C02",
  "studio.accept": "\u0C08 \u0C2B\u0C4B\u0C1F\u0C4B\u0C28\u0C41 \u0C09\u0C2A\u0C2F\u0C4B\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "studio.retake": "\u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C24\u0C40\u0C38\u0C41\u0C15\u0C4B\u0C02\u0C21\u0C3F",
  "studio.finalizing": "\u0C2E\u0C40 \u0C38\u0C35\u0C30\u0C23\u0C32\u0C28\u0C41 \u0C05\u0C2E\u0C32\u0C41 \u0C1A\u0C47\u0C38\u0C4D\u0C24\u0C41\u0C28\u0C4D\u0C28\u0C3E\u0C02...",
  "studio.on": "\u0C06\u0C28\u0C4D",
  "studio.off": "\u0C06\u0C2B\u0C4D",
  "category.title": "\u0C2E\u0C40\u0C30\u0C41 \u0C0F\u0C2E\u0C3F \u0C05\u0C2E\u0C4D\u0C2E\u0C41\u0C24\u0C41\u0C28\u0C4D\u0C28\u0C3E\u0C30\u0C41?",
  "category.continue": "\u0C15\u0C4A\u0C28\u0C38\u0C3E\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "category.materialQuestion": "\u0C07\u0C26\u0C3F \u0C0F \u0C2A\u0C26\u0C3E\u0C30\u0C4D\u0C25\u0C02\u0C24\u0C4B? (\u0C10\u0C1A\u0C4D\u0C1A\u0C3F\u0C15\u0C02)",
  "category.textiles": "\u0C2C\u0C1F\u0C4D\u0C1F\u0C32\u0C41",
  "category.pottery": "\u0C2E\u0C1F\u0C4D\u0C1F\u0C3F\u0C2A\u0C3E\u0C24\u0C4D\u0C30\u0C32\u0C41",
  "category.jewelry": "\u0C06\u0C2D\u0C30\u0C23\u0C3E\u0C32\u0C41",
  "category.woodwork": "\u0C15\u0C32\u0C2A \u0C2A\u0C28\u0C3F",
  "category.bambooCane": "\u0C2C\u0C3E\u0C02\u0C2C\u0C42 & \u0C35\u0C02\u0C15",
  "category.other": "\u0C07\u0C24\u0C30",
  "voice.tapToRecord": "\u0C2E\u0C40 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F \u0C35\u0C3F\u0C35\u0C30\u0C23\u0C28\u0C41 \u0C30\u0C3F\u0C15\u0C3E\u0C30\u0C4D\u0C21\u0C4D \u0C1A\u0C47\u0C2F\u0C21\u0C3E\u0C28\u0C3F\u0C15\u0C3F \u0C1F\u0C4D\u0C2F\u0C3E\u0C2A\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "voice.recording": "\u0C30\u0C3F\u0C15\u0C3E\u0C30\u0C4D\u0C21\u0C3F\u0C02\u0C17\u0C4D...",
  "voice.stop": "\u0C30\u0C3F\u0C15\u0C3E\u0C30\u0C4D\u0C21\u0C3F\u0C02\u0C17\u0C4D \u0C06\u0C2A\u0C41",
  "voice.record": "\u0C30\u0C3F\u0C15\u0C3E\u0C30\u0C4D\u0C21\u0C4D",
  "voice.reviewRecording": "\u0C35\u0C3F\u0C28\u0C02\u0C21\u0C3F, \u0C24\u0C30\u0C41\u0C35\u0C3E\u0C24 \u0C15\u0C4A\u0C28\u0C38\u0C3E\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F \u0C32\u0C47\u0C26\u0C3E \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C30\u0C3F\u0C15\u0C3E\u0C30\u0C4D\u0C21\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F.",
  "voice.reRecord": "\u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C30\u0C3F\u0C15\u0C3E\u0C30\u0C4D\u0C21\u0C4D",
  "voice.continue": "\u0C15\u0C4A\u0C28\u0C38\u0C3E\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "describe.transcribing": "\u0C2E\u0C40 \u0C35\u0C3F\u0C35\u0C30\u0C23\u0C28\u0C41 \u0C05\u0C30\u0C4D\u0C25\u0C02 \u0C1A\u0C47\u0C38\u0C41\u0C15\u0C41\u0C02\u0C1F\u0C41\u0C28\u0C4D\u0C28\u0C3E\u0C02...",
  "describe.transcribeError": "\u0C2E\u0C40 \u0C35\u0C3F\u0C35\u0C30\u0C23\u0C28\u0C41 \u0C05\u0C30\u0C4D\u0C25\u0C02 \u0C1A\u0C47\u0C38\u0C41\u0C15\u0C4B\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02",
  "describe.retry": "\u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "describe.reviewHint": "\u0C05\u0C35\u0C38\u0C30\u0C2E\u0C48\u0C24\u0C47 \u0C38\u0C2E\u0C40\u0C15\u0C4D\u0C37\u0C3F\u0C02\u0C1A\u0C3F \u0C38\u0C35\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "describe.fallbackNote": "\u0C2E\u0C48\u0C15\u0C4D\u0C30\u0C4B\u0C2B\u0C4B\u0C28\u0C4D \u0C05\u0C02\u0C26\u0C41\u0C2C\u0C3E\u0C1F\u0C41\u0C32\u0C4B \u0C32\u0C47\u0C26\u0C41, \u0C2C\u0C26\u0C41\u0C32\u0C41\u0C17\u0C3E \u0C2E\u0C40 \u0C35\u0C3F\u0C35\u0C30\u0C23\u0C28\u0C41 \u0C1F\u0C48\u0C2A\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F.",
  "describe.placeholderEn": "\u0C07\u0C02\u0C17\u0C4D\u0C32\u0C40\u0C37\u0C41\u0C32\u0C4B \u0C2E\u0C40 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C35\u0C3F\u0C35\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "describe.continue": "\u0C15\u0C4A\u0C28\u0C38\u0C3E\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "pricing.title": "\u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F \u0C27\u0C30\u0C28\u0C41 \u0C28\u0C3F\u0C30\u0C4D\u0C23\u0C2F\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "pricing.summaryEdit": "\u0C38\u0C35\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "pricing.materialCostLabel": "\u0C2A\u0C26\u0C3E\u0C30\u0C4D\u0C25 \u0C16\u0C30\u0C4D\u0C1A\u0C41",
  "pricing.materialCostHelper": "\u0C30\u0C3E \u0C2A\u0C26\u0C3E\u0C30\u0C4D\u0C25\u0C3E\u0C32\u0C2A\u0C48 \u0C2E\u0C40\u0C30\u0C41 \u0C16\u0C30\u0C4D\u0C1A\u0C41 \u0C1A\u0C47\u0C38\u0C3F\u0C28 \u0C2E\u0C4A\u0C24\u0C4D\u0C24\u0C3E\u0C28\u0C4D\u0C28\u0C3F \u0C30\u0C42\u0C2A\u0C3E\u0C2F\u0C32\u0C32\u0C4B \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F.",
  "pricing.materialCostInvalid": "0 \u0C15\u0C02\u0C1F\u0C47 \u0C0E\u0C15\u0C4D\u0C15\u0C41\u0C35 \u0C2A\u0C26\u0C3E\u0C30\u0C4D\u0C25 \u0C16\u0C30\u0C4D\u0C1A\u0C41 \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F.",
  "pricing.getSuggestion": "\u0C27\u0C30 \u0C38\u0C42\u0C1A\u0C28 \u0C2A\u0C4A\u0C02\u0C26\u0C02\u0C21\u0C3F",
  "pricing.suggestError": "\u0C27\u0C30 \u0C38\u0C42\u0C1A\u0C28 \u0C2A\u0C4A\u0C02\u0C26\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02",
  "pricing.retry": "\u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "pricing.rangeLabel": "\u0C38\u0C42\u0C1A\u0C3F\u0C02\u0C1A\u0C3F\u0C28 \u0C27\u0C30 \u0C2A\u0C30\u0C3F\u0C27\u0C3F",
  "pricing.sellingPriceLabel": "\u0C2E\u0C40 \u0C35\u0C3F\u0C15\u0C4D\u0C30\u0C2F \u0C27\u0C30",
  "pricing.sellingPriceNote": "\u0C07\u0C26\u0C3F \u0C38\u0C42\u0C1A\u0C28 \u0C2E\u0C3E\u0C24\u0C4D\u0C30\u0C2E\u0C47, \u0C2E\u0C40\u0C30\u0C41 \u0C07\u0C37\u0C4D\u0C1F\u0C2E\u0C48\u0C28 \u0C27\u0C30\u0C28\u0C41 \u0C2A\u0C46\u0C1F\u0C4D\u0C1F\u0C41\u0C15\u0C4B\u0C35\u0C1A\u0C4D\u0C1A\u0C41.",
  "pricing.sellingPriceInvalid": "0 \u0C15\u0C02\u0C1F\u0C47 \u0C0E\u0C15\u0C4D\u0C15\u0C41\u0C35 \u0C35\u0C3F\u0C15\u0C4D\u0C30\u0C2F \u0C27\u0C30\u0C28\u0C41 \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F.",
  "pricing.publish": "\u0C2A\u0C4D\u0C30\u0C1A\u0C41\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "pricing.publishError": "\u0C2E\u0C40 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C2A\u0C4D\u0C30\u0C1A\u0C41\u0C30\u0C3F\u0C02\u0C1A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02",
  "pricing.successTitle": "\u0C2E\u0C40 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F \u0C07\u0C2A\u0C4D\u0C2A\u0C41\u0C21\u0C41 \u0C32\u0C48\u0C35\u0C4D!",
  "pricing.successMessage": "\u0C15\u0C4A\u0C28\u0C41\u0C17\u0C4B\u0C32\u0C41\u0C26\u0C3E\u0C30\u0C41\u0C32\u0C41 \u0C07\u0C2A\u0C4D\u0C2A\u0C41\u0C21\u0C41 \u0C2E\u0C40 \u0C26\u0C41\u0C15\u0C3E\u0C23\u0C02\u0C32\u0C4B \u0C26\u0C3E\u0C28\u0C4D\u0C28\u0C3F \u0C15\u0C28\u0C41\u0C17\u0C4A\u0C28\u0C17\u0C32\u0C30\u0C41.",
  "pricing.viewShop": "\u0C28\u0C3E \u0C26\u0C41\u0C15\u0C3E\u0C23\u0C02\u0C32\u0C4B \u0C1A\u0C42\u0C21\u0C02\u0C21\u0C3F",
  "home.title": "\u0C28\u0C3E \u0C26\u0C41\u0C15\u0C3E\u0C23\u0C02",
  "home.gemBannerTitle": "GeM / ONDC \u0C15\u0C41 \u0C15\u0C28\u0C46\u0C15\u0C4D\u0C1F\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "home.gemBannerBadge": "\u0C24\u0C4D\u0C35\u0C30\u0C32\u0C4B",
  "home.gemBannerMessage": "\u0C08 \u0C38\u0C2E\u0C28\u0C4D\u0C35\u0C2F\u0C02 \u0C24\u0C4D\u0C35\u0C30\u0C32\u0C4B \u0C05\u0C02\u0C26\u0C41\u0C2C\u0C3E\u0C1F\u0C41\u0C32\u0C4B \u0C09\u0C02\u0C1F\u0C41\u0C02\u0C26\u0C3F.",
  "home.loading": "\u0C2E\u0C40 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C38\u0C4D\u0C24\u0C41\u0C28\u0C4D\u0C28\u0C3E\u0C02...",
  "home.loadError": "\u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C2F\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02",
  "home.retry": "\u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "home.emptyTitle": "\u0C07\u0C02\u0C15\u0C3E \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C41 \u0C32\u0C47\u0C35\u0C41",
  "home.emptyMessage": "KalaSetu \u0C32\u0C4B \u0C05\u0C2E\u0C4D\u0C2E\u0C15\u0C3E\u0C32\u0C41 \u0C2A\u0C4D\u0C30\u0C3E\u0C30\u0C02\u0C2D\u0C3F\u0C02\u0C1A\u0C21\u0C3E\u0C28\u0C3F\u0C15\u0C3F \u0C2E\u0C40 \u0C2E\u0C4A\u0C26\u0C1F\u0C3F \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C1C\u0C4B\u0C21\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F.",
  "home.addFirstProduct": "\u0C2E\u0C40 \u0C2E\u0C4A\u0C26\u0C1F\u0C3F \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C1C\u0C4B\u0C21\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "home.statusPublished": "\u0C2A\u0C4D\u0C30\u0C1A\u0C41\u0C30\u0C3F\u0C02\u0C1A\u0C2C\u0C21\u0C3F\u0C02\u0C26\u0C3F",
  "home.statusDraft": "\u0C21\u0C4D\u0C30\u0C3E\u0C2B\u0C4D\u0C1F\u0C4D",
  "home.statusFailed": "\u0C35\u0C3F\u0C2B\u0C32\u0C2E\u0C48\u0C02\u0C26\u0C3F",
  "home.detailCategory": "\u0C35\u0C30\u0C4D\u0C17\u0C02",
  "home.detailEdit": "\u0C38\u0C35\u0C30\u0C3F\u0C02\u0C1A\u0C41",
  "home.detailDelete": "\u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C1A\u0C41",
  "home.detailClose": "\u0C2E\u0C42\u0C38\u0C3F\u0C35\u0C47\u0C2F\u0C3F",
  "home.editPriceLabel": "\u0C27\u0C30",
  "home.editDescriptionLabel": "\u0C35\u0C3F\u0C35\u0C30\u0C23",
  "home.editSave": "\u0C2E\u0C3E\u0C30\u0C4D\u0C2A\u0C41\u0C32\u0C28\u0C41 \u0C38\u0C47\u0C35\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "home.editCancel": "\u0C30\u0C26\u0C4D\u0C26\u0C41",
  "home.editPriceInvalid": "0 \u0C15\u0C02\u0C1F\u0C47 \u0C0E\u0C15\u0C4D\u0C15\u0C41\u0C35 \u0C27\u0C30\u0C28\u0C41 \u0C28\u0C2E\u0C4B\u0C26\u0C41 \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "home.editDescriptionRequired": "\u0C0F \u0C2D\u0C3E\u0C37\u0C32\u0C4B\u0C28\u0C48\u0C28\u0C3E \u0C35\u0C3F\u0C35\u0C30\u0C23 \u0C16\u0C3E\u0C33\u0C40\u0C17\u0C3E \u0C09\u0C02\u0C21\u0C15\u0C42\u0C21\u0C26\u0C41",
  "home.editError": "\u0C2E\u0C3E\u0C30\u0C4D\u0C2A\u0C41\u0C32\u0C28\u0C41 \u0C38\u0C47\u0C35\u0C4D \u0C1A\u0C47\u0C2F\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02, \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "home.deleteConfirm": "\u0C08 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C1A\u0C3E\u0C32\u0C3E? \u0C07\u0C26\u0C3F \u0C24\u0C3F\u0C30\u0C3F\u0C17\u0C3F \u0C24\u0C40\u0C38\u0C41\u0C15\u0C4B\u0C32\u0C47\u0C2E\u0C41.",
  "home.deleteConfirmYes": "\u0C05\u0C35\u0C41\u0C28\u0C41, \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "home.deleteError": "\u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C1A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02, \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "profile.title": "\u0C2A\u0C4D\u0C30\u0C4A\u0C2B\u0C48\u0C32\u0C4D",
  "profile.emailLabel": "\u0C07\u0C2E\u0C46\u0C2F\u0C3F\u0C32\u0C4D \u0C1A\u0C3F\u0C30\u0C41\u0C28\u0C3E\u0C2E\u0C3E",
  "profile.emailUnknown": "\u0C32\u0C2D\u0C4D\u0C2F\u0C02 \u0C15\u0C3E\u0C26\u0C41",
  "profile.loading": "\u0C2E\u0C40 \u0C2A\u0C4D\u0C30\u0C4A\u0C2B\u0C48\u0C32\u0C4D \u0C32\u0C4B\u0C21\u0C4D \u0C05\u0C35\u0C41\u0C24\u0C4B\u0C02\u0C26\u0C3F...",
  "profile.loadError": "\u0C2E\u0C40 \u0C2A\u0C4D\u0C30\u0C4A\u0C2B\u0C48\u0C32\u0C4D \u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C2F\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02",
  "profile.displayNameLabel": "\u0C2E\u0C40 \u0C2A\u0C47\u0C30\u0C41",
  "profile.shopNameLabel": "\u0C26\u0C41\u0C15\u0C3E\u0C23 \u0C2A\u0C47\u0C30\u0C41",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u0C2A\u0C4D\u0C30\u0C4A\u0C2B\u0C48\u0C32\u0C4D \u0C38\u0C47\u0C35\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "profile.saved": "\u0C2A\u0C4D\u0C30\u0C4A\u0C2B\u0C48\u0C32\u0C4D \u0C38\u0C47\u0C35\u0C4D \u0C05\u0C2F\u0C3F\u0C02\u0C26\u0C3F",
  "profile.saveError": "\u0C2A\u0C4D\u0C30\u0C4A\u0C2B\u0C48\u0C32\u0C4D \u0C38\u0C47\u0C35\u0C4D \u0C1A\u0C47\u0C2F\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02, \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "profile.logout": "\u0C32\u0C3E\u0C17\u0C4D \u0C05\u0C35\u0C41\u0C1F\u0C4D",
  "install.message": "\u0C24\u0C4D\u0C35\u0C30\u0C3F\u0C24 \u0C2F\u0C3E\u0C15\u0C4D\u0C38\u0C46\u0C38\u0C4D \u0C15\u0C4B\u0C38\u0C02 KalaSetu \u0C28\u0C3F \u0C07\u0C28\u0C4D\u200C\u0C38\u0C4D\u0C1F\u0C3E\u0C32\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "install.action": "\u0C07\u0C28\u0C4D\u200C\u0C38\u0C4D\u0C1F\u0C3E\u0C32\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "install.dismiss": "\u0C35\u0C26\u0C3F\u0C32\u0C47\u0C2F\u0C3F",
  "offline.message": "\u0C2E\u0C40\u0C30\u0C41 \u0C06\u0C2B\u0C4D\u200C\u0C32\u0C48\u0C28\u0C4D\u200C\u0C32\u0C4B \u0C09\u0C28\u0C4D\u0C28\u0C3E\u0C30\u0C41, \u0C15\u0C4A\u0C28\u0C4D\u0C28\u0C3F \u0C2B\u0C40\u0C1A\u0C30\u0C4D\u0C32\u0C41 \u0C2A\u0C28\u0C3F\u0C1A\u0C47\u0C2F\u0C15\u0C2A\u0C4B\u0C35\u0C1A\u0C4D\u0C1A\u0C41",
  "welcome.languageHint": "\u0C08 \u0C2D\u0C3E\u0C37\u0C32\u0C4B \u0C2E\u0C4A\u0C24\u0C4D\u0C24\u0C02 \u0C2F\u0C3E\u0C2A\u0C4D \u0C09\u0C02\u0C1F\u0C41\u0C02\u0C26\u0C3F.",
  "welcome.regionalLanguages": "\u0C2D\u0C3E\u0C30\u0C24\u0C40\u0C2F \u0C2D\u0C3E\u0C37\u0C32\u0C41",
  "describe.localTab": "\u0C2E\u0C40 \u0C2D\u0C3E\u0C37",
  "describe.placeholderLocal": "\u0C2E\u0C40 \u0C38\u0C4D\u0C35\u0C02\u0C24 \u0C2D\u0C3E\u0C37\u0C32\u0C4B \u0C2E\u0C40 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C35\u0C3F\u0C35\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "describe.syncing": "\u0C07\u0C24\u0C30 \u0C2D\u0C3E\u0C37\u0C28\u0C41 \u0C28\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C38\u0C4D\u0C24\u0C41\u0C28\u0C4D\u0C28\u0C3E\u0C02...",
  "describe.syncFailed": "\u0C07\u0C24\u0C30 \u0C2D\u0C3E\u0C37\u0C28\u0C41 \u0C28\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C02\u0C1A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02. \u0C05\u0C35\u0C38\u0C30\u0C2E\u0C48\u0C24\u0C47 \u0C38\u0C4D\u0C35\u0C2F\u0C02\u0C17\u0C3E \u0C38\u0C35\u0C30\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F.",
  "describe.syncHint": "\u0C38\u0C35\u0C30\u0C23\u0C32\u0C41 \u0C38\u0C4D\u0C35\u0C2F\u0C02\u0C1A\u0C3E\u0C32\u0C15\u0C02\u0C17\u0C3E \u0C07\u0C24\u0C30 \u0C2D\u0C3E\u0C37\u0C15\u0C41 \u0C15\u0C3E\u0C2A\u0C40 \u0C05\u0C35\u0C41\u0C24\u0C3E\u0C2F\u0C3F.",
  "pricing.updating": "\u0C15\u0C4A\u0C24\u0C4D\u0C24 \u0C2A\u0C26\u0C3E\u0C30\u0C4D\u0C25 \u0C16\u0C30\u0C4D\u0C1A\u0C41 \u0C15\u0C4B\u0C38\u0C02 \u0C28\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C38\u0C4D\u0C24\u0C41\u0C28\u0C4D\u0C28\u0C3E\u0C02...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u0C15\u0C3E\u0C1F\u0C32\u0C3E\u0C17\u0C4D\u200C\u0C28\u0C41 \u0C0E\u0C17\u0C41\u0C2E\u0C24\u0C3F \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F (ONDC \u0C2B\u0C3E\u0C30\u0C4D\u0C2E\u0C3E\u0C1F\u0C4D)",
  "home.exportCatalogNote": "\u0C2E\u0C40 \u0C2A\u0C4D\u0C30\u0C1A\u0C41\u0C30\u0C3F\u0C24 \u0C32\u0C3F\u0C38\u0C4D\u0C1F\u0C3F\u0C02\u0C17\u0C4D\u0C38\u0C4D\u200C\u0C28\u0C41 ONDC \u0C30\u0C3F\u0C1F\u0C48\u0C32\u0C4D \u0C15\u0C3E\u0C1F\u0C32\u0C3E\u0C17\u0C4D \u0C28\u0C3F\u0C30\u0C4D\u0C2E\u0C3E\u0C23\u0C3E\u0C28\u0C3F\u0C15\u0C3F \u0C2E\u0C4D\u0C2F\u0C3E\u0C2A\u0C4D \u0C1A\u0C47\u0C38\u0C3F \u0C21\u0C4C\u0C28\u0C4D\u200C\u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C38\u0C4D\u0C24\u0C41\u0C02\u0C26\u0C3F. \u0C07\u0C02\u0C1F\u0C3F\u0C17\u0C4D\u0C30\u0C47\u0C37\u0C28\u0C4D-\u0C30\u0C46\u0C21\u0C40: \u0C2E\u0C4D\u0C2F\u0C3E\u0C2A\u0C3F\u0C02\u0C17\u0C4D \u0C2A\u0C42\u0C30\u0C4D\u0C24\u0C2F\u0C3F\u0C02\u0C26\u0C3F, \u0C28\u0C46\u0C1F\u0C4D\u200C\u0C35\u0C30\u0C4D\u0C15\u0C4D\u200C\u0C32\u0C4B \u0C32\u0C48\u0C35\u0C4D \u0C15\u0C3E\u0C35\u0C21\u0C3E\u0C28\u0C3F\u0C15\u0C3F \u0C07\u0C02\u0C15\u0C3E ONDC \u0C30\u0C3F\u0C1C\u0C3F\u0C38\u0C4D\u0C1F\u0C4D\u0C30\u0C47\u0C37\u0C28\u0C4D \u0C05\u0C35\u0C38\u0C30\u0C02.",
  "home.exportOndcSingle": "\u0C08 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C28\u0C3F \u0C0E\u0C17\u0C41\u0C2E\u0C24\u0C3F \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F (ONDC \u0C2B\u0C3E\u0C30\u0C4D\u0C2E\u0C3E\u0C1F\u0C4D)",
  "profile.relocalising": "\u0C08 \u0C2D\u0C3E\u0C37\u0C15\u0C41 \u0C2E\u0C40 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C28\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C38\u0C4D\u0C24\u0C41\u0C28\u0C4D\u0C28\u0C3E\u0C02...",
  "profile.relocalised": "{n} \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C41 \u0C08 \u0C2D\u0C3E\u0C37\u0C15\u0C41 \u0C28\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C02\u0C1A\u0C2C\u0C21\u0C4D\u0C21\u0C3E\u0C2F\u0C3F.",
  "profile.relocaliseFailed": "\u0C15\u0C4A\u0C28\u0C4D\u0C28\u0C3F \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C28\u0C35\u0C40\u0C15\u0C30\u0C3F\u0C02\u0C1A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02. \u0C24\u0C30\u0C4D\u0C35\u0C3E\u0C24 \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F.",
  "marketplace.navBrowse": "\u0C2C\u0C4D\u0C30\u0C4C\u0C1C\u0C4D",
  "marketplace.navProfile": "\u0C2A\u0C4D\u0C30\u0C4A\u0C2B\u0C48\u0C32\u0C4D",
  "marketplace.browseTitle": "\u0C2E\u0C3E\u0C30\u0C4D\u0C15\u0C46\u0C1F\u0C4D\u200C\u0C2A\u0C4D\u0C32\u0C47\u0C38\u0C4D",
  "marketplace.searchPlaceholder": "\u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C36\u0C4B\u0C27\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F...",
  "marketplace.filtersTitle": "\u0C2B\u0C3F\u0C32\u0C4D\u0C1F\u0C30\u0C4D\u0C32\u0C41",
  "marketplace.filtersClear": "\u0C05\u0C28\u0C4D\u0C28\u0C40 \u0C15\u0C4D\u0C32\u0C3F\u0C2F\u0C30\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "marketplace.filterAll": "\u0C05\u0C28\u0C4D\u0C28\u0C40",
  "marketplace.filterMaterial": "\u0C2A\u0C26\u0C3E\u0C30\u0C4D\u0C25\u0C02",
  "marketplace.filterRegion": "\u0C2A\u0C4D\u0C30\u0C3E\u0C02\u0C24\u0C02",
  "marketplace.filterPrice": "\u0C27\u0C30 \u0C2A\u0C30\u0C3F\u0C27\u0C3F (\u20B9)",
  "marketplace.filterPriceMin": "\u0C15\u0C28\u0C3F\u0C37\u0C4D\u0C1F",
  "marketplace.filterPriceMax": "\u0C17\u0C30\u0C3F\u0C37\u0C4D\u0C1F\u0C02",
  "marketplace.sortLabel": "\u0C35\u0C30\u0C4D\u0C17\u0C40\u0C15\u0C30\u0C3F\u0C02\u0C1A\u0C41",
  "marketplace.sortNewest": "\u0C15\u0C4A\u0C24\u0C4D\u0C24\u0C35\u0C3F \u0C2E\u0C41\u0C02\u0C26\u0C41\u0C17\u0C3E",
  "marketplace.sortPriceAsc": "\u0C27\u0C30: \u0C24\u0C15\u0C4D\u0C15\u0C41\u0C35 \u0C28\u0C41\u0C02\u0C21\u0C3F \u0C0E\u0C15\u0C4D\u0C15\u0C41\u0C35",
  "marketplace.sortPriceDesc": "\u0C27\u0C30: \u0C0E\u0C15\u0C4D\u0C15\u0C41\u0C35 \u0C28\u0C41\u0C02\u0C21\u0C3F \u0C24\u0C15\u0C4D\u0C15\u0C41\u0C35",
  "marketplace.resultCount": "{n} \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C41 \u0C15\u0C28\u0C41\u0C17\u0C4A\u0C28\u0C2C\u0C21\u0C4D\u0C21\u0C3E\u0C2F\u0C3F",
  "marketplace.loadMore": "\u0C2E\u0C30\u0C3F\u0C28\u0C4D\u0C28\u0C3F \u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F",
  "marketplace.loadError": "\u0C2E\u0C3E\u0C30\u0C4D\u0C15\u0C46\u0C1F\u0C4D\u200C\u0C2A\u0C4D\u0C32\u0C47\u0C38\u0C4D\u200C\u0C28\u0C41 \u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C2F\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02, \u0C26\u0C2F\u0C1A\u0C47\u0C38\u0C3F \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "marketplace.emptyTitle": "\u0C08 \u0C2B\u0C3F\u0C32\u0C4D\u0C1F\u0C30\u0C4D\u0C32\u0C15\u0C41 \u0C38\u0C30\u0C3F\u0C2A\u0C21\u0C47 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C41 \u0C32\u0C47\u0C35\u0C41",
  "marketplace.emptyFiltered": "\u0C2B\u0C3F\u0C32\u0C4D\u0C1F\u0C30\u0C4D\u200C\u0C28\u0C41 \u0C15\u0C4D\u0C32\u0C3F\u0C2F\u0C30\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F \u0C32\u0C47\u0C26\u0C3E \u0C07\u0C24\u0C30\u0C02\u0C17\u0C3E \u0C36\u0C4B\u0C27\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F.",
  "marketplace.emptyNoProducts": "\u0C07\u0C2A\u0C4D\u0C2A\u0C1F\u0C3F\u0C35\u0C30\u0C15\u0C41 \u0C0F \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C41 \u0C2A\u0C4D\u0C30\u0C1A\u0C41\u0C30\u0C3F\u0C02\u0C1A\u0C2C\u0C21\u0C32\u0C47\u0C26\u0C41. \u0C24\u0C4D\u0C35\u0C30\u0C32\u0C4B \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C1A\u0C42\u0C21\u0C02\u0C21\u0C3F.",
  "marketplace.artisanUnnamed": "KalaSetu \u0C15\u0C33\u0C3E\u0C15\u0C3E\u0C30\u0C41\u0C21\u0C41",
  "marketplace.backToBrowse": "\u0C2E\u0C3E\u0C30\u0C4D\u0C15\u0C46\u0C1F\u0C4D\u200C\u0C2A\u0C4D\u0C32\u0C47\u0C38\u0C4D\u200C\u0C15\u0C3F \u0C24\u0C3F\u0C30\u0C3F\u0C17\u0C3F",
  "marketplace.detailNotFoundTitle": "\u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F \u0C15\u0C28\u0C41\u0C17\u0C4A\u0C28\u0C2C\u0C21\u0C32\u0C47\u0C26\u0C41",
  "marketplace.detailNotFoundMessage": "\u0C08 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F \u0C24\u0C4A\u0C32\u0C17\u0C3F\u0C02\u0C1A\u0C2C\u0C21\u0C3F\u0C02\u0C26\u0C4B \u0C32\u0C47\u0C26\u0C3E \u0C07\u0C15 \u0C05\u0C02\u0C26\u0C41\u0C2C\u0C3E\u0C1F\u0C41\u0C32\u0C4B \u0C32\u0C47\u0C26\u0C41.",
  "marketplace.artisanSummaryTitle": "\u0C15\u0C3E\u0C30\u0C3F\u0C17\u0C30\u0C41\u0C21\u0C3F \u0C17\u0C41\u0C30\u0C3F\u0C02\u0C1A\u0C3F",
  "marketplace.artisanProductCount": "KalaSetu \u0C32\u0C4B {n} \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C41",
  "marketplace.inquiryTitle": "\u0C08 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F\u0C32\u0C4B \u0C06\u0C38\u0C15\u0C4D\u0C24\u0C3F \u0C09\u0C02\u0C26\u0C3E?",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0C15\u0C3E\u0C30\u0C3F\u0C17\u0C30\u0C41\u0C21\u0C3F\u0C15\u0C3F \u0C2E\u0C40\u0C30\u0C41 \u0C0F\u0C2E\u0C3F \u0C15\u0C3E\u0C35\u0C3E\u0C32\u0C4B \u0C1A\u0C46\u0C2A\u0C4D\u0C2A\u0C02\u0C21\u0C3F: \u0C2A\u0C30\u0C3F\u0C2E\u0C3E\u0C23\u0C02, \u0C05\u0C28\u0C41\u0C15\u0C42\u0C32\u0C40\u0C15\u0C30\u0C23, \u0C21\u0C46\u0C32\u0C3F\u0C35\u0C30\u0C40 \u0C38\u0C2E\u0C2F\u0C02...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0C35\u0C3F\u0C28\u0C24\u0C3F \u0C2A\u0C02\u0C2A\u0C02\u0C21\u0C3F",
  "marketplace.inquirySent": "\u0C2E\u0C40 \u0C35\u0C3F\u0C28\u0C24\u0C3F \u0C2A\u0C02\u0C2A\u0C2C\u0C21\u0C3F\u0C02\u0C26\u0C3F. \u0C15\u0C3E\u0C30\u0C3F\u0C17\u0C30\u0C41\u0C21\u0C41 \u0C2E\u0C40\u0C24\u0C4B \u0C38\u0C02\u0C2A\u0C4D\u0C30\u0C26\u0C3F\u0C38\u0C4D\u0C24\u0C3E\u0C30\u0C41.",
  "marketplace.inquiryError": "\u0C35\u0C3F\u0C28\u0C24\u0C3F \u0C2A\u0C02\u0C2A\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3E\u0C02, \u0C26\u0C2F\u0C1A\u0C47\u0C38\u0C3F \u0C2E\u0C33\u0C4D\u0C32\u0C40 \u0C2A\u0C4D\u0C30\u0C2F\u0C24\u0C4D\u0C28\u0C3F\u0C02\u0C1A\u0C02\u0C21\u0C3F",
  "marketplace.regionLabel": "\u0C2A\u0C4D\u0C30\u0C3E\u0C02\u0C24\u0C02",
  "marketplace.regionUnspecified": "\u0C28\u0C3F\u0C30\u0C4D\u0C26\u0C47\u0C36\u0C3F\u0C02\u0C1A\u0C32\u0C47\u0C26\u0C41",
  "marketplace.myInquiriesTitle": "\u0C28\u0C3E \u0C35\u0C3F\u0C1A\u0C3E\u0C30\u0C23\u0C32\u0C41",
  "marketplace.inquiriesLoading": "\u0C2E\u0C40 \u0C35\u0C3F\u0C1A\u0C3E\u0C30\u0C23\u0C32\u0C28\u0C41 \u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C38\u0C4D\u0C24\u0C4B\u0C02\u0C26\u0C3F...",
  "marketplace.inquiriesLoadError": "\u0C35\u0C3F\u0C1A\u0C3E\u0C30\u0C23\u0C32\u0C28\u0C41 \u0C32\u0C4B\u0C21\u0C4D \u0C1A\u0C47\u0C2F\u0C32\u0C47\u0C15\u0C2A\u0C4B\u0C2F\u0C3F\u0C02\u0C26\u0C3F",
  "marketplace.noInquiries": "\u0C2E\u0C40\u0C30\u0C41 \u0C07\u0C02\u0C15\u0C3E \u0C35\u0C3F\u0C1A\u0C3E\u0C30\u0C23\u0C32\u0C41 \u0C2A\u0C02\u0C2A\u0C32\u0C47\u0C26\u0C41. \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C41\u0C32\u0C28\u0C41 \u0C15\u0C28\u0C41\u0C17\u0C4A\u0C28\u0C21\u0C3E\u0C28\u0C3F\u0C15\u0C3F \u0C2E\u0C3E\u0C30\u0C4D\u0C15\u0C46\u0C1F\u0C4D\u200C\u0C2A\u0C4D\u0C32\u0C47\u0C38\u0C4D\u200C\u0C28\u0C41 \u0C2C\u0C4D\u0C30\u0C4C\u0C1C\u0C4D \u0C1A\u0C47\u0C2F\u0C02\u0C21\u0C3F.",
  "marketplace.inquiryProductRemoved": "\u0C08 \u0C09\u0C24\u0C4D\u0C2A\u0C24\u0C4D\u0C24\u0C3F \u0C07\u0C15 \u0C05\u0C02\u0C26\u0C41\u0C2C\u0C3E\u0C1F\u0C41\u0C32\u0C4B \u0C32\u0C47\u0C26\u0C41",
  "marketplace.inquiryStatusOpen": "\u0C2A\u0C4D\u0C30\u0C24\u0C3F\u0C38\u0C4D\u0C2A\u0C02\u0C26\u0C28 \u0C15\u0C4B\u0C38\u0C02 \u0C35\u0C47\u0C1A\u0C3F\u0C35\u0C41\u0C02\u0C26\u0C3F",
  "marketplace.inquiryStatusClosed": "\u0C2E\u0C42\u0C38\u0C3F\u0C35\u0C47\u0C2F\u0C2C\u0C21\u0C3F\u0C02\u0C26\u0C3F",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/ur.json
var ur_default = {
  "app.name": "KalaSetu",
  "welcome.tagline": "\u0627\u067E\u0646\u0627 \u06C1\u0646\u0631 \u0622\u0646 \u0644\u0627\u0626\u0646 \u0628\u06CC\u0686\u06CC\u06BA\u060C \u0622\u0633\u0627\u0646 \u0637\u0631\u06CC\u0642\u06D2 \u0633\u06D2\u06D4",
  "welcome.languageLabel": "\u0627\u067E\u0646\u06CC \u0632\u0628\u0627\u0646 \u0645\u0646\u062A\u062E\u0628 \u06A9\u0631\u06CC\u06BA",
  "welcome.getStarted": "\u0634\u0631\u0648\u0639 \u06A9\u0631\u06CC\u06BA",
  "language.en": "\u0627\u0646\u06AF\u0631\u06CC\u0632\u06CC",
  "language.hi": "\u06C1\u0646\u062F\u06CC",
  "email.title": "\u0627\u067E\u0646\u0627 \u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633 \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA",
  "email.roleQuestion": "\u0645\u06CC\u06BA \u06CC\u06C1\u0627\u06BA \u06C1\u0648\u06BA",
  "email.roleSell": "\u0627\u067E\u0646\u06CC \u0686\u06CC\u0632\u06CC\u06BA \u0628\u06CC\u0686\u06CC\u06BA",
  "email.roleBuy": "\u062F\u0633\u062A\u06A9\u0627\u0631\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u062E\u0631\u06CC\u062F\u06CC\u06BA",
  "email.label": "\u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633",
  "email.helper": "\u06C1\u0645 \u0622\u067E \u06A9\u06CC \u062A\u0635\u062F\u06CC\u0642 \u06A9\u06D2 \u0644\u06CC\u06D2 4 \u06C1\u0646\u062F\u0633\u0648\u06BA \u06A9\u0627 \u06A9\u0648\u0688 \u0628\u06BE\u06CC\u062C\u06CC\u06BA \u06AF\u06D2\u06D4",
  "email.invalid": "\u062F\u0631\u0633\u062A \u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633 \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA",
  "email.sendOtp": "\u06A9\u0648\u0688 \u0628\u06BE\u06CC\u062C\u06CC\u06BA",
  "email.error": "\u06A9\u0648\u0688 \u0646\u06C1\u06CC\u06BA \u0628\u06BE\u06CC\u062C\u0627 \u062C\u0627 \u0633\u06A9\u0627\u060C \u0628\u0631\u0627\u06C1 \u06A9\u0631\u0645 \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "otp.title": "\u0627\u067E\u0646\u0627 \u0627\u06CC \u0645\u06CC\u0644 \u062A\u0635\u062F\u06CC\u0642 \u06A9\u0631\u06CC\u06BA",
  "otp.subtitle": "\u0628\u06BE\u06CC\u062C\u06D2 \u06AF\u0626\u06D2 4 \u06C1\u0646\u062F\u0633\u0648\u06BA \u06A9\u0627 \u06A9\u0648\u0688 \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA",
  "otp.emailUndelivered": "\u06C1\u0645 \u0627\u06CC \u0645\u06CC\u0644 \u0646\u06C1\u06CC\u06BA \u0628\u06BE\u06CC\u062C \u0633\u06A9\u06D2\u06D4 \u0688\u06CC\u0645\u0648 \u06A9\u0648\u0688 \u06A9\u06D2 \u0644\u06CC\u06D2 \u0627\u067E\u0646\u06CC \u0679\u06CC\u0645 \u0633\u06D2 \u067E\u0648\u0686\u06BE\u06CC\u06BA\u06D4",
  "otp.changeEmail": "\u0627\u06CC \u0645\u06CC\u0644 \u062A\u0628\u062F\u06CC\u0644 \u06A9\u0631\u06CC\u06BA",
  "otp.verify": "\u062A\u0635\u062F\u06CC\u0642 \u06A9\u0631\u06CC\u06BA",
  "otp.invalid": "\u062A\u0645\u0627\u0645 4 \u06C1\u0646\u062F\u0633\u06D2 \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA",
  "otp.wrong": "\u063A\u0644\u0637 OTP\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "otp.resend": "OTP \u062F\u0648\u0628\u0627\u0631\u06C1 \u0628\u06BE\u06CC\u062C\u06CC\u06BA",
  "otp.resendIn": "OTP {n} \u0633\u06CC\u06A9\u0646\u0688 \u0645\u06CC\u06BA \u062F\u0648\u0628\u0627\u0631\u06C1 \u0628\u06BE\u06CC\u062C\u06CC\u06BA",
  "otp.resendError": "OTP \u062F\u0648\u0628\u0627\u0631\u06C1 \u0646\u06C1\u06CC\u06BA \u0628\u06BE\u06CC\u062C\u0627 \u062C\u0627 \u0633\u06A9\u0627\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "camera.capture": "\u062A\u0635\u0648\u06CC\u0631 \u0644\u06CC\u06BA",
  "camera.unavailable": "\u06A9\u06CC\u0645\u0631\u06C1 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u06CC\u06BA\u060C \u0627\u0633 \u06A9\u06D2 \u0628\u062C\u0627\u0626\u06D2 \u062A\u0635\u0648\u06CC\u0631 \u0645\u0646\u062A\u062E\u0628 \u06A9\u0631\u06CC\u06BA\u06D4",
  "camera.choosePhoto": "\u062A\u0635\u0648\u06CC\u0631 \u0645\u0646\u062A\u062E\u0628 \u06A9\u0631\u06CC\u06BA",
  "camera.retake": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u0644\u06CC\u06BA",
  "camera.usePhoto": "\u06CC\u06C1 \u062A\u0635\u0648\u06CC\u0631 \u0627\u0633\u062A\u0639\u0645\u0627\u0644 \u06A9\u0631\u06CC\u06BA",
  "camera.enhancing": "\u0622\u067E \u06A9\u06CC \u062A\u0635\u0648\u06CC\u0631 \u06A9\u0648 \u0628\u06C1\u062A\u0631 \u0628\u0646\u0627\u06CC\u0627 \u062C\u0627 \u0631\u06C1\u0627 \u06C1\u06D2...",
  "camera.enhanceError": "\u062A\u0635\u0648\u06CC\u0631 \u06A9\u0648 \u0628\u06C1\u062A\u0631 \u0646\u06C1\u06CC\u06BA \u0628\u0646\u0627\u06CC\u0627 \u062C\u0627 \u0633\u06A9\u0627",
  "camera.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "camera.before": "\u0627\u0635\u0644",
  "camera.after": "\u0628\u06C1\u062A\u0631 \u0634\u062F\u06C1",
  "camera.compareHint": "\u0645\u0648\u0627\u0632\u0646\u06C1 \u06A9\u06D2 \u0644\u06CC\u06D2 \u0633\u0644\u0627\u0626\u06CC\u0688\u0631 \u06AF\u06BE\u0633\u06CC\u0679\u06CC\u06BA",
  "camera.continue": "\u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE\u06CC\u06BA",
  "studio.title": "\u0627\u067E\u0646\u06CC \u062A\u0635\u0648\u06CC\u0631 \u0628\u06C1\u062A\u0631 \u0628\u0646\u0627\u0626\u06CC\u06BA",
  "studio.original": "\u0627\u0635\u0644",
  "studio.processed": "\u067E\u0631\u0648\u0633\u06CC\u0633 \u0634\u062F\u06C1",
  "studio.removeBackground": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0626\u06CC\u06BA",
  "studio.removingBackground": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627 \u0631\u06C1\u0627 \u06C1\u06D2...",
  "studio.keepOriginalBackground": "\u0627\u0635\u0644 \u067E\u0633 \u0645\u0646\u0638\u0631 \u0631\u06A9\u06BE\u06CC\u06BA",
  "studio.backgroundWhite": "\u0633\u0641\u06CC\u062F",
  "studio.backgroundNeutral": "\u0646\u0631\u0645 \u06A9\u0631\u06CC\u0645",
  "studio.backgroundBlur": "\u062F\u06BE\u0646\u062F\u0644\u0627",
  "studio.backgroundUnavailableNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0646\u0627 \u0627\u0628\u06BE\u06CC \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u06CC\u06BA \u06C1\u06D2\u06D4 \u0622\u067E \u06A9\u06CC \u062A\u0635\u0648\u06CC\u0631 \u0645\u06CC\u06BA \u06A9\u0648\u0626\u06CC \u062A\u0628\u062F\u06CC\u0644\u06CC \u0646\u06C1\u06CC\u06BA \u06C1\u0648\u0626\u06CC\u06D4",
  "studio.backgroundTimedOutNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0646\u06D2 \u0645\u06CC\u06BA \u0632\u06CC\u0627\u062F\u06C1 \u0648\u0642\u062A \u0644\u06AF\u0646\u06D2 \u06A9\u06CC \u0648\u062C\u06C1 \u0633\u06D2 \u0627\u0633\u06D2 \u0686\u06BE\u0648\u0691 \u062F\u06CC\u0627 \u06AF\u06CC\u0627\u06D4 \u0622\u067E \u06A9\u06CC \u062A\u0635\u0648\u06CC\u0631 \u0645\u06CC\u06BA \u06A9\u0648\u0626\u06CC \u062A\u0628\u062F\u06CC\u0644\u06CC \u0646\u06C1\u06CC\u06BA \u06C1\u0648\u0626\u06CC\u06D4",
  "studio.backgroundQuotaNotice": "\u0641\u06CC \u0627\u0644\u062D\u0627\u0644 \u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0646\u06D2 \u06A9\u06CC \u062D\u062F \u067E\u0648\u0631\u06CC \u06C1\u0648 \u06AF\u0626\u06CC \u06C1\u06D2\u06D4 \u0622\u067E \u06A9\u06CC \u062A\u0635\u0648\u06CC\u0631 \u0645\u06CC\u06BA \u06A9\u0648\u0626\u06CC \u062A\u0628\u062F\u06CC\u0644\u06CC \u0646\u06C1\u06CC\u06BA \u06C1\u0648\u0626\u06CC\u06D4",
  "studio.backgroundFailedNotice": "\u067E\u0633 \u0645\u0646\u0638\u0631 \u06C1\u0679\u0627\u0646\u0627 \u0646\u0627\u06A9\u0627\u0645\u06D4 \u062A\u0635\u0648\u06CC\u0631 \u062C\u06CC\u0633\u06CC \u06A9\u06CC \u062A\u0648\u0633\u06CC \u0631\u06C1\u06CC\u06D4",
  "studio.brightness": "\u0686\u0645\u06A9",
  "studio.contrast": "\u062A\u0636\u0627\u062F",
  "studio.sharpen": "\u062A\u06CC\u0632 \u06A9\u0631\u06CC\u06BA",
  "studio.autoLighting": "\u062E\u0648\u062F\u06A9\u0627\u0631 \u0631\u0648\u0634\u0646\u06CC",
  "studio.crop": "\u06A9\u0679\u0627\u0626\u06CC",
  "studio.cropOriginal": "\u0627\u0635\u0644",
  "studio.cropSquare": "\u0645\u0631\u0628\u0639",
  "studio.cropPortrait": "\u067E\u0648\u0631\u0679\u0631\u06CC\u0679",
  "studio.accept": "\u06CC\u06C1 \u062A\u0635\u0648\u06CC\u0631 \u0627\u0633\u062A\u0639\u0645\u0627\u0644 \u06A9\u0631\u06CC\u06BA",
  "studio.retake": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u0644\u06CC\u06BA",
  "studio.finalizing": "\u0622\u067E \u06A9\u06CC \u062A\u0628\u062F\u06CC\u0644\u06CC\u0627\u06BA \u0644\u0627\u06AF\u0648 \u06C1\u0648 \u0631\u06C1\u06CC \u06C1\u06CC\u06BA...",
  "studio.on": "\u0686\u0627\u0644\u0648",
  "studio.off": "\u0628\u0646\u062F",
  "category.title": "\u0622\u067E \u06A9\u06CC\u0627 \u0628\u06CC\u0686 \u0631\u06C1\u06D2 \u06C1\u06CC\u06BA\u061F",
  "category.continue": "\u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE\u06CC\u06BA",
  "category.materialQuestion": "\u06CC\u06C1 \u06A9\u0633 \u0686\u06CC\u0632 \u0633\u06D2 \u0628\u0646\u0627 \u06C1\u06D2\u061F (\u0627\u062E\u062A\u06CC\u0627\u0631\u06CC)",
  "category.textiles": "\u06A9\u067E\u0691\u06D2",
  "category.pottery": "\u0645\u0679\u06CC \u06A9\u06D2 \u0628\u0631\u062A\u0646",
  "category.jewelry": "\u0632\u06CC\u0648\u0631\u0627\u062A",
  "category.woodwork": "\u0644\u06A9\u0691\u06CC \u06A9\u0627 \u06A9\u0627\u0645",
  "category.bambooCane": "\u0628\u0627\u0646\u0633 \u0627\u0648\u0631 \u0628\u06CC\u062F",
  "category.other": "\u062F\u06CC\u06AF\u0631",
  "voice.tapToRecord": "\u0627\u067E\u0646\u06D2 \u067E\u0631\u0648\u0688\u06A9\u0679 \u06A9\u06CC \u0648\u0636\u0627\u062D\u062A \u0631\u06CC\u06A9\u0627\u0631\u0688 \u06A9\u0631\u0646\u06D2 \u06A9\u06D2 \u0644\u06CC\u06D2 \u0679\u06CC\u067E \u06A9\u0631\u06CC\u06BA",
  "voice.recording": "\u0631\u06CC\u06A9\u0627\u0631\u0688\u0646\u06AF...",
  "voice.stop": "\u0631\u06CC\u06A9\u0627\u0631\u0688\u0646\u06AF \u0631\u0648\u06A9\u06CC\u06BA",
  "voice.record": "\u0631\u06CC\u06A9\u0627\u0631\u0688",
  "voice.reviewRecording": "\u0633\u0646\u0648\u060C \u067E\u06BE\u0631 \u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE\u06CC\u06BA \u06CC\u0627 \u062F\u0648\u0628\u0627\u0631\u06C1 \u0631\u06CC\u06A9\u0627\u0631\u0688 \u06A9\u0631\u06CC\u06BA\u06D4",
  "voice.reRecord": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u0631\u06CC\u06A9\u0627\u0631\u0688 \u06A9\u0631\u06CC\u06BA",
  "voice.continue": "\u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE\u06CC\u06BA",
  "describe.transcribing": "\u0622\u067E \u06A9\u06CC \u0648\u0636\u0627\u062D\u062A \u0633\u0645\u062C\u06BE \u0631\u06C1\u0627 \u06C1\u06D2...",
  "describe.transcribeError": "\u0622\u067E \u06A9\u06CC \u0648\u0636\u0627\u062D\u062A \u0633\u0645\u062C\u06BE \u0646\u06C1\u06CC\u06BA \u0633\u06A9\u06CC",
  "describe.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "describe.reviewHint": "\u062F\u06CC\u06A9\u06BE\u06CC\u06BA \u0627\u0648\u0631 \u0636\u0631\u0648\u0631\u062A \u06C1\u0648 \u062A\u0648 \u062A\u0631\u0645\u06CC\u0645 \u06A9\u0631\u06CC\u06BA",
  "describe.fallbackNote": "\u0645\u0627\u0626\u06CC\u06A9\u0631\u0648\u0641\u0648\u0646 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u06CC\u06BA\u060C \u0627\u0633 \u06A9\u06CC \u0628\u062C\u0627\u0626\u06D2 \u0627\u067E\u0646\u06CC \u0648\u0636\u0627\u062D\u062A \u0679\u0627\u0626\u067E \u06A9\u0631\u06CC\u06BA\u06D4",
  "describe.placeholderEn": "\u0627\u067E\u0646\u06D2 \u067E\u0631\u0648\u0688\u06A9\u0679 \u06A9\u06CC \u0627\u0646\u06AF\u0631\u06CC\u0632\u06CC \u0645\u06CC\u06BA \u0648\u0636\u0627\u062D\u062A \u06A9\u0631\u06CC\u06BA",
  "describe.continue": "\u062C\u0627\u0631\u06CC \u0631\u06A9\u06BE\u06CC\u06BA",
  "pricing.title": "\u0627\u067E\u0646\u06D2 \u067E\u0631\u0648\u0688\u06A9\u0679 \u06A9\u06CC \u0642\u06CC\u0645\u062A \u0645\u0642\u0631\u0631 \u06A9\u0631\u06CC\u06BA",
  "pricing.summaryEdit": "\u062A\u0631\u0645\u06CC\u0645",
  "pricing.materialCostLabel": "\u0645\u0648\u0627\u062F \u06A9\u06CC \u0644\u0627\u06AF\u062A",
  "pricing.materialCostHelper": "\u062E\u0627\u0645 \u0645\u0648\u0627\u062F \u067E\u0631 \u062E\u0631\u0686 \u06A9\u06CC \u06AF\u0626\u06CC \u0631\u0642\u0645 \u0631\u0648\u067E\u06D2 \u0645\u06CC\u06BA \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA\u06D4",
  "pricing.materialCostInvalid": "\u0645\u0648\u0627\u062F \u06A9\u06CC \u0644\u0627\u06AF\u062A \u0635\u0641\u0631 \u0633\u06D2 \u0632\u06CC\u0627\u062F\u06C1 \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA\u06D4",
  "pricing.getSuggestion": "\u0642\u06CC\u0645\u062A \u06A9\u06CC \u062A\u062C\u0648\u06CC\u0632 \u062D\u0627\u0635\u0644 \u06A9\u0631\u06CC\u06BA",
  "pricing.suggestError": "\u0642\u06CC\u0645\u062A \u06A9\u06CC \u062A\u062C\u0648\u06CC\u0632 \u0646\u06C1\u06CC\u06BA \u0645\u0644 \u0633\u06A9\u06CC",
  "pricing.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "pricing.rangeLabel": "\u062A\u062C\u0648\u06CC\u0632 \u06A9\u0631\u062F\u06C1 \u0642\u06CC\u0645\u062A \u06A9\u06CC \u062D\u062F",
  "pricing.sellingPriceLabel": "\u0622\u067E \u06A9\u06CC \u0641\u0631\u0648\u062E\u062A \u06A9\u06CC \u0642\u06CC\u0645\u062A",
  "pricing.sellingPriceNote": "\u06CC\u06C1 \u062A\u062C\u0648\u06CC\u0632 \u06C1\u06D2\u060C \u0622\u067E \u0627\u067E\u0646\u06CC \u0645\u0631\u0636\u06CC \u06A9\u06CC \u0642\u06CC\u0645\u062A \u0631\u06A9\u06BE \u0633\u06A9\u062A\u06D2 \u06C1\u06CC\u06BA\u06D4",
  "pricing.sellingPriceInvalid": "\u0641\u0631\u0648\u062E\u062A \u06A9\u06CC \u0642\u06CC\u0645\u062A \u0635\u0641\u0631 \u0633\u06D2 \u0632\u06CC\u0627\u062F\u06C1 \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA\u06D4",
  "pricing.publish": "\u0634\u0627\u0626\u0639 \u06A9\u0631\u06CC\u06BA",
  "pricing.publishError": "\u0622\u067E \u06A9\u06CC \u067E\u0631\u0648\u0688\u06A9\u0679 \u0634\u0627\u0626\u0639 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u06CC",
  "pricing.successTitle": "\u0622\u067E \u06A9\u06CC \u067E\u0631\u0648\u0688\u06A9\u0679 \u0627\u0628 \u0644\u0627\u0626\u06CC\u0648 \u06C1\u06D2!",
  "pricing.successMessage": "\u062E\u0631\u06CC\u062F\u0627\u0631 \u0627\u0628 \u0622\u067E \u06A9\u06CC \u062F\u06A9\u0627\u0646 \u0645\u06CC\u06BA \u0627\u0633\u06D2 \u062F\u06CC\u06A9\u06BE \u0633\u06A9\u062A\u06D2 \u06C1\u06CC\u06BA\u06D4",
  "pricing.viewShop": "\u0645\u06CC\u0631\u06CC \u062F\u06A9\u0627\u0646 \u0645\u06CC\u06BA \u062F\u06CC\u06A9\u06BE\u06CC\u06BA",
  "home.title": "\u0645\u06CC\u0631\u06CC \u062F\u06A9\u0627\u0646",
  "home.gemBannerTitle": "GeM / ONDC \u0633\u06D2 \u062C\u0691\u06CC\u06BA",
  "home.gemBannerBadge": "\u062C\u0644\u062F \u0622 \u0631\u06C1\u0627 \u06C1\u06D2",
  "home.gemBannerMessage": "\u06CC\u06C1 \u0627\u0646\u0636\u0645\u0627\u0645 \u062C\u0644\u062F \u06C1\u06CC \u062F\u0633\u062A\u06CC\u0627\u0628 \u06C1\u0648\u06AF\u0627\u06D4",
  "home.loading": "\u0622\u067E \u06A9\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0644\u0648\u0688 \u06C1\u0648 \u0631\u06C1\u06CC \u06C1\u06CC\u06BA...",
  "home.loadError": "\u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0644\u0648\u0688 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u06CC",
  "home.retry": "\u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "home.emptyTitle": "\u0627\u0628\u06BE\u06CC \u06A9\u0648\u0626\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0646\u06C1\u06CC\u06BA",
  "home.emptyMessage": "KalaSetu \u067E\u0631 \u0628\u06CC\u0686\u0646\u0627 \u0634\u0631\u0648\u0639 \u06A9\u0631\u0646\u06D2 \u06A9\u06D2 \u0644\u06CC\u06D2 \u0627\u067E\u0646\u06CC \u067E\u06C1\u0644\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0634\u0627\u0645\u0644 \u06A9\u0631\u06CC\u06BA\u06D4",
  "home.addFirstProduct": "\u0627\u067E\u0646\u06CC \u067E\u06C1\u0644\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0634\u0627\u0645\u0644 \u06A9\u0631\u06CC\u06BA",
  "home.statusPublished": "\u0634\u0627\u0626\u0639",
  "home.statusDraft": "\u0645\u0633\u0648\u062F\u06C1",
  "home.statusFailed": "\u0646\u0627\u06A9\u0627\u0645",
  "home.detailCategory": "\u0632\u0645\u0631\u06C1",
  "home.detailEdit": "\u062A\u0631\u0645\u06CC\u0645",
  "home.detailDelete": "\u062D\u0630\u0641",
  "home.detailClose": "\u0628\u0646\u062F",
  "home.editPriceLabel": "\u0642\u06CC\u0645\u062A",
  "home.editDescriptionLabel": "\u062A\u0641\u0635\u06CC\u0644",
  "home.editSave": "\u062A\u0628\u062F\u06CC\u0644\u06CC\u0627\u06BA \u0645\u062D\u0641\u0648\u0638 \u06A9\u0631\u06CC\u06BA",
  "home.editCancel": "\u0645\u0646\u0633\u0648\u062E",
  "home.editPriceInvalid": "0 \u0633\u06D2 \u0632\u06CC\u0627\u062F\u06C1 \u0642\u06CC\u0645\u062A \u062F\u0631\u062C \u06A9\u0631\u06CC\u06BA",
  "home.editDescriptionRequired": "\u062A\u0641\u0635\u06CC\u0644 \u06A9\u0633\u06CC \u0628\u06BE\u06CC \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u062E\u0627\u0644\u06CC \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u062A\u06CC",
  "home.editError": "\u062A\u0628\u062F\u06CC\u0644\u06CC\u0627\u06BA \u0645\u062D\u0641\u0648\u0638 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u06CC\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "home.deleteConfirm": "\u06CC\u06C1 \u067E\u0631\u0648\u0688\u06A9\u0679 \u062D\u0630\u0641 \u06A9\u0631\u06CC\u06BA\u061F \u06CC\u06C1 \u0648\u0627\u067E\u0633 \u0646\u06C1\u06CC\u06BA \u0644\u06CC\u0627 \u062C\u0627 \u0633\u06A9\u062A\u0627\u06D4",
  "home.deleteConfirmYes": "\u06C1\u0627\u06BA\u060C \u062D\u0630\u0641 \u06A9\u0631\u06CC\u06BA",
  "home.deleteError": "\u06CC\u06C1 \u067E\u0631\u0648\u0688\u06A9\u0679 \u062D\u0630\u0641 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u0627\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "profile.title": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644",
  "profile.emailLabel": "\u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633",
  "profile.emailUnknown": "\u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u06CC\u06BA",
  "profile.loading": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0644\u0648\u0688 \u06C1\u0648 \u0631\u06C1\u0627 \u06C1\u06D2...",
  "profile.loadError": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0644\u0648\u0688 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u0627",
  "profile.displayNameLabel": "\u0622\u067E \u06A9\u0627 \u0646\u0627\u0645",
  "profile.shopNameLabel": "\u062F\u06A9\u0627\u0646 \u06A9\u0627 \u0646\u0627\u0645",
  "profile.whatsappLabel": "WhatsApp number (optional)",
  "profile.whatsappPlaceholder": "e.g. 98765 43210",
  "profile.whatsappNote": "Buyers will see a WhatsApp button on your listings if you add this.",
  "profile.whatsappInvalid": "Enter a valid phone number",
  "profile.pincodeLabel": "Pincode (for shipping estimates)",
  "profile.pincodePlaceholder": "e.g. 560001",
  "profile.pincodeNote": "Lets buyers see an estimated shipping cost on your listings. Never shown to buyers directly, only used to calculate the estimate.",
  "profile.pincodeInvalid": "Enter a valid 6-digit pincode",
  "profile.save": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638 \u06A9\u0631\u06CC\u06BA",
  "profile.saved": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638 \u06C1\u0648 \u06AF\u06CC\u0627",
  "profile.saveError": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644 \u0645\u062D\u0641\u0648\u0638 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u0627\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "profile.logout": "\u0644\u0627\u06AF \u0622\u0624\u0679",
  "install.message": "\u062A\u06CC\u0632\u06CC \u0633\u06D2 \u0631\u0633\u0627\u0626\u06CC \u06A9\u06D2 \u0644\u06CC\u06D2 KalaSetu \u0627\u0646\u0633\u0679\u0627\u0644 \u06A9\u0631\u06CC\u06BA",
  "install.action": "\u0627\u0646\u0633\u0679\u0627\u0644",
  "install.dismiss": "\u0628\u0646\u062F \u06A9\u0631\u06CC\u06BA",
  "offline.message": "\u0622\u067E \u0622\u0641 \u0644\u0627\u0626\u0646 \u06C1\u06CC\u06BA\u060C \u06A9\u0686\u06BE \u0641\u06CC\u0686\u0631\u0632 \u06A9\u0627\u0645 \u0646\u06C1\u06CC\u06BA \u06A9\u0631 \u0633\u06A9\u062A\u06D2",
  "welcome.languageHint": "\u067E\u0648\u0631\u0627 \u0627\u06CC\u067E \u0627\u0633 \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u06C1\u0648\u06AF\u0627\u06D4",
  "welcome.regionalLanguages": "\u0628\u06BE\u0627\u0631\u062A\u06CC \u0632\u0628\u0627\u0646\u06CC\u06BA",
  "describe.localTab": "\u0622\u067E \u06A9\u06CC \u0632\u0628\u0627\u0646",
  "describe.placeholderLocal": "\u0627\u067E\u0646\u06D2 \u0627\u0644\u0641\u0627\u0638 \u0645\u06CC\u06BA \u067E\u0631\u0648\u0688\u06A9\u0679 \u06A9\u06CC \u062A\u0641\u0635\u06CC\u0644 \u0644\u06A9\u06BE\u06CC\u06BA",
  "describe.syncing": "\u062F\u0648\u0633\u0631\u06CC \u0632\u0628\u0627\u0646 \u0627\u067E \u0688\u06CC\u0679 \u06C1\u0648 \u0631\u06C1\u06CC \u06C1\u06D2...",
  "describe.syncFailed": "\u062F\u0648\u0633\u0631\u06CC \u0632\u0628\u0627\u0646 \u0627\u067E \u0688\u06CC\u0679 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u06CC\u06D4 \u0627\u06AF\u0631 \u0636\u0631\u0648\u0631\u062A \u06C1\u0648 \u062A\u0648 \u062E\u0648\u062F \u06C1\u06CC \u0627\u06CC\u0688\u0679 \u06A9\u0631\u06CC\u06BA\u06D4",
  "describe.syncHint": "\u062A\u0628\u062F\u06CC\u0644\u06CC\u0627\u06BA \u062E\u0648\u062F \u0628\u062E\u0648\u062F \u062F\u0648\u0633\u0631\u06CC \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u0646\u0642\u0644 \u06C1\u0648 \u062C\u0627\u062A\u06CC \u06C1\u06CC\u06BA\u06D4",
  "pricing.updating": "\u0646\u0626\u06D2 \u0645\u0648\u0627\u062F \u06A9\u06D2 \u0627\u062E\u0631\u0627\u062C\u0627\u062A \u06A9\u06D2 \u0644\u06CC\u06D2 \u0627\u067E \u0688\u06CC\u0679 \u06C1\u0648 \u0631\u06C1\u0627 \u06C1\u06D2...",
  "pricing.breakdownToggle": "See how this price was calculated",
  "pricing.breakdownLabour": "Estimated labour",
  "pricing.breakdownOverhead": "Overhead",
  "pricing.breakdownProductionCost": "Production cost",
  "pricing.breakdownMargin": "Minimum fair price",
  "pricing.breakdownComplexity": "Complexity",
  "pricing.breakdownCategory": "Category",
  "pricing.breakdownDisclaimer": "This is a transparent, rule-based estimate, not a trained AI model. You can always set your own price.",
  "pricing.materialCostAboveTypical": "This looks unusually high for {category} (typical range \u20B9{min}\u2013\u20B9{max}).",
  "pricing.materialCostBelowTypical": "This looks unusually low for {category} (typical range \u20B9{min}\u2013\u20B9{max}). Double check it's correct.",
  "pricing.materialCostCappedNote": "To keep the suggestion fair, it's based on a capped material cost of \u20B9{cappedCost}.",
  "pricing.overchargeBannerTitle": "Priced above typical range for this category",
  "pricing.overchargeBannerBody": "Suggested range: \u20B9{min}\u2013\u20B9{max}. You can still list at this price, buyers will see the same note.",
  "pricing.priceNoteBadge": "Pricing note",
  "home.viewAnalytics": "View analytics",
  "home.viewInquiries": "Inquiries",
  "inquiries.title": "Inquiries",
  "inquiries.loadError": "Could not load your inquiries",
  "inquiries.empty": "No inquiries yet. When a buyer messages you about a product, it shows up here.",
  "inquiries.badgeNew": "New",
  "inquiries.badgeResponded": "Responded",
  "inquiries.quantityLine": "Quantity interested in: {n}",
  "inquiries.contactLine": "Preferred contact: {preference} ({value})",
  "inquiries.replyOnWhatsapp": "Reply on WhatsApp",
  "inquiries.whatsappReplyPrefill": "Hi! Thanks for your interest in {product} on KalaSetu.",
  "inquiries.markResponded": "Mark as responded",
  "inquiries.close": "Close inquiry",
  "shipping.estimateToggle": "Estimated shipping cost by destination",
  "shipping.estimateDisclaimer": "A rough estimate based on typical Indian courier rates, not a live quote or a booking. Actual cost depends on the courier a buyer's order is shipped with.",
  "shipping.weightMissingArtisanNote": "Add an approximate weight on the previous step to see an estimated shipping cost here, and to let buyers see one too.",
  "shipping.pincodeMissingArtisanNote": "Add your pincode in Profile so buyers can see an estimated shipping cost on this listing.",
  "shipping.zone.local": "Same city",
  "shipping.zone.withinState": "Within state",
  "shipping.zone.metroToMetro": "Metro to metro",
  "shipping.zone.restOfIndia": "Rest of India",
  "shipping.zone.special": "J&K, North-East, and island territories",
  "shipping.buyerUnavailable": "Shipping estimate not available for this listing yet.",
  "shipping.pincodeLabel": "Your pincode",
  "shipping.pincodePlaceholder": "e.g. 560001",
  "shipping.pincodeInvalid": "Enter a valid 6-digit pincode",
  "shipping.estimatedShippingLabel": "Estimated shipping",
  "shipping.estimatedTotalLabel": "Estimated delivered total",
  "shipping.buyerDisclaimer": "An estimate based on typical Indian courier rates for this weight and route, not a live quote, a courier booking, or a guaranteed price.",
  "analytics.backToShop": "My Shop",
  "analytics.title": "Analytics",
  "analytics.loadError": "Could not load your analytics",
  "analytics.totalViews": "Total views",
  "analytics.viewsThisWeek": "Views this week",
  "analytics.totalInquiries": "Total inquiries",
  "analytics.activeListings": "Active listings",
  "analytics.chartTitle": "Views, last 30 days",
  "analytics.chartEmpty": "No views recorded in the last 30 days yet. Check back after your listings have been live a while.",
  "analytics.topListingsTitle": "Top listings",
  "analytics.listingsEmpty": "Add a product to start seeing its performance here.",
  "analytics.windowNote": "Views and inquiries counted over the last 30 days.",
  "analytics.columnTitle": "Product",
  "analytics.columnViews": "Views",
  "analytics.columnInquiries": "Inquiries",
  "home.exportCatalog": "\u06A9\u06CC\u0679\u0644\u0627\u06AF \u0628\u0631\u0622\u0645\u062F \u06A9\u0631\u06CC\u06BA (ONDC \u0641\u0627\u0631\u0645\u06CC\u0679)",
  "home.exportCatalogNote": "\u0622\u067E \u06A9\u06CC \u0634\u0627\u0626\u0639 \u0634\u062F\u06C1 \u0641\u06C1\u0631\u0633\u062A\u06CC\u06BA \u062C\u0648 ONDC \u0631\u06CC\u0679\u06CC\u0644 \u06A9\u06CC\u0679\u0644\u0627\u06AF \u06A9\u06D2 \u0688\u06BE\u0627\u0646\u0686\u06D2 \u06A9\u06D2 \u0645\u0637\u0627\u0628\u0642 \u06C1\u06CC\u06BA\u060C \u0688\u0627\u0624\u0646 \u0644\u0648\u0688 \u06A9\u0631\u062A\u0627 \u06C1\u06D2\u06D4 \u0627\u0646\u0679\u06CC\u06AF\u0631\u06CC\u0634\u0646 \u06A9\u06D2 \u0644\u06CC\u06D2 \u062A\u06CC\u0627\u0631: \u0645\u06CC\u067E\u0646\u06AF \u0645\u06A9\u0645\u0644 \u06C1\u06D2\u060C \u0646\u06CC\u0679 \u0648\u0631\u06A9 \u067E\u0631 \u0644\u0627\u0626\u06CC\u0648 \u06C1\u0648\u0646\u06D2 \u06A9\u06D2 \u0644\u06CC\u06D2 ONDC \u0631\u062C\u0633\u0679\u0631\u06CC\u0634\u0646 \u0644\u0627\u0632\u0645\u06CC \u06C1\u06D2\u06D4",
  "home.exportOndcSingle": "\u0645\u0635\u0646\u0648\u0639\u06C1 \u0628\u0631\u0622\u0645\u062F \u06A9\u0631\u06CC\u06BA (ONDC \u0641\u0627\u0631\u0645\u06CC\u0679)",
  "profile.relocalising": "\u0622\u067E \u06A9\u06D2 \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0627\u0633 \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u0627\u067E \u0688\u06CC\u0679 \u06C1\u0648 \u0631\u06C1\u06D2 \u06C1\u06CC\u06BA...",
  "profile.relocalised": "{n} \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0627\u0633 \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u0627\u067E \u0688\u06CC\u0679 \u06C1\u0648 \u0686\u06A9\u06CC \u06C1\u06CC\u06BA\u06D4",
  "profile.relocaliseFailed": "\u06A9\u0686\u06BE \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0627\u067E \u0688\u06CC\u0679 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u06CC\u06BA\u06D4 \u0628\u0639\u062F \u0645\u06CC\u06BA \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA\u06D4",
  "marketplace.navBrowse": "\u062F\u06CC\u06A9\u06BE\u06CC\u06BA",
  "marketplace.navProfile": "\u067E\u0631\u0648\u0641\u0627\u0626\u0644",
  "marketplace.browseTitle": "\u0645\u0627\u0631\u06A9\u06CC\u0679",
  "marketplace.searchPlaceholder": "\u0645\u0635\u0646\u0648\u0639\u0627\u062A \u062A\u0644\u0627\u0634 \u06A9\u0631\u06CC\u06BA...",
  "marketplace.filtersTitle": "\u0641\u0644\u0679\u0631\u0632",
  "marketplace.filtersClear": "\u0633\u0628 \u0635\u0627\u0641 \u06A9\u0631\u06CC\u06BA",
  "marketplace.filterAll": "\u0633\u0628",
  "marketplace.filterMaterial": "\u0645\u0648\u0627\u062F",
  "marketplace.filterRegion": "\u0639\u0644\u0627\u0642\u06C1",
  "marketplace.filterPrice": "\u0642\u06CC\u0645\u062A \u06A9\u06CC \u062D\u062F (\u20B9)",
  "marketplace.filterPriceMin": "\u06A9\u0645",
  "marketplace.filterPriceMax": "\u0632\u06CC\u0627\u062F\u06C1",
  "marketplace.sortLabel": "\u062A\u0631\u062A\u06CC\u0628",
  "marketplace.sortNewest": "\u0646\u06CC\u0627 \u062A\u0631\u06CC\u0646 \u067E\u06C1\u0644\u06D2",
  "marketplace.sortPriceAsc": "\u0642\u06CC\u0645\u062A: \u06A9\u0645 \u0633\u06D2 \u0632\u06CC\u0627\u062F\u06C1",
  "marketplace.sortPriceDesc": "\u0642\u06CC\u0645\u062A: \u0632\u06CC\u0627\u062F\u06C1 \u0633\u06D2 \u06A9\u0645",
  "marketplace.resultCount": "{n} \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0645\u0644\u06CC\u06BA",
  "marketplace.loadMore": "\u0645\u0632\u06CC\u062F \u0644\u0648\u0688 \u06A9\u0631\u06CC\u06BA",
  "marketplace.loadError": "\u0645\u0627\u0631\u06A9\u06CC\u0679 \u067E\u0644\u06CC\u0633 \u0644\u0648\u0688 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u06CC\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "marketplace.emptyTitle": "\u06A9\u0648\u0626\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0627\u0646 \u0641\u0644\u0679\u0631\u0632 \u0633\u06D2 \u0645\u06CC\u0644 \u0646\u06C1\u06CC\u06BA \u06A9\u06BE\u0627\u062A\u06CC\u06BA",
  "marketplace.emptyFiltered": "\u0641\u0644\u0679\u0631 \u0635\u0627\u0641 \u06A9\u0631\u06CC\u06BA \u06CC\u0627 \u06A9\u0686\u06BE \u0627\u0648\u0631 \u062A\u0644\u0627\u0634 \u06A9\u0631\u06CC\u06BA\u06D4",
  "marketplace.emptyNoProducts": "\u0627\u0628\u06BE\u06CC \u062A\u06A9 \u06A9\u0648\u0626\u06CC \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0634\u0627\u0626\u0639 \u0646\u06C1\u06CC\u06BA \u06C1\u0648\u0626\u06CC\u06D4 \u062C\u0644\u062F\u06CC \u062F\u0648\u0628\u0627\u0631\u06C1 \u0686\u06CC\u06A9 \u06A9\u0631\u06CC\u06BA\u06D4",
  "marketplace.artisanUnnamed": "KalaSetu \u06A9\u0627\u0631\u06CC\u06AF\u0631",
  "marketplace.backToBrowse": "\u0645\u0627\u0631\u06A9\u06CC\u0679 \u067E\u0644\u06CC\u0633 \u067E\u0631 \u0648\u0627\u067E\u0633",
  "marketplace.detailNotFoundTitle": "\u067E\u0631\u0648\u0688\u06A9\u0679 \u0646\u06C1\u06CC\u06BA \u0645\u0644\u06CC",
  "marketplace.detailNotFoundMessage": "\u06CC\u06C1 \u067E\u0631\u0648\u0688\u06A9\u0679 \u06C1\u0679\u0627 \u062F\u06CC \u06AF\u0626\u06CC \u06C1\u0648 \u0633\u06A9\u062A\u06CC \u06C1\u06D2 \u06CC\u0627 \u0627\u0628 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u06CC\u06BA \u06C1\u06D2\u06D4",
  "marketplace.artisanSummaryTitle": "\u0641\u0646\u06A9\u0627\u0631 \u06A9\u06D2 \u0628\u0627\u0631\u06D2 \u0645\u06CC\u06BA",
  "marketplace.artisanProductCount": "{n} \u067E\u0631\u0648\u0688\u06A9\u0679\u0633 KalaSetu \u067E\u0631 \u062F\u0631\u062C \u06C1\u06CC\u06BA",
  "marketplace.inquiryTitle": "\u06A9\u06CC\u0627 \u0622\u067E \u0627\u0633 \u067E\u0631\u0648\u0688\u06A9\u0679 \u0645\u06CC\u06BA \u062F\u0644\u0686\u0633\u067E\u06CC \u0631\u06A9\u06BE\u062A\u06D2 \u06C1\u06CC\u06BA\u061F",
  "marketplace.inquirySubtitle": "Send a message to the artisan, or reach out on WhatsApp above.",
  "marketplace.inquiryPlaceholder": "\u0641\u0646\u06A9\u0627\u0631 \u06A9\u0648 \u0628\u062A\u0627\u0626\u06CC\u06BA \u06A9\u06C1 \u0622\u067E \u06A9\u06CC\u0627 \u0686\u0627\u06C1\u062A\u06D2 \u06C1\u06CC\u06BA: \u0645\u0642\u062F\u0627\u0631\u060C \u062A\u062E\u0635\u06CC\u0635\u060C \u0688\u06CC\u0644\u06CC\u0648\u0631\u06CC \u06A9\u0627 \u0648\u0642\u062A...",
  "marketplace.inquiryQuantityLabel": "Quantity interested in",
  "marketplace.inquiryQuantityPlaceholder": "e.g. 2",
  "marketplace.contactPreferenceLabel": "How should the artisan reach you?",
  "marketplace.contactPreference.email": "Email",
  "marketplace.contactPreference.phone": "Phone",
  "marketplace.contactPreference.whatsapp": "WhatsApp",
  "marketplace.contactValueLabel": "Your number",
  "marketplace.contactValuePlaceholder": "e.g. 98765 43210",
  "marketplace.contactValueInvalid": "Enter a valid phone number, 10 digits for an Indian mobile",
  "marketplace.inquiryMessageRequired": "Add a short message so the artisan knows what you need",
  "marketplace.whatsappButton": "Message on WhatsApp",
  "marketplace.whatsappPrefill": "Hi! I'm interested in {product} ({passportId}) on KalaSetu.",
  "marketplace.inquirySend": "\u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0628\u06BE\u06CC\u062C\u06CC\u06BA",
  "marketplace.inquirySent": "\u0622\u067E \u06A9\u0627 \u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0628\u06BE\u06CC\u062C \u062F\u06CC\u0627 \u06AF\u06CC\u0627 \u06C1\u06D2\u06D4 \u0641\u0646\u06A9\u0627\u0631 \u0622\u067E \u0633\u06D2 \u0631\u0627\u0628\u0637\u06C1 \u06A9\u0631\u06D2 \u06AF\u0627\u06D4",
  "marketplace.inquiryError": "\u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0646\u06C1\u06CC\u06BA \u0628\u06BE\u06CC\u062C \u0633\u06A9\u0627\u060C \u062F\u0648\u0628\u0627\u0631\u06C1 \u06A9\u0648\u0634\u0634 \u06A9\u0631\u06CC\u06BA",
  "marketplace.regionLabel": "\u0639\u0644\u0627\u0642\u06C1",
  "marketplace.regionUnspecified": "\u063A\u06CC\u0631 \u0645\u062E\u0635\u0648\u0635",
  "marketplace.myInquiriesTitle": "\u0645\u06CC\u0631\u06CC \u0627\u0633\u062A\u0641\u0633\u0627\u0631\u0627\u062A",
  "marketplace.inquiriesLoading": "\u0622\u067E \u06A9\u06CC \u0627\u0633\u062A\u0641\u0633\u0627\u0631\u0627\u062A \u0644\u0648\u0688 \u06C1\u0648 \u0631\u06C1\u06CC \u06C1\u06CC\u06BA...",
  "marketplace.inquiriesLoadError": "\u0622\u067E \u06A9\u06CC \u0627\u0633\u062A\u0641\u0633\u0627\u0631\u0627\u062A \u0644\u0648\u0688 \u0646\u06C1\u06CC\u06BA \u06C1\u0648 \u0633\u06A9\u06CC",
  "marketplace.noInquiries": "\u0622\u067E \u0646\u06D2 \u0627\u0628\u06BE\u06CC \u062A\u06A9 \u06A9\u0648\u0626\u06CC \u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0646\u06C1\u06CC\u06BA \u0628\u06BE\u06CC\u062C\u0627\u06D4 \u0645\u0627\u0631\u06A9\u06CC\u0679 \u067E\u0644\u06CC\u0633 \u062F\u06CC\u06A9\u06BE\u06CC\u06BA\u06D4",
  "marketplace.inquiryProductRemoved": "\u06CC\u06C1 \u0645\u0635\u0646\u0648\u0639\u0627\u062A \u0627\u0628 \u062F\u0633\u062A\u06CC\u0627\u0628 \u0646\u06C1\u06CC\u06BA \u06C1\u06D2",
  "marketplace.inquiryStatusOpen": "\u062C\u0648\u0627\u0628 \u06A9\u0627 \u0627\u0646\u062A\u0638\u0627\u0631",
  "marketplace.inquiryStatusClosed": "\u0628\u0646\u062F",
  "marketplace.inquiryResponded": "Artisan responded",
  "heritage.title": "A few more details (optional)",
  "heritage.subtitle": "These help tell your product's story on its Heritage Passport. Skip anything you're not sure about.",
  "heritage.techniqueLabel": "Technique",
  "heritage.techniquePlaceholder": "e.g. Hand-thrown, block printing",
  "heritage.timeTakenLabel": "Time taken to make",
  "heritage.timeTakenPlaceholder": "e.g. 2 days",
  "heritage.giTagLabel": "GI or ODOP tag, if any",
  "heritage.giTagPlaceholder": "e.g. Banaras Brocade GI",
  "heritage.careLabel": "Care instructions",
  "heritage.carePlaceholder": "e.g. Hand wash only, keep away from direct sunlight",
  "heritage.weightLabel": "Approximate weight, packed for shipping",
  "heritage.weightHelper": "No scale handy? Pick the closest size. This is only used to estimate shipping cost for buyers.",
  "heritage.weightExactLabel": "Or enter exact weight in kg",
  "heritage.weightExactPlaceholder": "e.g. 1.2",
  "shipping.weightCategory.light": "Light (up to 0.5 kg)",
  "shipping.weightCategory.medium": "Medium (around 1 kg)",
  "shipping.weightCategory.heavy": "Heavy (around 3 kg)",
  "shipping.weightCategory.veryHeavy": "Very heavy (around 7 kg)",
  "heritage.continue": "Continue",
  "passport.viewLink": "View Heritage Passport",
  "passport.eyebrow": "Craft Heritage Passport",
  "passport.selfDeclaredNotice": "Self-declared by the artisan. Not a government-issued certificate.",
  "passport.productIdLabel": "Product ID",
  "passport.artisanLabel": "Artisan",
  "passport.regionLabel": "Region",
  "passport.craftTypeLabel": "Craft type",
  "passport.techniqueLabel": "Technique",
  "passport.materialsLabel": "Materials used",
  "passport.timeTakenLabel": "Time taken",
  "passport.createdLabel": "Created",
  "passport.giTagLabel": "GI / ODOP tag",
  "passport.careLabel": "Care instructions",
  "passport.storyTitle": "The product story",
  "passport.storyUnavailable": "The story for this product is still being written.",
  "passport.shareButton": "Share",
  "passport.shareCopied": "Link copied",
  "passport.printButton": "Print",
  "passport.scanHint": "Scan to view this passport online",
  "passport.notFoundTitle": "Passport not found",
  "passport.notFoundMessage": "This heritage passport doesn't exist, or the listing is no longer public.",
  "passport.loadError": "Could not load this passport"
};

// shared/locales/index.ts
var DICTIONARIES = {
  "as": as_default,
  "bn": bn_default,
  "brx": brx_default,
  "doi": doi_default,
  "en": en_default,
  "gu": gu_default,
  "hi": hi_default,
  "kn": kn_default,
  "kok": kok_default,
  "ks": ks_default,
  "mai": mai_default,
  "ml": ml_default,
  "mni": mni_default,
  "mr": mr_default,
  "ne": ne_default,
  "or": or_default,
  "pa": pa_default,
  "sa": sa_default,
  "sat": sat_default,
  "sd": sd_default,
  "ta": ta_default,
  "te": te_default,
  "ur": ur_default
};

// shared/materials.ts
var PRODUCT_MATERIALS = [
  "Cotton",
  "Silk",
  "Wool",
  "Jute",
  "Linen",
  "Clay",
  "Terracotta",
  "Wood",
  "Bamboo",
  "Cane",
  "Brass",
  "Copper",
  "Bronze",
  "Silver",
  "Iron",
  "Stone",
  "Leather",
  "Glass",
  "Paper",
  "Other"
];
var MATERIAL_SET = new Set(PRODUCT_MATERIALS);
function isProductMaterial(value) {
  return MATERIAL_SET.has(value);
}

// server/routes/products.ts
var router4 = Router4();
var MAX_RELOCALISE = 25;
var MAX_OWN_VIEW_ROWS = 5e3;
var CATEGORY_LABEL_KEYS = {
  textiles: "category.textiles",
  pottery: "category.pottery",
  jewelry: "category.jewelry",
  woodwork: "category.woodwork",
  "bamboo-cane": "category.bambooCane",
  other: "category.other"
};
function localisedTitle(category, language, fallback) {
  const key = CATEGORY_LABEL_KEYS[category];
  if (!key) return null;
  return DICTIONARIES[language]?.[key] ?? DICTIONARIES.en?.[key] ?? fallback;
}
var voiceDeps;
function getVoiceDeps() {
  if (!voiceDeps) {
    voiceDeps = buildVoiceAiDependencies({
      logger: {
        info: () => {
        },
        warn: (m, meta) => console.warn("[products]", m, meta || ""),
        error: (m, meta) => console.error("[products]", m, meta || "")
      }
    });
  }
  return voiceDeps;
}
function getTranslator() {
  return getVoiceDeps().translationService;
}
async function generateHeritageStorySafely(input) {
  try {
    return await getVoiceDeps().descriptionService.generateHeritageStory(input);
  } catch (err) {
    console.warn("[products] heritage story generation failed, passport will show no story for now", {
      message: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
function assessOverchargeSafely(input) {
  try {
    const suggestion = calculateSmartPrice({
      category: input.category,
      materialCost: input.materialCost,
      descriptionEn: input.descriptionEn,
      imageUrl: input.imageUrl
    });
    return assessOvercharge(suggestion, input.price).reason;
  } catch (err) {
    console.warn("[products] overcharge assessment failed, skipping auto-flag", {
      message: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
var PRODUCT_COLUMNS = "id, user_id, category, material, region, artisan_name, title_en, title_local, description_en, description_local, local_language, image_url, price, material_cost, status, flagged, flag_reason, auto_flag_reason, review_status, reviewed_at, reviewed_by, review_reason, passport_id, technique, time_taken, gi_tag, care_instructions, product_story, story_generated_at, created_at, updated_at";
function toProduct(row) {
  return {
    productId: row.id,
    userId: row.user_id,
    category: row.category,
    material: row.material ?? void 0,
    region: row.region,
    artisanName: row.artisan_name,
    titleEn: row.title_en,
    titleLocal: row.title_local,
    descriptionEn: row.description_en,
    descriptionLocal: row.description_local,
    localLanguage: row.local_language,
    imageUrl: row.image_url,
    price: Number(row.price),
    materialCost: Number(row.material_cost),
    status: row.status,
    flagged: row.flagged,
    flagReason: row.flag_reason,
    autoFlagReason: row.auto_flag_reason,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewReason: row.review_reason,
    technique: row.technique ?? void 0,
    timeTaken: row.time_taken ?? void 0,
    giTag: row.gi_tag ?? void 0,
    careInstructions: row.care_instructions ?? void 0,
    passportId: row.passport_id,
    productStory: row.product_story,
    storyGeneratedAt: row.story_generated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
var ProductInputSchema = z5.object({
  category: z5.string().min(1),
  material: z5.string().refine(isProductMaterial, "Unsupported material").optional(),
  titleEn: z5.string().min(1),
  titleLocal: z5.string().min(1),
  descriptionEn: z5.string().min(1),
  descriptionLocal: z5.string().min(1),
  localLanguage: z5.string().min(2).max(8),
  imageUrl: z5.string().url(),
  price: z5.number().positive(),
  materialCost: z5.number().positive(),
  technique: z5.string().trim().min(1).max(120).optional(),
  timeTaken: z5.string().trim().min(1).max(60).optional(),
  giTag: z5.string().trim().min(1).max(120).optional(),
  careInstructions: z5.string().trim().min(1).max(500).optional(),
  weightKg: z5.number().positive().max(1e3).optional()
});
function toRow(input) {
  const row = {};
  if (input.category !== void 0) row.category = input.category;
  if (input.material !== void 0) row.material = input.material;
  if (input.titleEn !== void 0) row.title_en = input.titleEn;
  if (input.titleLocal !== void 0) row.title_local = input.titleLocal;
  if (input.descriptionEn !== void 0) row.description_en = input.descriptionEn;
  if (input.descriptionLocal !== void 0) row.description_local = input.descriptionLocal;
  if (input.localLanguage !== void 0) row.local_language = input.localLanguage;
  if (input.imageUrl !== void 0) row.image_url = input.imageUrl;
  if (input.price !== void 0) row.price = input.price;
  if (input.materialCost !== void 0) row.material_cost = input.materialCost;
  if (input.technique !== void 0) row.technique = input.technique;
  if (input.timeTaken !== void 0) row.time_taken = input.timeTaken;
  if (input.giTag !== void 0) row.gi_tag = input.giTag;
  if (input.careInstructions !== void 0) row.care_instructions = input.careInstructions;
  if (input.weightKg !== void 0) row.weight_kg = input.weightKg;
  return row;
}
router4.post(
  "/",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const parsed = ProductInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const supabase = getSupabase();
    const { data: artisan, error: artisanError } = await supabase.from("users").select("shop_name, display_name, region").eq("id", req.uid).maybeSingle();
    if (artisanError) throw new Error(`Could not look up the artisan profile: ${artisanError.message}`);
    const artisanName = artisan?.shop_name || artisan?.display_name || null;
    const passportId = await generatePassportId();
    const story = await generateHeritageStorySafely({
      category: parsed.data.category,
      descriptionEn: parsed.data.descriptionEn,
      material: parsed.data.material,
      technique: parsed.data.technique,
      timeTaken: parsed.data.timeTaken,
      giTag: parsed.data.giTag
    });
    const autoFlagReason = assessOverchargeSafely({
      category: parsed.data.category,
      materialCost: parsed.data.materialCost,
      descriptionEn: parsed.data.descriptionEn,
      imageUrl: parsed.data.imageUrl,
      price: parsed.data.price
    });
    const { data, error } = await supabase.from("products").insert({
      ...toRow(parsed.data),
      user_id: req.uid,
      status: "published",
      artisan_name: artisanName,
      region: artisan?.region ?? null,
      passport_id: passportId,
      product_story: story,
      story_generated_at: story ? (/* @__PURE__ */ new Date()).toISOString() : null,
      auto_flag_reason: autoFlagReason
    }).select("id, passport_id").single();
    if (error) throw new Error(`Could not create the product: ${error.message}`);
    await supabase.rpc("increment_total_products", { target_user: req.uid, delta: 1 });
    res.status(201).json({ productId: data.id, passportId: data.passport_id });
  })
);
router4.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const requestedUserId = req.query.userId;
    if (requestedUserId && requestedUserId !== req.uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase.from("products").select(PRODUCT_COLUMNS).eq("user_id", req.uid).order("created_at", { ascending: false });
    if (error) throw new Error(`Could not list products: ${error.message}`);
    const rows = data;
    const productIds = rows.map((row) => row.id);
    let viewCountByProduct = /* @__PURE__ */ new Map();
    if (productIds.length > 0) {
      const { data: viewRows, error: viewError } = await supabase.from("product_views").select("product_id").in("product_id", productIds).limit(MAX_OWN_VIEW_ROWS);
      if (viewError) {
        console.warn("[products] could not load view counts for My Shop, showing 0 for now", {
          message: viewError.message
        });
      } else {
        viewCountByProduct = /* @__PURE__ */ new Map();
        for (const row of viewRows ?? []) {
          const productId = row.product_id;
          viewCountByProduct.set(productId, (viewCountByProduct.get(productId) ?? 0) + 1);
        }
      }
    }
    let weightByProduct = /* @__PURE__ */ new Map();
    if (productIds.length > 0) {
      const { data: weightRows, error: weightError } = await supabase.from("products").select("id, weight_kg").in("id", productIds);
      if (weightError) {
        console.warn("[products] could not load product weight for My Shop, shipping estimate will be unavailable", {
          message: weightError.message
        });
      } else {
        weightByProduct = new Map(
          (weightRows ?? []).filter((row) => row.weight_kg !== null).map((row) => [row.id, Number(row.weight_kg)])
        );
      }
    }
    const result = rows.map((row) => ({
      ...toProduct(row),
      weightKg: weightByProduct.get(row.id),
      viewCount: viewCountByProduct.get(row.id) ?? 0
    }));
    res.json(result);
  })
);
var MAX_MARKETPLACE_CANDIDATES = 1e3;
var DEFAULT_PAGE_SIZE = 12;
var MAX_PAGE_SIZE = 48;
var MarketplaceQuerySchema = z5.object({
  q: z5.string().trim().max(200).optional(),
  category: z5.string().optional(),
  material: z5.string().refine(isProductMaterial, "Unsupported material").optional(),
  region: z5.string().refine(isIndianRegion, "Unsupported region").optional(),
  minPrice: z5.coerce.number().nonnegative().optional(),
  maxPrice: z5.coerce.number().positive().optional(),
  sort: z5.enum(["newest", "price_asc", "price_desc"]).default("newest"),
  page: z5.coerce.number().int().positive().default(1),
  limit: z5.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE)
});
function matchesSearch(row, q) {
  const needle = q.toLowerCase();
  return row.title_en.toLowerCase().includes(needle) || row.title_local.toLowerCase().includes(needle) || row.description_en.toLowerCase().includes(needle) || row.description_local.toLowerCase().includes(needle);
}
router4.get(
  "/marketplace",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = MarketplaceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const query = parsed.data;
    let dbQuery = getSupabase().from("products").select(PRODUCT_COLUMNS).eq("status", "published").eq("flagged", false);
    if (query.category) dbQuery = dbQuery.eq("category", query.category);
    if (query.material) dbQuery = dbQuery.eq("material", query.material);
    if (query.region) dbQuery = dbQuery.eq("region", query.region);
    if (query.minPrice !== void 0) dbQuery = dbQuery.gte("price", query.minPrice);
    if (query.maxPrice !== void 0) dbQuery = dbQuery.lte("price", query.maxPrice);
    const { data, error } = await dbQuery.order("created_at", { ascending: false }).limit(MAX_MARKETPLACE_CANDIDATES);
    if (error) throw new Error(`Could not list marketplace products: ${error.message}`);
    let rows = data;
    if (query.q) rows = rows.filter((row) => matchesSearch(row, query.q));
    if (query.sort === "price_asc") {
      rows = [...rows].sort((a, b) => Number(a.price) - Number(b.price));
    } else if (query.sort === "price_desc") {
      rows = [...rows].sort((a, b) => Number(b.price) - Number(a.price));
    }
    const total = rows.length;
    const start = (query.page - 1) * query.limit;
    const page = rows.slice(start, start + query.limit);
    res.json({
      items: page.map(toProduct),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: start + page.length < total
    });
  })
);
router4.get(
  "/marketplace/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const supabase = getSupabase();
    const { data: product, error: productError } = await supabase.from("products").select(PRODUCT_COLUMNS).eq("id", req.params.id).eq("status", "published").eq("flagged", false).maybeSingle();
    if (productError) throw new Error(`Could not load the product: ${productError.message}`);
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    let { data: artisan, error: artisanError } = await supabase.from("users").select("id, shop_name, display_name, region, whatsapp_number, pincode, total_products").eq("id", product.user_id).maybeSingle();
    if (artisanError?.code === "42703") {
      const fallback = await supabase.from("users").select("id, shop_name, display_name, region, total_products").eq("id", product.user_id).maybeSingle();
      artisan = fallback.data ? { ...fallback.data, whatsapp_number: null, pincode: null } : null;
      artisanError = fallback.error;
    }
    if (artisanError) throw new Error(`Could not load the artisan profile: ${artisanError.message}`);
    let weightKg;
    const { data: weightRow, error: weightError } = await supabase.from("products").select("weight_kg").eq("id", product.id).maybeSingle();
    if (weightError) {
      console.warn("[products] could not load product weight, shipping estimate will be unavailable", {
        message: weightError.message
      });
    } else if (weightRow?.weight_kg !== null && weightRow?.weight_kg !== void 0) {
      weightKg = Number(weightRow.weight_kg);
    }
    const result = {
      ...toProduct(product),
      weightKg,
      artisan: {
        userId: artisan?.id ?? product.user_id,
        shopName: artisan?.shop_name ?? null,
        displayName: artisan?.display_name ?? null,
        region: artisan?.region ?? null,
        whatsappNumber: artisan?.whatsapp_number ?? null,
        pincode: artisan?.pincode ?? null,
        totalProducts: artisan?.total_products ?? 0
      }
    };
    res.json(result);
  })
);
router4.patch(
  "/:id",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const parsed = ProductInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const supabase = getSupabase();
    const { data: existing, error: existingError } = await supabase.from("products").select("category, material_cost, price, description_en, image_url").eq("id", req.params.id).eq("user_id", req.uid).maybeSingle();
    if (existingError) throw new Error(`Could not load the product: ${existingError.message}`);
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    const autoFlagReason = assessOverchargeSafely({
      category: parsed.data.category ?? existing.category,
      materialCost: parsed.data.materialCost ?? Number(existing.material_cost),
      descriptionEn: parsed.data.descriptionEn ?? existing.description_en,
      imageUrl: parsed.data.imageUrl ?? existing.image_url,
      price: parsed.data.price ?? Number(existing.price)
    });
    const { data, error } = await supabase.from("products").update({ ...toRow(parsed.data), auto_flag_reason: autoFlagReason, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", req.params.id).eq("user_id", req.uid).select("id");
    if (error) throw new Error(`Could not update the product: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json({ success: true });
  })
);
router4.delete(
  "/:id",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase.from("products").delete().eq("id", req.params.id).eq("user_id", req.uid).select("id");
    if (error) throw new Error(`Could not delete the product: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    await supabase.rpc("increment_total_products", { target_user: req.uid, delta: -1 });
    res.json({ success: true });
  })
);
var RelocaliseSchema = z5.object({
  language: z5.string().refine(isAppLanguage, "Unsupported language")
});
router4.post(
  "/relocalise",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const parsed = RelocaliseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const language = parsed.data.language;
    const supabase = getSupabase();
    const { data, error } = await supabase.from("products").select("id, category, title_en, description_en, local_language").eq("user_id", req.uid).neq("local_language", language).order("created_at", { ascending: false }).limit(MAX_RELOCALISE);
    if (error) throw new Error(`Could not list products to relocalise: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) {
      res.json({ updated: 0, failed: 0, remaining: 0 });
      return;
    }
    const translator = getTranslator();
    let updated = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const fromDictionary = localisedTitle(row.category, language, row.title_en);
        const description = language === "en" ? row.description_en : await translator.translate(row.description_en, "en", language);
        const title = fromDictionary ?? (language === "en" ? row.title_en : await translator.translate(row.title_en, "en", language));
        const { error: writeError } = await supabase.from("products").update({
          title_local: title,
          description_local: description,
          local_language: language,
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }).eq("id", row.id).eq("user_id", req.uid);
        if (writeError) throw new Error(writeError.message);
        updated += 1;
      } catch (err) {
        failed += 1;
        console.error("relocalise failed for a product", {
          productId: row.id,
          to: language,
          message: err?.message
        });
      }
    }
    const { count } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("user_id", req.uid).neq("local_language", language);
    res.json({ updated, failed, remaining: count ?? 0 });
  })
);
var products_default = router4;

// server/routes/images.ts
import { Router as Router5 } from "express";
import { z as z7 } from "zod";
import { randomUUID } from "node:crypto";

// server/middleware/rawBody.ts
var PayloadTooLargeError = class extends Error {
  constructor(limitBytes) {
    super(`Upload exceeds the ${Math.round(limitBytes / (1024 * 1024))}MB limit`);
    this.name = "PayloadTooLargeError";
  }
};
async function readRawBody(req, limitBytes) {
  const existing = req.body;
  if (Buffer.isBuffer(existing)) {
    if (existing.length > limitBytes) throw new PayloadTooLargeError(limitBytes);
    return existing;
  }
  if (typeof existing === "string" && existing.length > 0) {
    const buffer = Buffer.from(existing, "binary");
    if (buffer.length > limitBytes) throw new PayloadTooLargeError(limitBytes);
    return buffer;
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new PayloadTooLargeError(limitBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function requestedContentType(req, fallback) {
  const header = req.get("x-file-type") || req.get("content-type") || "";
  const bare = header.split(";")[0].trim().toLowerCase();
  return bare && bare !== "application/octet-stream" ? bare : fallback;
}

// server/lib/ownStorageUrl.ts
var InvalidStorageUrlError = class extends Error {
  constructor() {
    super("URL does not point at this user's own storage folder");
    this.name = "InvalidStorageUrlError";
  }
};
function resolveOwnStorageUrl(sourceUrl, bucket, uid) {
  const expected = new URL(getSupabase().storage.from(bucket).getPublicUrl(`${uid}/`).data.publicUrl);
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new InvalidStorageUrlError();
  }
  if (parsed.origin !== expected.origin) throw new InvalidStorageUrlError();
  if (!parsed.pathname.startsWith(expected.pathname) || parsed.pathname.includes("..")) {
    throw new InvalidStorageUrlError();
  }
  return parsed.toString();
}

// server/services/imageEnhancer.ts
import sharp from "sharp";

// server/image-ai/errors/image-ai.errors.ts
var BackgroundRemovalError = class extends Error {
  reason;
  cause;
  constructor(reason, message, cause) {
    super(message);
    this.name = "BackgroundRemovalError";
    this.reason = reason;
    this.cause = cause;
  }
};

// server/image-ai/config/env.ts
import "dotenv/config";
import { z as z6 } from "zod";
var envSchema3 = z6.object({
  BACKGROUND_REMOVAL_PROVIDER: z6.enum(["remove-bg", "none"]).default("none"),
  REMOVE_BG_API_KEY: z6.string().optional(),
  BACKGROUND_REMOVAL_TIMEOUT_MS: z6.coerce.number().int().positive().default(8e3)
}).superRefine((env, ctx) => {
  if (env.BACKGROUND_REMOVAL_PROVIDER === "remove-bg" && !env.REMOVE_BG_API_KEY) {
    ctx.addIssue({
      code: z6.ZodIssueCode.custom,
      path: ["REMOVE_BG_API_KEY"],
      message: "REMOVE_BG_API_KEY is required when BACKGROUND_REMOVAL_PROVIDER is remove-bg"
    });
  }
});
var cached4;
function withoutBlanks3(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}
function loadImageAiEnv() {
  if (cached4) return cached4;
  const parsed = envSchema3.safeParse(withoutBlanks3(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid image-ai environment configuration: ${issues}`);
  }
  cached4 = parsed.data;
  return cached4;
}

// server/image-ai/providers/remove-bg.service.ts
var REMOVE_BG_URL = "https://api.remove.bg/v1.0/removebg";
var RemoveBgService = class {
  apiKey;
  timeoutMs;
  constructor(apiKey, timeoutMs) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }
  async removeBackground(input, mimeType) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.append("image_file", new Blob([new Uint8Array(input)], { type: mimeType }), "photo");
      form.append("size", "auto");
      const response = await fetch(REMOVE_BG_URL, {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey },
        body: form,
        signal: controller.signal
      });
      if (response.status === 429) {
        throw new BackgroundRemovalError("rate_limited", "remove.bg rate limit or quota reached");
      }
      if (!response.ok) {
        const detail = await response.text();
        throw new BackgroundRemovalError(
          "provider_error",
          `remove.bg returned ${response.status}`,
          detail.slice(0, 500)
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      if (err instanceof BackgroundRemovalError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new BackgroundRemovalError("timeout", `remove.bg did not respond within ${this.timeoutMs}ms`, err);
      }
      throw new BackgroundRemovalError("provider_error", "remove.bg request failed", err);
    } finally {
      clearTimeout(timer);
    }
  }
};

// server/image-ai/providers/disabled.service.ts
var DisabledBackgroundRemovalService = class {
  async removeBackground() {
    throw new BackgroundRemovalError("not_configured", "Background removal is not configured");
  }
};

// server/image-ai/factory.ts
function buildBackgroundRemovalService() {
  const env = loadImageAiEnv();
  if (env.BACKGROUND_REMOVAL_PROVIDER === "remove-bg" && env.REMOVE_BG_API_KEY) {
    return new RemoveBgService(env.REMOVE_BG_API_KEY, env.BACKGROUND_REMOVAL_TIMEOUT_MS);
  }
  return new DisabledBackgroundRemovalService();
}

// server/services/imageEnhancer.ts
var MAX_IMAGE_DIMENSION = 1600;
var JPEG_QUALITY = 86;
var UnsupportedImageError = class extends Error {
  originalError;
  constructor(originalError) {
    super("Image could not be read, the format may be unsupported");
    this.name = "UnsupportedImageError";
    this.originalError = originalError;
  }
};
var defaultBackgroundRemoval;
function getDefaultBackgroundRemovalService() {
  if (!defaultBackgroundRemoval) defaultBackgroundRemoval = buildBackgroundRemovalService();
  return defaultBackgroundRemoval;
}
function toBackgroundRemovalNotice(err) {
  if (err instanceof BackgroundRemovalError) {
    switch (err.reason) {
      case "not_configured":
        return "background_removal_unavailable";
      case "timeout":
        return "background_removal_timed_out";
      case "rate_limited":
        return "background_removal_quota_reached";
      default:
        return "background_removal_failed";
    }
  }
  return "background_removal_failed";
}
async function prepare(input) {
  return sharp(input, { failOn: "none" }).rotate().resize({
    width: MAX_IMAGE_DIMENSION,
    height: MAX_IMAGE_DIMENSION,
    fit: "inside",
    withoutEnlargement: true
  }).png().toBuffer();
}
async function enhanceProductImage(input, options = {}) {
  if (!options.removeBackground) {
    try {
      const pipeline = sharp(input, { failOn: "none" }).rotate().resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true
      }).normalise().modulate({ saturation: 1.06 }).sharpen({ sigma: 0.8 }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      return {
        buffer: data,
        mimeType: "image/jpeg",
        width: info.width,
        height: info.height,
        backgroundRemoved: false
      };
    } catch (err) {
      throw new UnsupportedImageError(err);
    }
  }
  let prepared;
  try {
    prepared = await prepare(input);
  } catch (err) {
    throw new UnsupportedImageError(err);
  }
  let working = prepared;
  let backgroundRemoved = false;
  let cutoutBuffer;
  let notice;
  try {
    const service = options.backgroundRemoval ?? getDefaultBackgroundRemovalService();
    cutoutBuffer = await service.removeBackground(prepared, "image/png");
    working = await sharp(cutoutBuffer).flatten({ background: "#ffffff" }).png().toBuffer();
    backgroundRemoved = true;
  } catch (err) {
    cutoutBuffer = void 0;
    notice = toBackgroundRemovalNotice(err);
    console.warn("[imageEnhancer] background removal failed, falling back to sharp-only enhancement", {
      reason: err instanceof BackgroundRemovalError ? err.reason : "unknown",
      message: err instanceof Error ? err.message : String(err)
    });
  }
  try {
    const pipeline = sharp(working).normalise().modulate({ saturation: 1.06 }).sharpen({ sigma: 0.8 }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      mimeType: "image/jpeg",
      width: info.width,
      height: info.height,
      backgroundRemoved,
      cutoutBuffer,
      notice
    };
  } catch (err) {
    throw new UnsupportedImageError(err);
  }
}

// server/services/imageStudio.ts
import sharp2 from "sharp";
var FILL_COLORS = {
  white: "#ffffff",
  neutral: "#f5efe4"
};
var CROP_RATIOS = {
  square: 1,
  portrait: 4 / 5
};
async function applyStudioAdjustments(source, options) {
  let meta;
  try {
    meta = await sharp2(source).metadata();
  } catch (err) {
    throw new UnsupportedImageError(err);
  }
  try {
    const hasAlpha = Boolean(meta.hasAlpha);
    let pipeline = sharp2(source);
    if (hasAlpha && options.backgroundBlur) {
      const backdrop = await sharp2(source).flatten({ background: "#ffffff" }).blur(24).toBuffer();
      pipeline = sharp2(backdrop).composite([{ input: source }]);
    } else if (hasAlpha && options.backgroundFill && options.backgroundFill !== "none") {
      pipeline = pipeline.flatten({ background: FILL_COLORS[options.backgroundFill] });
    }
    if (options.autoLighting) {
      pipeline = pipeline.normalise().linear(1.05, -6);
    }
    const brightnessStep = options.brightness ?? 0;
    if (brightnessStep !== 0) {
      pipeline = pipeline.modulate({ brightness: 1 + brightnessStep * 0.08 });
    }
    const contrastStep = options.contrast ?? 0;
    if (contrastStep !== 0) {
      const slope = 1 + contrastStep * 0.12;
      pipeline = pipeline.linear(slope, 128 * (1 - slope));
    }
    if (options.sharpen) {
      pipeline = pipeline.sharpen({ sigma: 1.2 });
    }
    const cropPreset = options.cropPreset ?? "original";
    if (cropPreset !== "original") {
      const ratio = CROP_RATIOS[cropPreset];
      const targetWidth = Math.min(meta.width ?? MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION);
      const targetHeight = Math.round(targetWidth / ratio);
      pipeline = pipeline.resize({ width: targetWidth, height: targetHeight, fit: "cover", position: "centre" });
    }
    const { data, info } = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return { buffer: data, mimeType: "image/jpeg", width: info.width, height: info.height };
  } catch (err) {
    if (err instanceof UnsupportedImageError) throw err;
    throw new UnsupportedImageError(err);
  }
}

// server/routes/images.ts
var router5 = Router5();
var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
async function storeImage(buffer, path, contentType) {
  const supabase = getSupabase();
  const bucket = getStorageBucket();
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: false
  });
  if (error) {
    throw new Error(`Could not store the image: ${error.message}`);
  }
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
function handleImageError(err, res) {
  if (err instanceof PayloadTooLargeError) {
    res.status(413).json({ error: "image_too_large", message: err.message });
    return true;
  }
  if (err instanceof UnsupportedImageError) {
    res.status(400).json({ error: "unsupported_image", message: err.message });
    return true;
  }
  return false;
}
router5.post(
  "/enhance",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    try {
      const raw = await readRawBody(req, MAX_IMAGE_BYTES);
      if (raw.length === 0) {
        res.status(400).json({ error: "No image data provided" });
        return;
      }
      const contentType = requestedContentType(req, "image/jpeg");
      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const originalImageUrl = await storeImage(raw, `${req.uid}/original/${stamp}`, contentType);
      const processed = await enhanceProductImage(raw);
      const enhancedImageUrl = await storeImage(
        processed.buffer,
        `${req.uid}/enhanced/${stamp}.jpg`,
        processed.mimeType
      );
      res.json({
        enhancedImageUrl,
        originalImageUrl,
        width: processed.width,
        height: processed.height
      });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  })
);
router5.post(
  "/remove-background",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    try {
      const raw = await readRawBody(req, MAX_IMAGE_BYTES);
      if (raw.length === 0) {
        res.status(400).json({ error: "No image data provided" });
        return;
      }
      const processed = await enhanceProductImage(raw, { removeBackground: true });
      if (!processed.backgroundRemoved || !processed.cutoutBuffer) {
        res.json({ cutoutUrl: null, backgroundRemoved: false, notice: processed.notice });
        return;
      }
      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const cutoutUrl = await storeImage(processed.cutoutBuffer, `${req.uid}/cutout/${stamp}.png`, "image/png");
      res.json({ cutoutUrl, backgroundRemoved: true });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  })
);
var StudioOptionsSchema = z7.object({
  brightness: z7.number().int().min(-2).max(2).optional(),
  contrast: z7.number().int().min(-2).max(2).optional(),
  sharpen: z7.boolean().optional(),
  autoLighting: z7.boolean().optional(),
  backgroundBlur: z7.boolean().optional(),
  backgroundFill: z7.enum(["white", "neutral", "none"]).optional(),
  cropPreset: z7.enum(["original", "square", "portrait"]).optional()
});
var FinalizeSchema = z7.object({
  sourceUrl: z7.string().url(),
  options: StudioOptionsSchema
});
router5.post(
  "/finalize",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const parsed = FinalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    let sourceUrl;
    try {
      sourceUrl = resolveOwnStorageUrl(parsed.data.sourceUrl, getStorageBucket(), req.uid);
    } catch (err) {
      if (err instanceof InvalidStorageUrlError) {
        res.status(400).json({ error: "invalid_source_url" });
        return;
      }
      throw err;
    }
    const sourceRes = await fetch(sourceUrl);
    if (!sourceRes.ok) {
      res.status(404).json({ error: "source_not_found" });
      return;
    }
    const source = Buffer.from(await sourceRes.arrayBuffer());
    try {
      const result = await applyStudioAdjustments(source, parsed.data.options);
      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const finalImageUrl = await storeImage(result.buffer, `${req.uid}/final/${stamp}.jpg`, result.mimeType);
      res.json({ finalImageUrl, width: result.width, height: result.height });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  })
);
var images_default = router5;

// server/routes/voice.ts
import { Router as Router6 } from "express";
var router6 = Router6();
var MAX_AUDIO_BYTES = 10 * 1024 * 1024;
var voiceAiDeps;
function getVoiceAiDeps() {
  if (!voiceAiDeps) {
    voiceAiDeps = buildVoiceAiDependencies({
      logger: {
        info: (message, meta) => console.info("[voice-ai:info]", message, meta || ""),
        warn: (message, meta) => console.warn("[voice-ai:warn]", message, meta || ""),
        error: (message, meta) => console.error("[voice-ai:error]", message, meta || "")
      }
    });
  }
  return voiceAiDeps;
}
router6.post(
  "/transcribe",
  requireAuth,
  asyncRoute(async (req, res) => {
    const category = req.query.category?.trim();
    if (!category) {
      res.status(400).json({ error: "category query parameter is required" });
      return;
    }
    const requested = req.query.language?.trim();
    const targetLanguage = requested && isAppLanguage(requested) ? requested : "en";
    let audio;
    try {
      audio = await readRawBody(req, MAX_AUDIO_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.status(413).json({ error: "audio_too_large", message: err.message });
        return;
      }
      throw err;
    }
    if (audio.length === 0) {
      res.status(400).json({ error: "No audio data provided" });
      return;
    }
    try {
      const result = await processVoiceDescription(
        {
          audio,
          mimeType: requestedContentType(req, "audio/wav"),
          category,
          targetLanguage
        },
        getVoiceAiDeps()
      );
      res.json({
        transcript: result.transcript,
        descriptionEn: result.descriptionEn,
        descriptionLocal: result.descriptionLocal,
        localLanguage: result.localLanguage,
        detectedLanguage: result.detectedLanguage
      });
    } catch (err) {
      console.error("voice/transcribe failed", {
        stage: err?.stage,
        message: err?.message,
        cause: err?.cause?.message ?? String(err?.cause ?? "")
      });
      res.status(500).json({
        error: "transcription_failed",
        stage: err?.stage,
        message: err?.message || "Speech transcription or description generation failed"
      });
    }
  })
);
var voice_default = router6;

// server/routes/translate.ts
import { Router as Router7 } from "express";
import { z as z8 } from "zod";
var router7 = Router7();
var deps;
function getDeps() {
  if (!deps) {
    deps = buildVoiceAiDependencies({
      logger: {
        info: () => {
        },
        warn: (message, meta) => console.warn("[translate]", message, meta || ""),
        error: (message, meta) => console.error("[translate]", message, meta || "")
      }
    });
  }
  return deps;
}
var TranslateSchema = z8.object({
  text: z8.string().min(1).max(4e3),
  from: z8.string().refine(isAppLanguage, "Unsupported source language"),
  to: z8.string().refine(isAppLanguage, "Unsupported target language")
});
router7.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = TranslateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { text, from, to } = parsed.data;
    if (from === to) {
      res.json({ translation: text });
      return;
    }
    try {
      const translation = await getDeps().translationService.translate(text, from, to);
      res.json({ translation });
    } catch (err) {
      console.error("translate failed", {
        from,
        to,
        message: err?.message,
        cause: err?.cause?.message ?? String(err?.cause ?? "")
      });
      res.status(502).json({ error: "translation_failed" });
    }
  })
);
var translate_default = router7;

// server/routes/pricing.ts
import { Router as Router8 } from "express";
import { z as z9 } from "zod";
var router8 = Router8();
var RawMaterialSchema = z9.object({
  name: z9.string().min(1),
  cost: z9.number().positive(),
  quantity: z9.union([z9.number(), z9.string()]).optional(),
  unit: z9.string().optional()
});
var PricingInputSchema = z9.object({
  category: z9.string().min(1),
  materialCost: z9.number().positive().optional(),
  rawMaterials: z9.array(RawMaterialSchema).optional(),
  descriptionEn: z9.string().optional(),
  descriptionHi: z9.string().optional(),
  imageUrl: z9.string().url().optional().or(z9.literal("")),
  complexity: z9.enum(["simple", "standard", "detailed", "complex", "exceptional"]).optional(),
  subcategory: z9.string().optional()
}).refine(
  (data) => data.materialCost !== void 0 && data.materialCost > 0 || data.rawMaterials && data.rawMaterials.length > 0,
  {
    message: "Either materialCost or rawMaterials must be provided with positive values",
    path: ["materialCost"]
  }
);
router8.post(
  "/suggest",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = PricingInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const output = calculateSmartPrice({
        category: parsed.data.category,
        materialCost: parsed.data.materialCost,
        rawMaterials: parsed.data.rawMaterials,
        descriptionEn: parsed.data.descriptionEn,
        descriptionHi: parsed.data.descriptionHi,
        imageUrl: parsed.data.imageUrl,
        complexity: parsed.data.complexity,
        subcategory: parsed.data.subcategory
      });
      res.json(output);
    } catch (err) {
      res.status(500).json({
        error: "pricing_calculation_failed",
        message: err?.message || "Calculation error"
      });
    }
  })
);
var pricing_default = router8;

// server/routes/inquiries.ts
import { Router as Router9 } from "express";
import { z as z10 } from "zod";
var router9 = Router9();
var INQUIRY_COLUMNS = "id, product_id, buyer_id, artisan_id, message, quantity, contact_preference, contact_value, status, read_at, responded_at, notified_at, created_at";
function toInquiry(row, product, buyerEmail) {
  return {
    inquiryId: row.id,
    productId: row.product_id,
    buyerId: row.buyer_id,
    buyerEmail,
    artisanId: row.artisan_id,
    message: row.message,
    quantity: row.quantity,
    contactPreference: row.contact_preference ?? "email",
    contactValue: row.contact_value,
    status: row.status,
    readAt: row.read_at,
    respondedAt: row.responded_at,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
    product
  };
}
async function enrichInquiries(rows) {
  if (rows.length === 0) return [];
  const productIds = [...new Set(rows.map((row) => row.product_id))];
  const buyerIds = [...new Set(rows.map((row) => row.buyer_id))];
  const supabase = getSupabase();
  const [productsResult, buyersResult] = await Promise.all([
    supabase.from("products").select("id, title_en, title_local, local_language, image_url, price, passport_id").in("id", productIds),
    supabase.from("users").select("id, email").in("id", buyerIds)
  ]);
  if (productsResult.error) throw new Error(`Could not load inquiry products: ${productsResult.error.message}`);
  if (buyersResult.error) throw new Error(`Could not load inquiry buyers: ${buyersResult.error.message}`);
  const productById = new Map(
    (productsResult.data ?? []).map((product) => [
      product.id,
      {
        titleEn: product.title_en,
        titleLocal: product.title_local,
        localLanguage: product.local_language,
        imageUrl: product.image_url,
        price: Number(product.price),
        passportId: product.passport_id
      }
    ])
  );
  const emailByBuyerId = new Map((buyersResult.data ?? []).map((buyer) => [buyer.id, buyer.email]));
  return rows.map(
    (row) => toInquiry(row, productById.get(row.product_id) ?? null, emailByBuyerId.get(row.buyer_id) ?? null)
  );
}
var CreateInquirySchema = z10.object({
  productId: z10.string().uuid(),
  message: z10.string().min(1).max(2e3),
  quantity: z10.number().int().positive().optional(),
  contactPreference: z10.enum(["email", "phone", "whatsapp"]),
  contactValue: z10.string().trim().min(1).max(40).optional()
}).refine((data) => data.contactPreference === "email" || Boolean(data.contactValue), {
  message: "Enter a phone number for this contact preference",
  path: ["contactValue"]
});
router9.post(
  "/",
  requireAuth,
  requireRole("buyer"),
  asyncRoute(async (req, res) => {
    const parsed = CreateInquirySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const supabase = getSupabase();
    const { data: product, error: productError } = await supabase.from("products").select("id, user_id, status, flagged, title_en, image_url, passport_id").eq("id", parsed.data.productId).maybeSingle();
    if (productError) throw new Error(`Could not look up the product: ${productError.message}`);
    if (!product || product.status !== "published" || product.flagged) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    const { data: inserted, error } = await supabase.from("inquiries").insert({
      product_id: product.id,
      buyer_id: req.uid,
      artisan_id: product.user_id,
      message: parsed.data.message,
      quantity: parsed.data.quantity ?? null,
      contact_preference: parsed.data.contactPreference,
      contact_value: parsed.data.contactValue ?? null
    }).select("id").single();
    if (error) throw new Error(`Could not create the inquiry: ${error.message}`);
    const [artisanResult, buyerResult] = await Promise.all([
      supabase.from("users").select("email").eq("id", product.user_id).maybeSingle(),
      supabase.from("users").select("email").eq("id", req.uid).maybeSingle()
    ]);
    let emailDelivered = false;
    if (artisanResult.data?.email && buyerResult.data?.email) {
      const env = loadEnv();
      const mailResult = await sendInquiryEmail({
        artisanEmail: artisanResult.data.email,
        productTitle: product.title_en,
        productImageUrl: product.image_url,
        passportId: product.passport_id,
        buyerMessage: parsed.data.message,
        quantity: parsed.data.quantity ?? null,
        contactPreference: parsed.data.contactPreference,
        contactValue: parsed.data.contactValue ?? null,
        buyerEmail: buyerResult.data.email,
        inboxUrl: `${env.PUBLIC_APP_URL}/inquiries`
      });
      emailDelivered = mailResult.delivered;
      if (emailDelivered) {
        await supabase.from("inquiries").update({ notified_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", inserted.id);
      }
    } else {
      console.warn("[inquiries] could not resolve an email address for the artisan or buyer, skipping notification", {
        inquiryId: inserted.id
      });
    }
    res.status(201).json({ inquiryId: inserted.id, emailDelivered });
  })
);
router9.get(
  "/mine",
  requireAuth,
  requireRole("buyer"),
  asyncRoute(async (req, res) => {
    const { data, error } = await getSupabase().from("inquiries").select(INQUIRY_COLUMNS).eq("buyer_id", req.uid).order("created_at", { ascending: false });
    if (error) throw new Error(`Could not list inquiries: ${error.message}`);
    res.json(await enrichInquiries(data));
  })
);
router9.get(
  "/received",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase.from("inquiries").select(INQUIRY_COLUMNS).eq("artisan_id", req.uid).order("created_at", { ascending: false });
    if (error) throw new Error(`Could not list inquiries: ${error.message}`);
    const rows = data;
    const unreadIds = rows.filter((row) => !row.read_at).map((row) => row.id);
    if (unreadIds.length > 0) {
      const { error: readError } = await supabase.from("inquiries").update({ read_at: (/* @__PURE__ */ new Date()).toISOString() }).in("id", unreadIds);
      if (readError) {
        console.warn("[inquiries] could not mark inquiries as read", { message: readError.message });
      }
    }
    res.json(await enrichInquiries(rows));
  })
);
var CloseInquirySchema = z10.object({
  status: z10.literal("closed")
});
router9.patch(
  "/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = CloseInquirySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { data, error } = await getSupabase().from("inquiries").update({ status: parsed.data.status }).eq("id", req.params.id).or(`buyer_id.eq.${req.uid},artisan_id.eq.${req.uid}`).select("id");
    if (error) throw new Error(`Could not update the inquiry: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    res.json({ success: true });
  })
);
router9.patch(
  "/:id/responded",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const { data, error } = await getSupabase().from("inquiries").update({ responded_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", req.params.id).eq("artisan_id", req.uid).select("id");
    if (error) throw new Error(`Could not update the inquiry: ${error.message}`);
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Inquiry not found" });
      return;
    }
    res.json({ success: true });
  })
);
var inquiries_default = router9;

// server/routes/internalConsole.ts
import { Router as Router10 } from "express";
import { z as z11 } from "zod";

// server/middleware/requireAdminOr404.ts
function notFound(res) {
  res.status(404).json({ error: "Not Found" });
}
async function requireAdminOr404(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    notFound(res);
    return;
  }
  let uid;
  try {
    const claims = verifySessionToken(header.slice("Bearer ".length).trim());
    uid = claims.sub;
  } catch {
    notFound(res);
    return;
  }
  const { data, error } = await getSupabase().from("users").select("role").eq("id", uid).maybeSingle();
  if (error) {
    notFound(res);
    return;
  }
  const role = isUserRole(data?.role) ? data.role : void 0;
  if (role !== "admin") {
    notFound(res);
    return;
  }
  req.uid = uid;
  req.role = role;
  next();
}

// server/lib/auditLog.ts
async function recordAudit(actorId, action, targetTable, targetId, options = {}) {
  const { error } = await getSupabase().from("audit_log").insert({
    actor_id: actorId,
    action,
    target_table: targetTable,
    target_id: targetId,
    reason: options.reason ?? null,
    metadata: options.metadata ?? null
  });
  if (error) {
    console.error("[audit] could not record audit row", { action, targetTable, targetId, message: error.message });
  }
}

// server/routes/internalConsole.ts
var router10 = Router10();
router10.use(requireAdminOr404);
function toConsoleArtisan(row) {
  return {
    userId: row.id,
    email: row.email,
    displayName: row.display_name,
    shopName: row.shop_name,
    region: row.region,
    isActive: row.is_active,
    totalProducts: row.total_products,
    createdAt: row.created_at
  };
}
var SIGNUP_WINDOW_DAYS = 30;
router10.get(
  "/dashboard",
  asyncRoute(async (_req, res) => {
    const supabase = getSupabase();
    const [artisans, buyers, products, pending, inquiries] = await Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "artisan"),
      supabase.from("users").select("id", { count: "exact", head: true }).eq("role", "buyer"),
      supabase.from("products").select("id", { count: "exact", head: true }),
      supabase.from("products").select("id", { count: "exact", head: true }).eq("review_status", "pending"),
      supabase.from("inquiries").select("id", { count: "exact", head: true })
    ]);
    for (const result of [artisans, buyers, products, pending, inquiries]) {
      if (result.error) throw new Error(`Could not load dashboard stats: ${result.error.message}`);
    }
    const since = new Date(Date.now() - SIGNUP_WINDOW_DAYS * 24 * 60 * 60 * 1e3).toISOString();
    const { data: signups, error: signupError } = await supabase.from("users").select("created_at").gte("created_at", since);
    if (signupError) throw new Error(`Could not load signup history: ${signupError.message}`);
    const byDay = /* @__PURE__ */ new Map();
    for (const row of signups ?? []) {
      const day = row.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    const signupsOverTime = [];
    for (let i = SIGNUP_WINDOW_DAYS - 1; i >= 0; i -= 1) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
      signupsOverTime.push({ date, count: byDay.get(date) ?? 0 });
    }
    const stats = {
      totalArtisans: artisans.count ?? 0,
      totalBuyers: buyers.count ?? 0,
      totalProducts: products.count ?? 0,
      pendingApproval: pending.count ?? 0,
      totalInquiries: inquiries.count ?? 0,
      signupsOverTime
    };
    res.json(stats);
  })
);
var MAX_ARTISAN_CANDIDATES = 1e3;
router10.get(
  "/artisans",
  asyncRoute(async (req, res) => {
    const q = req.query.q?.trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const { data, error } = await getSupabase().from("users").select("id, email, display_name, shop_name, region, is_active, total_products, created_at").eq("role", "artisan").order("created_at", { ascending: false }).limit(MAX_ARTISAN_CANDIDATES);
    if (error) throw new Error(`Could not list artisans: ${error.message}`);
    let rows = data ?? [];
    if (q) {
      rows = rows.filter(
        (row) => row.email.toLowerCase().includes(q) || (row.display_name ?? "").toLowerCase().includes(q) || (row.shop_name ?? "").toLowerCase().includes(q)
      );
    }
    const total = rows.length;
    const start = (page - 1) * limit;
    const page_ = rows.slice(start, start + limit);
    res.json({
      items: page_.map(toConsoleArtisan),
      page,
      limit,
      total,
      hasMore: start + page_.length < total
    });
  })
);
router10.get(
  "/artisans/:id",
  asyncRoute(async (req, res) => {
    const supabase = getSupabase();
    const artisanId = req.params.id;
    const { data: artisan, error: artisanError } = await supabase.from("users").select("id, email, display_name, shop_name, region, is_active, total_products, created_at").eq("id", artisanId).eq("role", "artisan").maybeSingle();
    if (artisanError) throw new Error(`Could not load the artisan: ${artisanError.message}`);
    if (!artisan) {
      res.status(404).json({ error: "Artisan not found" });
      return;
    }
    const { data: listings, error: listingsError } = await supabase.from("products").select(PRODUCT_COLUMNS).eq("user_id", artisanId).order("created_at", { ascending: false });
    if (listingsError) throw new Error(`Could not load the artisan's listings: ${listingsError.message}`);
    const result = {
      ...toConsoleArtisan(artisan),
      listings: listings.map(toProduct)
    };
    res.json(result);
  })
);
var SetActiveSchema = z11.object({
  isActive: z11.boolean(),
  reason: z11.string().max(500).optional()
});
router10.patch(
  "/artisans/:id",
  asyncRoute(async (req, res) => {
    const parsed = SetActiveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const supabase = getSupabase();
    const artisanId = req.params.id;
    const { data, error } = await supabase.from("users").update({ is_active: parsed.data.isActive }).eq("id", artisanId).eq("role", "artisan").select("id").maybeSingle();
    if (error) throw new Error(`Could not update the artisan: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: "Artisan not found" });
      return;
    }
    await recordAudit(req.uid, parsed.data.isActive ? "artisan.reactivate" : "artisan.deactivate", "users", artisanId, {
      reason: parsed.data.reason
    });
    res.json({ success: true });
  })
);
var MAX_MODERATION_CANDIDATES = 1e3;
router10.get(
  "/moderation/queue",
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data, error, count } = await getSupabase().from("products").select(PRODUCT_COLUMNS, { count: "exact" }).eq("review_status", "pending").order("created_at", { ascending: true }).range(from, Math.min(to, MAX_MODERATION_CANDIDATES));
    if (error) throw new Error(`Could not load the moderation queue: ${error.message}`);
    const items = data.map(toProduct);
    const total = count ?? items.length;
    res.json({ items, page, limit, total, hasMore: from + items.length < total });
  })
);
async function loadProductOr404(id, res) {
  const { data, error } = await getSupabase().from("products").select(PRODUCT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load the product: ${error.message}`);
  if (!data) {
    res.status(404).json({ error: "Product not found" });
    return null;
  }
  return data;
}
router10.patch(
  "/moderation/:id/approve",
  asyncRoute(async (req, res) => {
    const productId = req.params.id;
    const product = await loadProductOr404(productId, res);
    if (!product) return;
    const { error } = await getSupabase().from("products").update({
      review_status: "approved",
      reviewed_at: (/* @__PURE__ */ new Date()).toISOString(),
      reviewed_by: req.uid,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("id", productId);
    if (error) throw new Error(`Could not approve the product: ${error.message}`);
    await recordAudit(req.uid, "product.approve", "products", productId);
    res.json({ success: true });
  })
);
var ReasonSchema = z11.object({
  reason: z11.string().trim().min(1, "A reason is required").max(500)
});
router10.patch(
  "/moderation/:id/reject",
  asyncRoute(async (req, res) => {
    const parsed = ReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const productId = req.params.id;
    const product = await loadProductOr404(productId, res);
    if (!product) return;
    const { error } = await getSupabase().from("products").update({
      review_status: "rejected",
      review_reason: parsed.data.reason,
      reviewed_at: (/* @__PURE__ */ new Date()).toISOString(),
      reviewed_by: req.uid,
      status: "draft",
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("id", productId);
    if (error) throw new Error(`Could not reject the product: ${error.message}`);
    await recordAudit(req.uid, "product.reject", "products", productId, { reason: parsed.data.reason });
    res.json({ success: true });
  })
);
router10.patch(
  "/moderation/:id/flag",
  asyncRoute(async (req, res) => {
    const parsed = ReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const productId = req.params.id;
    const product = await loadProductOr404(productId, res);
    if (!product) return;
    const { error } = await getSupabase().from("products").update({
      flagged: true,
      flag_reason: parsed.data.reason,
      review_status: "flagged",
      reviewed_at: (/* @__PURE__ */ new Date()).toISOString(),
      reviewed_by: req.uid,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("id", productId);
    if (error) throw new Error(`Could not flag the product: ${error.message}`);
    await recordAudit(req.uid, "product.flag", "products", productId, { reason: parsed.data.reason });
    res.json({ success: true });
  })
);
router10.get(
  "/flagged",
  asyncRoute(async (_req, res) => {
    const { data, error } = await getSupabase().from("products").select(PRODUCT_COLUMNS).not("auto_flag_reason", "is", null).order("created_at", { ascending: false });
    if (error) {
      if (error.code === "42703") {
        const unavailable = { available: false, items: [] };
        res.json(unavailable);
        return;
      }
      throw new Error(`Could not load flagged listings: ${error.message}`);
    }
    const items = data.map((row) => ({
      ...toProduct(row),
      autoFlagReason: row.auto_flag_reason
    }));
    const result = { available: true, items };
    res.json(result);
  })
);
router10.get(
  "/audit",
  asyncRoute(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const { data, error } = await getSupabase().from("audit_log").select("id, actor_id, action, target_table, target_id, reason, metadata, created_at").order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(`Could not load the audit log: ${error.message}`);
    const rows = data ?? [];
    const actorIds = [...new Set(rows.map((row) => row.actor_id).filter((id) => Boolean(id)))];
    let emailById = /* @__PURE__ */ new Map();
    if (actorIds.length > 0) {
      const { data: actors, error: actorsError } = await getSupabase().from("users").select("id, email").in("id", actorIds);
      if (actorsError) throw new Error(`Could not load audit actors: ${actorsError.message}`);
      emailById = new Map((actors ?? []).map((actor) => [actor.id, actor.email]));
    }
    const entries = rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorEmail: row.actor_id ? emailById.get(row.actor_id) ?? null : null,
      action: row.action,
      targetTable: row.target_table,
      targetId: row.target_id,
      reason: row.reason,
      metadata: row.metadata,
      createdAt: row.created_at
    }));
    res.json(entries);
  })
);
var internalConsole_default = router10;

// server/routes/passport.ts
import { Router as Router11 } from "express";
var router11 = Router11();
router11.get(
  "/:passportId",
  asyncRoute(async (req, res) => {
    const passportId = req.params.passportId;
    const { data, error } = await getSupabase().from("products").select(PRODUCT_COLUMNS).eq("passport_id", passportId).eq("status", "published").eq("flagged", false).maybeSingle();
    if (error) throw new Error(`Could not load the passport: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: "Passport not found" });
      return;
    }
    const row = data;
    const passport = {
      passportId: row.passport_id,
      titleEn: row.title_en,
      titleLocal: row.title_local,
      localLanguage: row.local_language,
      category: row.category,
      technique: row.technique,
      material: row.material,
      timeTaken: row.time_taken,
      giTag: row.gi_tag,
      careInstructions: row.care_instructions,
      imageUrl: row.image_url,
      artisanName: row.artisan_name,
      region: row.region,
      createdAt: row.created_at,
      productStory: row.product_story
    };
    res.json(passport);
  })
);
var passport_default = router11;

// server/routes/analytics.ts
import { Router as Router12 } from "express";
import { z as z12 } from "zod";
var router12 = Router12();
var VIEWS_WINDOW_DAYS = 30;
var WEEK_DAYS = 7;
var MAX_VIEW_ROWS = 5e3;
var MAX_INQUIRY_ROWS = 2e3;
var RecordViewSchema = z12.object({
  productId: z12.string().uuid()
});
router12.post(
  "/view",
  requireAuth,
  requireRole("buyer"),
  asyncRoute(async (req, res) => {
    const parsed = RecordViewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const supabase = getSupabase();
    const { data: product, error: productError } = await supabase.from("products").select("id, status, flagged").eq("id", parsed.data.productId).maybeSingle();
    if (productError) throw new Error(`Could not look up the product: ${productError.message}`);
    if (!product || product.status !== "published" || product.flagged) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    const { data: buyer, error: buyerError } = await supabase.from("users").select("region").eq("id", req.uid).maybeSingle();
    if (buyerError) throw new Error(`Could not look up the buyer profile: ${buyerError.message}`);
    const { error } = await supabase.from("product_views").insert({
      product_id: product.id,
      viewer_role: "buyer",
      region: buyer?.region ?? null
    });
    if (error) throw new Error(`Could not record the view: ${error.message}`);
    res.status(201).json({ success: true });
  })
);
router12.get(
  "/summary",
  requireAuth,
  requireRole("artisan"),
  asyncRoute(async (req, res) => {
    const supabase = getSupabase();
    const { data: products, error: productsError } = await supabase.from("products").select("id, title_en, status, flagged").eq("user_id", req.uid);
    if (productsError) throw new Error(`Could not load your products: ${productsError.message}`);
    const rows = products ?? [];
    const productIds = rows.map((row) => row.id);
    const activeListings = rows.filter((row) => row.status === "published" && !row.flagged).length;
    if (productIds.length === 0) {
      const empty = {
        totalViews: 0,
        viewsThisWeek: 0,
        totalInquiries: 0,
        activeListings: 0,
        viewsOverTime: buildEmptyDailySeries(),
        listings: []
      };
      res.json(empty);
      return;
    }
    const weekAgo = new Date(Date.now() - WEEK_DAYS * 24 * 60 * 60 * 1e3).toISOString();
    const windowAgo = new Date(Date.now() - VIEWS_WINDOW_DAYS * 24 * 60 * 60 * 1e3).toISOString();
    const [totalViewsResult, viewsThisWeekResult, totalInquiriesResult, viewRowsResult, inquiryRowsResult] = await Promise.all([
      supabase.from("product_views").select("id", { count: "exact", head: true }).in("product_id", productIds),
      supabase.from("product_views").select("id", { count: "exact", head: true }).in("product_id", productIds).gte("created_at", weekAgo),
      supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("artisan_id", req.uid),
      supabase.from("product_views").select("product_id, created_at").in("product_id", productIds).gte("created_at", windowAgo).order("created_at", { ascending: false }).limit(MAX_VIEW_ROWS),
      supabase.from("inquiries").select("product_id, created_at").eq("artisan_id", req.uid).gte("created_at", windowAgo).order("created_at", { ascending: false }).limit(MAX_INQUIRY_ROWS)
    ]);
    for (const result of [totalViewsResult, viewsThisWeekResult, totalInquiriesResult, viewRowsResult, inquiryRowsResult]) {
      if (result.error) throw new Error(`Could not load analytics: ${result.error.message}`);
    }
    const viewRows = viewRowsResult.data ?? [];
    const inquiryRows = inquiryRowsResult.data ?? [];
    const viewsOverTime = buildDailySeries(viewRows.map((row) => row.created_at));
    const viewCountByProduct = /* @__PURE__ */ new Map();
    for (const row of viewRows) {
      viewCountByProduct.set(row.product_id, (viewCountByProduct.get(row.product_id) ?? 0) + 1);
    }
    const inquiryCountByProduct = /* @__PURE__ */ new Map();
    for (const row of inquiryRows) {
      inquiryCountByProduct.set(row.product_id, (inquiryCountByProduct.get(row.product_id) ?? 0) + 1);
    }
    const listings = rows.map((row) => ({
      productId: row.id,
      titleEn: row.title_en,
      status: row.status,
      viewCount: viewCountByProduct.get(row.id) ?? 0,
      inquiryCount: inquiryCountByProduct.get(row.id) ?? 0
    })).sort((a, b) => b.viewCount - a.viewCount);
    const summary = {
      totalViews: totalViewsResult.count ?? 0,
      viewsThisWeek: viewsThisWeekResult.count ?? 0,
      totalInquiries: totalInquiriesResult.count ?? 0,
      activeListings,
      viewsOverTime,
      listings
    };
    res.json(summary);
  })
);
function buildEmptyDailySeries() {
  return buildDailySeries([]);
}
function buildDailySeries(timestamps) {
  const byDay = /* @__PURE__ */ new Map();
  for (const timestamp of timestamps) {
    const day = timestamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const series = [];
  for (let i = VIEWS_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
    series.push({ date, count: byDay.get(date) ?? 0 });
  }
  return series;
}
var analytics_default = router12;

// server/app.ts
var app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/health", health_default);
app.use("/api/auth", auth_default);
app.use("/api/users", users_default);
app.use("/api/products", products_default);
app.use("/api/images", images_default);
app.use("/api/voice", voice_default);
app.use("/api/translate", translate_default);
app.use("/api/pricing", pricing_default);
app.use("/api/inquiries", inquiries_default);
app.use("/api/internal/console", internalConsole_default);
app.use("/api/passport", passport_default);
app.use("/api/analytics", analytics_default);
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});
app.use((err, _req, res, _next) => {
  if (err instanceof PayloadTooLargeError) {
    res.status(413).json({ error: "payload_too_large", message: err.message });
    return;
  }
  console.error("Unhandled request error", err);
  res.status(500).json({ error: "internal_error" });
});
var app_default = app;

// server/vercel.ts
function handler(req, res) {
  app_default(req, res);
}
export {
  handler as default
};
