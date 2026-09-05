import { apiFetch } from "./_helpers";
import type { ProductStatus } from "./products";

export interface AnalyticsDailyPoint {
  date: string;
  count: number;
}

export interface AnalyticsListingStat {
  productId: string;
  titleEn: string;
  status: ProductStatus;
  viewCount: number;
  inquiryCount: number;
}

export interface AnalyticsSummary {
  totalViews: number;
  viewsThisWeek: number;
  totalInquiries: number;
  activeListings: number;
  viewsOverTime: AnalyticsDailyPoint[];
  listings: AnalyticsListingStat[];
}

export function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  return apiFetch("/analytics/summary", { method: "GET" });
}

export function recordProductView(productId: string): Promise<{ success: boolean }> {
  return apiFetch("/analytics/view", {
    method: "POST",
    body: JSON.stringify({ productId }),
  });
}
