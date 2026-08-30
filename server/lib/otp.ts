import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const OTP_LENGTH = 4;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

export function generateOtp(): string {
  return randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, "0");
}

export function hashOtp(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function otpMatches(candidate: string, expectedHash: string): boolean {
  const a = Buffer.from(hashOtp(candidate), "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
