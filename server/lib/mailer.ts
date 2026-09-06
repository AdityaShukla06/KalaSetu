import { loadEnv } from "./env";
import { OTP_TTL_MINUTES } from "./otp";
import { InquiryContactPreference } from "../types";

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

const CONTACT_PREFERENCE_LABEL: Record<InquiryContactPreference, string> = {
  email: "Email",
  phone: "A phone call",
  whatsapp: "WhatsApp",
};

export interface InquiryMailInput {
  artisanEmail: string;
  productTitle: string;
  productImageUrl: string;
  passportId: string;
  buyerMessage: string;
  quantity: number | null;
  contactPreference: InquiryContactPreference;
  contactValue: string | null;
  buyerEmail: string;
  inboxUrl: string;
}

export async function sendInquiryEmail(input: InquiryMailInput): Promise<OtpMailResult> {
  const env = loadEnv();

  if (!env.RESEND_API_KEY) {
    console.warn("[inquiries] RESEND_API_KEY is not set, inquiry email was not sent", {
      artisanEmail: input.artisanEmail,
    });
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
        to: [input.artisanEmail],
        subject: `New inquiry on KalaSetu: ${input.productTitle}`,
        text: buildInquiryPlainTextBody(input),
        html: buildInquiryHtmlBody(input),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[inquiries] inquiry email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }

    return { delivered: true };
  } catch (err) {
    console.error("[inquiries] inquiry email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}

function contactLine(input: InquiryMailInput): string {
  const label = CONTACT_PREFERENCE_LABEL[input.contactPreference];
  if (input.contactPreference === "email") return `${label}: ${input.buyerEmail}`;
  return `${label}: ${input.contactValue ?? input.buyerEmail}`;
}

function buildInquiryPlainTextBody(input: InquiryMailInput): string {
  const lines = [
    `You have a new inquiry on KalaSetu.`,
    ``,
    `Product: ${input.productTitle} (${input.passportId})`,
  ];
  if (input.quantity) lines.push(`Quantity interested in: ${input.quantity}`);
  lines.push(``, `Message:`, `"${input.buyerMessage}"`, ``, `Preferred contact: ${contactLine(input)}`, ``);
  lines.push(`View and respond in KalaSetu: ${input.inboxUrl}`);
  return lines.join("\n");
}

function buildInquiryHtmlBody(input: InquiryMailInput): string {
  const quantityRow = input.quantity
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 12px"><strong>Quantity interested in:</strong> ${input.quantity}</p>`
    : "";

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

export interface InquiryReplyMailInput {
  buyerEmail: string;
  artisanName: string;
  productTitle: string;
  productImageUrl: string;
  passportId: string;
  originalMessage: string;
  replyMessage: string;
  inboxUrl: string;
}

export async function sendInquiryReplyEmail(input: InquiryReplyMailInput): Promise<OtpMailResult> {
  const env = loadEnv();

  if (!env.RESEND_API_KEY) {
    console.warn("[inquiries] RESEND_API_KEY is not set, reply email was not sent", {
      buyerEmail: input.buyerEmail,
    });
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
        to: [input.buyerEmail],
        subject: `${input.artisanName} replied about ${input.productTitle} - KalaSetu`,
        text: buildReplyPlainTextBody(input),
        html: buildReplyHtmlBody(input),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[inquiries] reply email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }

    return { delivered: true };
  } catch (err) {
    console.error("[inquiries] reply email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}

function buildReplyPlainTextBody(input: InquiryReplyMailInput): string {
  return [
    `${input.artisanName} replied to your inquiry on KalaSetu.`,
    ``,
    `Product: ${input.productTitle} (${input.passportId})`,
    ``,
    `Your message:`,
    `"${input.originalMessage}"`,
    ``,
    `Reply:`,
    `"${input.replyMessage}"`,
    ``,
    `View this in KalaSetu: ${input.inboxUrl}`,
  ].join("\n");
}

function buildReplyHtmlBody(input: InquiryReplyMailInput): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2b2b2b">
  <h1 style="font-size:20px;margin:0 0 16px">${input.artisanName} replied to your inquiry</h1>
  <img src="${input.productImageUrl}" alt="" style="width:100%;max-width:280px;border-radius:8px;margin:0 0 16px;display:block" />
  <p style="font-size:15px;line-height:1.5;margin:0 0 4px"><strong>${input.productTitle}</strong></p>
  <p style="font-size:13px;color:#6b6b6b;margin:0 0 16px">${input.passportId}</p>
  <p style="font-size:13px;line-height:1.5;margin:0 0 4px;color:#6b6b6b"><strong>Your message</strong></p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 16px;padding:12px;background:#f4f4f4;border-radius:8px">${input.originalMessage}</p>
  <p style="font-size:13px;line-height:1.5;margin:0 0 4px;color:#6b6b6b"><strong>Reply</strong></p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px;padding:12px;background:#FBF4EA;border-radius:8px">${input.replyMessage}</p>
  <a href="${input.inboxUrl}" style="display:inline-block;padding:12px 20px;background:#C1502E;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">View in KalaSetu</a>
</div>`;
}
