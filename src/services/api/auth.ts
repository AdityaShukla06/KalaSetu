import { apiFetch } from "./_helpers";

export const OTP_LENGTH = 4;

export type UserRole = "artisan" | "buyer" | "admin";

export interface RequestOtpResult {
  success: boolean;
  emailDelivered: boolean;
  expiresInMinutes: number;
}

export interface VerifyOtpResult {
  token: string;
  userId: string;
  email: string;
  role: UserRole;
}

export function sendOtp(email: string): Promise<RequestOtpResult> {
  return apiFetch("/auth/request-otp", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function verifyOtp(email: string, otp: string): Promise<VerifyOtpResult> {
  return apiFetch("/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp }),
  });
}
