import { apiFetch } from "./_helpers";

export const OTP_LENGTH = 4;

export type UserRole = "artisan" | "buyer" | "admin";
export type SelfServeRole = "artisan" | "buyer";

export interface RequestOtpResult {
  success: boolean;
  emailDelivered: boolean;
  expiresInMinutes: number;
  requiresPassword: boolean;
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

export function verifyOtp(
  email: string,
  otp: string,
  intendedRole: SelfServeRole,
): Promise<VerifyOtpResult> {
  return apiFetch("/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp, intendedRole }),
  });
}

export function adminLogin(email: string, password: string): Promise<VerifyOtpResult> {
  return apiFetch("/auth/admin-login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}
