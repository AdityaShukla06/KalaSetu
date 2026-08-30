import { loadEnv } from "./env";
import { OTP_TTL_MINUTES } from "./otp";

export interface OtpMailResult {
  delivered: boolean;
  reason?: string;
}

export async function sendOtpEmail(email: string, code: string): Promise<OtpMailResult> {
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
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.OTP_FROM_EMAIL,
        to: [email],
        subject: `${code} is your KalaSetu code`,
        text: buildPlainTextBody(code),
        html: buildHtmlBody(code),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[auth] OTP email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }

    return { delivered: true };
  } catch (err) {
    console.error("[auth] OTP email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}

function buildPlainTextBody(code: string): string {
  return [
    `Your KalaSetu verification code is ${code}.`,
    ``,
    `It expires in ${OTP_TTL_MINUTES} minutes.`,
    `If you did not ask to sign in, you can ignore this email.`,
  ].join("\n");
}

function buildHtmlBody(code: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#2b2b2b">
  <h1 style="font-size:20px;margin:0 0 16px">Your KalaSetu code</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 20px">Enter this code to sign in.</p>
  <p style="font-size:34px;font-weight:700;letter-spacing:10px;margin:0 0 20px;color:#C1502E">${code}</p>
  <p style="font-size:13px;line-height:1.5;color:#6b6b6b;margin:0">It expires in ${OTP_TTL_MINUTES} minutes. If you did not ask to sign in, you can ignore this email.</p>
</div>`;
}
