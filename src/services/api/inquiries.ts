import { apiFetch } from "./_helpers";

export type InquiryStatus = "open" | "closed";

export interface InquiryProductSummary {
  titleEn: string;
  titleLocal: string;
  localLanguage: string;
  imageUrl: string;
  price: number;
}

export interface Inquiry {
  inquiryId: string;
  productId: string;
  buyerId: string;
  artisanId: string;
  message: string;
  status: InquiryStatus;
  createdAt: string;
  product: InquiryProductSummary | null;
}

export function createInquiry(productId: string, message: string): Promise<{ inquiryId: string }> {
  return apiFetch("/inquiries", {
    method: "POST",
    body: JSON.stringify({ productId, message }),
  });
}

export function listMyInquiries(): Promise<Inquiry[]> {
  return apiFetch("/inquiries/mine", { method: "GET" });
}

export function closeInquiry(inquiryId: string): Promise<{ success: boolean }> {
  return apiFetch(`/inquiries/${encodeURIComponent(inquiryId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "closed" }),
  });
}
