import { apiFetch } from "./_helpers";

export type InquiryStatus = "open" | "closed";
export type InquiryContactPreference = "email" | "phone" | "whatsapp";

export interface InquiryProductSummary {
  titleEn: string;
  titleLocal: string;
  localLanguage: string;
  imageUrl: string;
  price: number;
  passportId: string;
}

export interface Inquiry {
  inquiryId: string;
  productId: string;
  buyerId: string;
  buyerEmail: string | null;
  artisanId: string;
  message: string;
  quantity: number | null;
  contactPreference: InquiryContactPreference;
  contactValue: string | null;
  status: InquiryStatus;
  readAt: string | null;
  respondedAt: string | null;
  notifiedAt: string | null;
  createdAt: string;
  product: InquiryProductSummary | null;
}

export interface CreateInquiryInput {
  productId: string;
  message: string;
  quantity?: number;
  contactPreference: InquiryContactPreference;
  contactValue?: string;
}

export function createInquiry(input: CreateInquiryInput): Promise<{ inquiryId: string; emailDelivered: boolean }> {
  return apiFetch("/inquiries", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listMyInquiries(): Promise<Inquiry[]> {
  return apiFetch("/inquiries/mine", { method: "GET" });
}

export function listReceivedInquiries(): Promise<Inquiry[]> {
  return apiFetch("/inquiries/received", { method: "GET" });
}

export function closeInquiry(inquiryId: string): Promise<{ success: boolean }> {
  return apiFetch(`/inquiries/${encodeURIComponent(inquiryId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "closed" }),
  });
}

export function markInquiryResponded(inquiryId: string): Promise<{ success: boolean }> {
  return apiFetch(`/inquiries/${encodeURIComponent(inquiryId)}/responded`, {
    method: "PATCH",
  });
}
