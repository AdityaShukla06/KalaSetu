import { Router, Request, Response } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/asyncRoute";
import { getSupabase } from "../lib/supabase";
import { loadEnv } from "../lib/env";
import { signSessionToken } from "../lib/jwt";
import { sendOtpEmail } from "../lib/mailer";
import { UserRole } from "../types";
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MINUTES,
  generateOtp,
  hashOtp,
  normaliseEmail,
  otpMatches,
} from "../lib/otp";

const router = Router();

const RequestOtpSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

const VerifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `OTP must be ${OTP_LENGTH} digits`),
});

router.post(
  "/request-otp",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const email = normaliseEmail(parsed.data.email);
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();
    const supabase = getSupabase();

    const { error } = await supabase.from("otp_codes").insert({
      email,
      code_hash: hashOtp(code),
      expires_at: expiresAt,
    });

    if (error) {
      throw new Error(`Could not store the OTP: ${error.message}`);
    }

    const mail = await sendOtpEmail(email, code);

    res.json({
      success: true,
      emailDelivered: mail.delivered,
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  }),
);

router.post(
  "/verify-otp",
  asyncRoute(async (req: Request, res: Response): Promise<void> => {
    const parsed = VerifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const env = loadEnv();
    const email = normaliseEmail(parsed.data.email);
    const supabase = getSupabase();

    const usedFallback =
      env.DEMO_FALLBACK_OTP_ENABLED && parsed.data.otp === env.DEMO_FALLBACK_OTP;

    if (usedFallback) {
      console.warn(
        "[auth] SECURITY: demo fallback OTP accepted. Set DEMO_FALLBACK_OTP_ENABLED=false to disable.",
        { email },
      );
    } else {
      const { data: rows, error } = await supabase
        .from("otp_codes")
        .select("id, code_hash, expires_at, attempts, consumed_at")
        .eq("email", email)
        .is("consumed_at", null)
        .order("created_at", { ascending: false })
        .limit(1);

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
        await supabase
          .from("otp_codes")
          .update({ attempts: record.attempts + 1 })
          .eq("id", record.id);
        res.status(400).json({ error: "otp_incorrect" });
        return;
      }

      await supabase
        .from("otp_codes")
        .update({ consumed_at: new Date().toISOString() })
        .eq("id", record.id);
    }

    const { userId, role } = await findOrCreateUser(email);
    const token = signSessionToken({ sub: userId, email });

    res.json({ token, userId, email, role });
  }),
);

interface FoundUser {
  userId: string;
  role: UserRole;
}

async function findOrCreateUser(email: string): Promise<FoundUser> {
  const supabase = getSupabase();

  const { data: existing, error: readError } = await supabase
    .from("users")
    .select("id, role")
    .eq("email", email)
    .maybeSingle();

  if (readError) {
    throw new Error(`Could not look up the user: ${readError.message}`);
  }
  if (existing) return { userId: existing.id, role: existing.role };

  const { data: created, error: writeError } = await supabase
    .from("users")
    .insert({ email })
    .select("id, role")
    .single();

  if (writeError) {
    if (writeError.code === "23505") {
      const { data: raced } = await supabase
        .from("users")
        .select("id, role")
        .eq("email", email)
        .single();
      if (raced) return { userId: raced.id, role: raced.role };
    }
    throw new Error(`Could not create the user: ${writeError.message}`);
  }

  return { userId: created.id, role: created.role };
}

export default router;
