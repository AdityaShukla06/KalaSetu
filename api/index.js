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

// server/routes/health.ts
var BASE_REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"];
var OPTIONAL_EXTRA = ["VOICE_AI_PROVIDER", "GROQ_API_KEY", "GEMINI_API_KEY"];
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

// server/routes/auth.ts
var router2 = Router2();
var RequestOtpSchema = z2.object({
  email: z2.string().email("Enter a valid email address")
});
var VerifyOtpSchema = z2.object({
  email: z2.string().email(),
  otp: z2.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `OTP must be ${OTP_LENGTH} digits`)
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
    const userId = await findOrCreateUser(email);
    const token = signSessionToken({ sub: userId, email });
    res.json({ token, userId, email });
  })
);
async function findOrCreateUser(email) {
  const supabase = getSupabase();
  const { data: existing, error: readError } = await supabase.from("users").select("id").eq("email", email).maybeSingle();
  if (readError) {
    throw new Error(`Could not look up the user: ${readError.message}`);
  }
  if (existing) return existing.id;
  const { data: created, error: writeError } = await supabase.from("users").insert({ email }).select("id").single();
  if (writeError) {
    if (writeError.code === "23505") {
      const { data: raced } = await supabase.from("users").select("id").eq("email", email).single();
      if (raced) return raced.id;
    }
    throw new Error(`Could not create the user: ${writeError.message}`);
  }
  return created.id;
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

// server/routes/users.ts
var router3 = Router3();
function toUserProfile(row) {
  return {
    userId: row.id,
    email: row.email,
    displayName: row.display_name,
    shopName: row.shop_name,
    language: isAppLanguage(row.language) ? row.language : "en",
    totalProducts: row.total_products,
    createdAt: row.created_at
  };
}
router3.get(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase.from("users").select("id, email, display_name, shop_name, language, total_products, created_at").eq("id", req.uid).maybeSingle();
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
import { z as z4 } from "zod";
var router4 = Router4();
var PRODUCT_COLUMNS = "id, user_id, category, title_en, title_local, description_en, description_local, local_language, image_url, price, material_cost, status, created_at, updated_at";
function toProduct(row) {
  return {
    productId: row.id,
    userId: row.user_id,
    category: row.category,
    titleEn: row.title_en,
    titleLocal: row.title_local,
    descriptionEn: row.description_en,
    descriptionLocal: row.description_local,
    localLanguage: row.local_language,
    imageUrl: row.image_url,
    price: Number(row.price),
    materialCost: Number(row.material_cost),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
var ProductInputSchema = z4.object({
  category: z4.string().min(1),
  titleEn: z4.string().min(1),
  titleLocal: z4.string().min(1),
  descriptionEn: z4.string().min(1),
  descriptionLocal: z4.string().min(1),
  localLanguage: z4.string().min(2).max(8),
  imageUrl: z4.string().url(),
  price: z4.number().positive(),
  materialCost: z4.number().positive()
});
function toRow(input) {
  const row = {};
  if (input.category !== void 0) row.category = input.category;
  if (input.titleEn !== void 0) row.title_en = input.titleEn;
  if (input.titleLocal !== void 0) row.title_local = input.titleLocal;
  if (input.descriptionEn !== void 0) row.description_en = input.descriptionEn;
  if (input.descriptionLocal !== void 0) row.description_local = input.descriptionLocal;
  if (input.localLanguage !== void 0) row.local_language = input.localLanguage;
  if (input.imageUrl !== void 0) row.image_url = input.imageUrl;
  if (input.price !== void 0) row.price = input.price;
  if (input.materialCost !== void 0) row.material_cost = input.materialCost;
  return row;
}
router4.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = ProductInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase.from("products").insert({ ...toRow(parsed.data), user_id: req.uid, status: "published" }).select("id").single();
    if (error) throw new Error(`Could not create the product: ${error.message}`);
    await supabase.rpc("increment_total_products", { target_user: req.uid, delta: 1 });
    res.status(201).json({ productId: data.id });
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
    const { data, error } = await getSupabase().from("products").select(PRODUCT_COLUMNS).eq("user_id", req.uid).order("created_at", { ascending: false });
    if (error) throw new Error(`Could not list products: ${error.message}`);
    res.json(data.map(toProduct));
  })
);
router4.patch(
  "/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = ProductInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase.from("products").update({ ...toRow(parsed.data), updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", req.params.id).eq("user_id", req.uid).select("id");
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
var products_default = router4;

// server/routes/images.ts
import { Router as Router5 } from "express";
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

// server/services/imageEnhancer.ts
import sharp from "sharp";
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
async function enhanceProductImage(input) {
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
      height: info.height
    };
  } catch (err) {
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
  asyncRoute(async (req, res) => {
    try {
      const raw = await readRawBody(req, MAX_IMAGE_BYTES);
      if (raw.length === 0) {
        res.status(400).json({ error: "No image data provided" });
        return;
      }
      const processed = await enhanceProductImage(raw);
      const path = `${req.uid}/enhanced/${Date.now()}-${randomUUID().slice(0, 8)}.jpg`;
      const enhancedImageUrl = await storeImage(processed.buffer, path, processed.mimeType);
      res.json({ enhancedImageUrl, width: processed.width, height: processed.height });
    } catch (err) {
      if (handleImageError(err, res)) return;
      throw err;
    }
  })
);
var images_default = router5;

// server/routes/voice.ts
import { Router as Router6 } from "express";

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
import { z as z5 } from "zod";
var envSchema2 = z5.object({
  VOICE_AI_PROVIDER: z5.enum(["groq", "gemini"]).default("groq"),
  GROQ_API_KEY: z5.string().optional(),
  GROQ_STT_MODEL: z5.string().default("whisper-large-v3"),
  GROQ_LLM_MODEL: z5.string().default("openai/gpt-oss-120b"),
  GROQ_LLM_FALLBACK_MODEL: z5.string().default("openai/gpt-oss-20b"),
  GEMINI_API_KEY: z5.string().optional(),
  GEMINI_TRANSCRIBE_MODEL: z5.string().default("gemini-3.6-flash"),
  GEMINI_FLASH_MODEL: z5.string().default("gemini-3.6-flash")
}).superRefine((env, ctx) => {
  if (env.VOICE_AI_PROVIDER === "groq" && !env.GROQ_API_KEY) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
      path: ["GROQ_API_KEY"],
      message: "GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq"
    });
  }
  if (env.VOICE_AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    ctx.addIssue({
      code: z5.ZodIssueCode.custom,
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
async function processVoiceDescription(input, deps) {
  const logger = deps.logger ?? noopLogger;
  logger.info("voice-ai: starting pipeline", { category: input.category, audioBytes: input.audio?.length });
  try {
    const sttResult = await deps.sttService.transcribe(input.audio, input.mimeType);
    logger.info("voice-ai: stt complete", { detectedLanguage: sttResult.language });
    const transcript = sttResult.text;
    const detectedLanguage = sttResult.language;
    const englishTranscript = detectedLanguage === "en" ? transcript : await deps.translationService.translate(transcript, detectedLanguage, "en");
    if (detectedLanguage !== "en") {
      logger.info("voice-ai: regional -> English translation complete");
    }
    const descriptionEn = await deps.descriptionService.generateDescription(englishTranscript, input.category);
    logger.info("voice-ai: description generation complete");
    const localLanguage = input.targetLanguage || "en";
    const descriptionLocal = localLanguage === "en" ? descriptionEn : await deps.translationService.translate(descriptionEn, "en", localLanguage);
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
  apiKey;
  model;
  constructor(env) {
    if (!env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.apiKey = env.GROQ_API_KEY;
    this.model = env.GROQ_STT_MODEL;
  }
  async transcribe(audio, mimeType) {
    if (!audio || audio.length === 0) {
      throw new InvalidAudioError();
    }
    const audioMimeType = normaliseAudioMimeType(mimeType, GROQ_SUPPORTED_AUDIO_TYPES);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: audioMimeType }), `recording.${extensionForAudio(audioMimeType)}`);
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append(
      "prompt",
      "An Indian artisan describing a handmade product in their own language."
    );
    let payload;
    try {
      const response = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new InvalidAudioError(
          `Transcription provider returned ${response.status}`,
          detail.slice(0, 500)
        );
      }
      payload = await response.json();
    } catch (err) {
      if (err instanceof InvalidAudioError) throw err;
      throw new InvalidAudioError("Speech-to-text provider rejected or failed to process the audio", err);
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
  constructor(model, detail) {
    super(`Groq rate limit reached for ${model}: ${detail}`);
    this.name = "GroqRateLimitError";
  }
};
async function callModel(options, model) {
  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
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
  try {
    return await callModel(options, options.model);
  } catch (err) {
    const fallback = options.fallbackModel;
    if (!(err instanceof GroqRateLimitError) || !fallback || fallback === options.model) {
      throw err;
    }
    console.warn("[voice-ai] primary model rate limited, falling back", {
      from: options.model,
      to: fallback
    });
    return await callModel(options, fallback);
  }
}

// server/voice-ai/translation/groq-translation.service.ts
var GroqTranslationService = class {
  apiKey;
  model;
  fallbackModel;
  constructor(env) {
    if (!env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.apiKey = env.GROQ_API_KEY;
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
        apiKey: this.apiKey,
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

// server/voice-ai/description/groq-description.service.ts
var GroqDescriptionService = class {
  apiKey;
  model;
  fallbackModel;
  constructor(env) {
    if (!env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is required when VOICE_AI_PROVIDER is groq");
    }
    this.apiKey = env.GROQ_API_KEY;
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
        apiKey: this.apiKey,
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

// server/routes/voice.ts
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

// server/routes/pricing.ts
import { Router as Router7 } from "express";
import { z as z6 } from "zod";

// server/services/pricingEngine.ts
var CATEGORY_DATASET = {
  textiles: {
    name: "Textiles",
    materialShare: 0.2,
    rangeDown: 0.1,
    rangeUp: 0.2,
    categoryReliabilityScore: 20
  },
  pottery: {
    name: "Pottery",
    materialShare: 0.25,
    rangeDown: 0.15,
    rangeUp: 0.2,
    categoryReliabilityScore: 15
  },
  jewelry: {
    name: "Jewelry",
    materialShare: 0.16,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 20
  },
  woodwork: {
    name: "Woodwork",
    materialShare: 0.16,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 20
  },
  "bamboo-cane": {
    name: "Bamboo & Cane",
    materialShare: 0.2,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 15
  },
  bamboo: {
    name: "Bamboo & Cane",
    materialShare: 0.2,
    rangeDown: 0.15,
    rangeUp: 0.25,
    categoryReliabilityScore: 15
  },
  other: {
    name: "Other Handcrafts",
    materialShare: 0.2,
    rangeDown: 0.15,
    rangeUp: 0.2,
    categoryReliabilityScore: 10
  }
};
var COMPLEXITY_FACTORS = {
  simple: 0.9,
  standard: 1,
  detailed: 1.1,
  complex: 1.2,
  exceptional: 1.3
};
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
function calculateSmartPrice(input) {
  let effectiveMaterialCost = 0;
  if (Array.isArray(input.rawMaterials) && input.rawMaterials.length > 0) {
    effectiveMaterialCost = input.rawMaterials.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
  } else if (typeof input.materialCost === "number" && input.materialCost > 0) {
    effectiveMaterialCost = input.materialCost;
  }
  if (effectiveMaterialCost <= 0) {
    throw new Error("Material cost must be greater than 0");
  }
  const normalizedCategory = (input.category || "other").toLowerCase();
  const categoryConfig = CATEGORY_DATASET[normalizedCategory] || CATEGORY_DATASET["other"];
  const { materialShare, rangeDown, rangeUp, categoryReliabilityScore, name: categoryName } = categoryConfig;
  const fullText = `${input.category || ""} ${input.descriptionEn || ""} ${input.descriptionHi || ""}`.trim();
  const complexity = input.complexity || inferComplexity(fullText);
  const complexityFactor = COMPLEXITY_FACTORS[complexity] || 1;
  const basePrice = effectiveMaterialCost / materialShare;
  const rawRecommendedPrice = basePrice * complexityFactor;
  const rawMinimumPrice = rawRecommendedPrice * (1 - rangeDown);
  const rawMaximumPrice = rawRecommendedPrice * (1 + rangeUp);
  const minimumPrice = roundToSensibleInr(rawMinimumPrice);
  const recommendedPrice = roundToSensibleInr(rawRecommendedPrice);
  const maximumPrice = roundToSensibleInr(rawMaximumPrice);
  const selectedSubcategory = input.subcategory || inferSubcategory(normalizedCategory, fullText);
  const catMarket = MARKET_REFERENCE[normalizedCategory];
  const marketData = selectedSubcategory && catMarket ? catMarket[selectedSubcategory] : void 0;
  const marketAvailable = Boolean(marketData);
  const marketMin = marketData ? marketData.marketMin : null;
  const marketMedian = marketData ? marketData.marketMedian : null;
  const marketMax = marketData ? marketData.marketMax : null;
  const sampleCount = marketData ? marketData.sampleCount : 0;
  const sourceCount = marketData ? marketData.sourceCount : 0;
  let marketDeviation = null;
  let marketAlignmentScore = 0;
  if (marketAvailable && marketMedian && marketMedian > 0) {
    marketDeviation = Math.abs(recommendedPrice - marketMedian) / marketMedian;
    if (sampleCount < 5) {
      marketAlignmentScore = 10;
    } else if (marketMin !== null && marketMax !== null && recommendedPrice >= marketMin && recommendedPrice <= marketMax) {
      marketAlignmentScore = 30;
    } else if (marketDeviation <= 0.25) {
      marketAlignmentScore = 20;
    } else if (marketDeviation <= 0.5) {
      marketAlignmentScore = 10;
    } else {
      marketAlignmentScore = 5;
    }
  } else {
    marketAlignmentScore = 0;
  }
  let marketDataQualityScore = 0;
  if (!marketAvailable) {
    marketDataQualityScore = 0;
  } else if (sampleCount >= 20 && sourceCount >= 3) {
    marketDataQualityScore = 30;
  } else if (sampleCount >= 10 && sourceCount >= 2) {
    marketDataQualityScore = 25;
  } else if (sampleCount >= 5 && sourceCount >= 2) {
    marketDataQualityScore = 20;
  } else if (sampleCount >= 5) {
    marketDataQualityScore = 15;
  } else {
    marketDataQualityScore = 10;
  }
  const marketComponent = Math.min(marketAlignmentScore, marketDataQualityScore);
  let inputScore = 0;
  if (effectiveMaterialCost > 0) inputScore += 10;
  if (CATEGORY_DATASET[normalizedCategory]) inputScore += 5;
  if (input.descriptionEn && input.descriptionEn.trim().length > 0) inputScore += 3;
  if (input.imageUrl && input.imageUrl.startsWith("http")) inputScore += 2;
  let productInformationScore = 0;
  const hasDesc = Boolean(input.descriptionEn && input.descriptionEn.trim());
  const hasImg = Boolean(input.imageUrl && input.imageUrl.startsWith("http"));
  if (hasDesc && hasImg) {
    productInformationScore = 15;
  } else if (hasDesc || hasImg) {
    productInformationScore = 8;
  }
  let calculationValidityScore = 15;
  if (materialShare <= 0 || complexityFactor <= 0 || !Number.isFinite(recommendedPrice) || recommendedPrice <= 0 || minimumPrice <= 0 || maximumPrice <= 0) {
    calculationValidityScore = 0;
  }
  let rawConfidenceScore = inputScore + categoryReliabilityScore + marketComponent + productInformationScore + calculationValidityScore;
  const confidenceScore = Math.max(0, Math.min(100, Math.round(rawConfidenceScore)));
  let confidenceLabel = "Medium";
  if (confidenceScore >= 90) confidenceLabel = "Very High";
  else if (confidenceScore >= 75) confidenceLabel = "High";
  else if (confidenceScore >= 60) confidenceLabel = "Medium";
  else if (confidenceScore >= 40) confidenceLabel = "Low";
  else confidenceLabel = "Very Low";
  let marketExplanation = "";
  if (!marketAvailable) {
    marketExplanation = "Fair artisan value based on material costs and standard handcrafted labor markup.";
  } else if (marketMin !== null && marketMax !== null && recommendedPrice >= marketMin && recommendedPrice <= marketMax) {
    marketExplanation = `Aligns well with market benchmarks for ${selectedSubcategory ? selectedSubcategory : categoryName} (\u20B9${marketMin} - \u20B9${marketMax}).`;
  } else if (marketDeviation !== null && marketDeviation <= 0.25) {
    marketExplanation = `Within 25% of market median (\u20B9${marketMedian}) for similar artisanal items.`;
  } else if (marketDeviation !== null && marketDeviation <= 0.5) {
    marketExplanation = `Differs moderately from market median (\u20B9${marketMedian}) due to customized craft complexity.`;
  } else {
    marketExplanation = `Reflects premium handcrafted value based on material input and craftsmanship.`;
  }
  let materialNote = `\u20B9${effectiveMaterialCost} material cost`;
  if (Array.isArray(input.rawMaterials) && input.rawMaterials.length > 1) {
    materialNote = `\u20B9${effectiveMaterialCost} itemized materials (${input.rawMaterials.map((m) => m.name || "item").slice(0, 3).join(", ")})`;
  }
  const complexityNote = complexity === "simple" ? "simple artisan craft" : complexity === "complex" || complexity === "exceptional" ? "intricate artisanal craftsmanship" : "standard handcrafted technique";
  const reason = `Based on ${materialNote}, ${categoryName} labor margin (${Math.round(
    (1 - materialShare) * 100
  )}%), and ${complexityNote}. ${marketExplanation}`;
  return {
    success: true,
    suggestedMin: minimumPrice,
    suggestedMax: maximumPrice,
    recommendedPrice,
    minimumPrice,
    maximumPrice,
    reason,
    reasoning: reason,
    confidenceScore,
    confidenceLabel,
    marketReference: {
      available: marketAvailable,
      min: marketMin,
      median: marketMedian,
      max: marketMax,
      sampleCount,
      sourceCount
    },
    breakdown: {
      materialCost: effectiveMaterialCost,
      rawMaterials: input.rawMaterials,
      basePrice: roundToSensibleInr(basePrice),
      complexity,
      complexityFactor,
      materialShare,
      categoryName,
      subcategory: selectedSubcategory
    }
  };
}

// server/routes/pricing.ts
var router7 = Router7();
var RawMaterialSchema = z6.object({
  name: z6.string().min(1),
  cost: z6.number().positive(),
  quantity: z6.union([z6.number(), z6.string()]).optional(),
  unit: z6.string().optional()
});
var PricingInputSchema = z6.object({
  category: z6.string().min(1),
  materialCost: z6.number().positive().optional(),
  rawMaterials: z6.array(RawMaterialSchema).optional(),
  descriptionEn: z6.string().optional(),
  descriptionHi: z6.string().optional(),
  imageUrl: z6.string().url().optional().or(z6.literal("")),
  complexity: z6.enum(["simple", "standard", "detailed", "complex", "exceptional"]).optional(),
  subcategory: z6.string().optional()
}).refine(
  (data) => data.materialCost !== void 0 && data.materialCost > 0 || data.rawMaterials && data.rawMaterials.length > 0,
  {
    message: "Either materialCost or rawMaterials must be provided with positive values",
    path: ["materialCost"]
  }
);
router7.post(
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
var pricing_default = router7;

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
app.use("/api/pricing", pricing_default);
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
