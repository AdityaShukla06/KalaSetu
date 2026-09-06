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

export interface InquiryFirstMessageContext {
  quantity: number | null;
  contactPreference: InquiryContactPreference;
  contactValue: string | null;
  buyerEmail: string;
}

export interface InquiryMessageMailInput {
  recipientEmail: string;
  senderName: string;
  productTitle: string;
  productImageUrl: string;
  passportId: string;
  messageBody: string;
  inboxUrl: string;
  firstMessageContext?: InquiryFirstMessageContext;
}

export async function sendInquiryMessageEmail(input: InquiryMessageMailInput): Promise<OtpMailResult> {
  const env = loadEnv();

  if (!env.RESEND_API_KEY) {
    console.warn("[inquiries] RESEND_API_KEY is not set, message email was not sent", {
      recipientEmail: input.recipientEmail,
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
        to: [input.recipientEmail],
        subject: `${input.senderName} sent a message about ${input.productTitle} - KalaSetu`,
        text: buildMessagePlainTextBody(input),
        html: buildMessageHtmlBody(input),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[inquiries] message email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }

    return { delivered: true };
  } catch (err) {
    console.error("[inquiries] message email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}

function contactLine(context: InquiryFirstMessageContext): string {
  const label = CONTACT_PREFERENCE_LABEL[context.contactPreference];
  if (context.contactPreference === "email") return `${label}: ${context.buyerEmail}`;
  return `${label}: ${context.contactValue ?? context.buyerEmail}`;
}

function buildMessagePlainTextBody(input: InquiryMessageMailInput): string {
  const lines = [
    `${input.senderName} sent a message about your inquiry on KalaSetu.`,
    ``,
    `Product: ${input.productTitle} (${input.passportId})`,
  ];
  if (input.firstMessageContext?.quantity) {
    lines.push(`Quantity interested in: ${input.firstMessageContext.quantity}`);
  }
  lines.push(``, `Message:`, `"${input.messageBody}"`, ``);
  if (input.firstMessageContext) {
    lines.push(`Preferred contact: ${contactLine(input.firstMessageContext)}`, ``);
  }
  lines.push(`View and reply in KalaSetu: ${input.inboxUrl}`);
  return lines.join("\n");
}

function buildMessageHtmlBody(input: InquiryMessageMailInput): string {
  const quantityRow = input.firstMessageContext?.quantity
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 12px"><strong>Quantity interested in:</strong> ${input.firstMessageContext.quantity}</p>`
    : "";
  const contactRow = input.firstMessageContext
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 20px"><strong>Preferred contact:</strong> ${contactLine(input.firstMessageContext)}</p>`
    : "";

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2b2b2b">
  <h1 style="font-size:20px;margin:0 0 16px">${input.senderName} sent you a message</h1>
  <img src="${input.productImageUrl}" alt="" style="width:100%;max-width:280px;border-radius:8px;margin:0 0 16px;display:block" />
  <p style="font-size:15px;line-height:1.5;margin:0 0 4px"><strong>${input.productTitle}</strong></p>
  <p style="font-size:13px;color:#6b6b6b;margin:0 0 16px">${input.passportId}</p>
  ${quantityRow}
  <p style="font-size:14px;line-height:1.5;margin:0 0 16px;padding:12px;background:#FBF4EA;border-radius:8px">${input.messageBody}</p>
  ${contactRow}
  <a href="${input.inboxUrl}" style="display:inline-block;padding:12px 20px;background:#C1502E;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">View and reply in KalaSetu</a>
</div>`;
}

export interface DeactivationMailInput {
  artisanEmail: string;
  reason: string;
  ticketUrl: string;
}

export async function sendDeactivationEmail(input: DeactivationMailInput): Promise<OtpMailResult> {
  const env = loadEnv();

  if (!env.RESEND_API_KEY) {
    console.warn("[moderation] RESEND_API_KEY is not set, deactivation email was not sent", {
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
        subject: "Your KalaSetu account has been deactivated",
        text: buildDeactivationPlainTextBody(input),
        html: buildDeactivationHtmlBody(input),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[moderation] deactivation email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }

    return { delivered: true };
  } catch (err) {
    console.error("[moderation] deactivation email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}

function buildDeactivationPlainTextBody(input: DeactivationMailInput): string {
  return [
    `Your KalaSetu artisan account has been deactivated by an admin.`,
    ``,
    `Reason: ${input.reason}`,
    ``,
    `If you believe this is a mistake, you can raise a ticket and an admin will review it:`,
    input.ticketUrl,
  ].join("\n");
}

function buildDeactivationHtmlBody(input: DeactivationMailInput): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2b2b2b">
  <h1 style="font-size:20px;margin:0 0 16px">Your account has been deactivated</h1>
  <p style="font-size:14px;line-height:1.5;margin:0 0 4px;color:#6b6b6b"><strong>Reason</strong></p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px;padding:12px;background:#f4f4f4;border-radius:8px">${input.reason}</p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px">If you believe this is a mistake, you can raise a ticket and an admin will review it.</p>
  <a href="${input.ticketUrl}" style="display:inline-block;padding:12px 20px;background:#C1502E;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Raise a ticket</a>
</div>`;
}

export interface ProductRemovedMailInput {
  artisanEmail: string;
  productTitle: string;
  reason: string;
  ticketUrl: string;
}

export async function sendProductRemovedEmail(input: ProductRemovedMailInput): Promise<OtpMailResult> {
  const env = loadEnv();

  if (!env.RESEND_API_KEY) {
    console.warn("[moderation] RESEND_API_KEY is not set, product removal email was not sent", {
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
        subject: `Your listing "${input.productTitle}" was removed from KalaSetu`,
        text: buildProductRemovedPlainTextBody(input),
        html: buildProductRemovedHtmlBody(input),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[moderation] product removed email provider rejected the request", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return { delivered: false, reason: `provider_error_${response.status}` };
    }

    return { delivered: true };
  } catch (err) {
    console.error("[moderation] product removed email send failed", err);
    return { delivered: false, reason: "send_failed" };
  }
}

function buildProductRemovedPlainTextBody(input: ProductRemovedMailInput): string {
  return [
    `Your KalaSetu listing "${input.productTitle}" has been permanently removed by an admin.`,
    ``,
    `Reason: ${input.reason}`,
    ``,
    `This removal cannot be undone and the listing cannot be restored. If you have questions about it, you can raise a ticket:`,
    input.ticketUrl,
  ].join("\n");
}

function buildProductRemovedHtmlBody(input: ProductRemovedMailInput): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2b2b2b">
  <h1 style="font-size:20px;margin:0 0 16px">Your listing was removed</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 16px"><strong>${input.productTitle}</strong></p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 4px;color:#6b6b6b"><strong>Reason</strong></p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px;padding:12px;background:#f4f4f4;border-radius:8px">${input.reason}</p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px">This removal is permanent and the listing cannot be restored. If you have questions about it, you can raise a ticket.</p>
  <a href="${input.ticketUrl}" style="display:inline-block;padding:12px 20px;background:#C1502E;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Raise a ticket</a>
</div>`;
}
