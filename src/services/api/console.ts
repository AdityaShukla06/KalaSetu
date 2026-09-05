import { apiFetch } from "./_helpers";
import type { Product } from "./products";

export interface ConsoleArtisan {
  userId: string;
  email: string;
  displayName: string | null;
  shopName: string | null;
  region: string | null;
  isActive: boolean;
  totalProducts: number;
  createdAt: string;
}

export interface ConsoleArtisanDetail extends ConsoleArtisan {
  listings: Product[];
}

export interface ArtisanListResult {
  items: ConsoleArtisan[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface DashboardSignupPoint {
  date: string;
  count: number;
}

export interface DashboardStats {
  totalArtisans: number;
  totalBuyers: number;
  totalProducts: number;
  pendingApproval: number;
  totalInquiries: number;
  signupsOverTime: DashboardSignupPoint[];
}

export interface ModerationQueueResult {
  items: Product[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetTable: string;
  targetId: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface FlaggedListing extends Product {
  autoFlagReason: string;
}

export interface FlaggedListingsResult {
  available: boolean;
  items: FlaggedListing[];
}

const BASE = "/internal/console";

export function getDashboardStats(): Promise<DashboardStats> {
  return apiFetch(`${BASE}/dashboard`, { method: "GET" });
}

export function listArtisans(q: string, page: number, limit = 20): Promise<ArtisanListResult> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiFetch(`${BASE}/artisans?${params.toString()}`, { method: "GET" });
}

export function getArtisanDetail(artisanId: string): Promise<ConsoleArtisanDetail> {
  return apiFetch(`${BASE}/artisans/${encodeURIComponent(artisanId)}`, { method: "GET" });
}

export function setArtisanActive(
  artisanId: string,
  isActive: boolean,
  reason?: string,
): Promise<{ success: boolean }> {
  return apiFetch(`${BASE}/artisans/${encodeURIComponent(artisanId)}`, {
    method: "PATCH",
    body: JSON.stringify({ isActive, reason }),
  });
}

export function getModerationQueue(page: number, limit = 20): Promise<ModerationQueueResult> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  return apiFetch(`${BASE}/moderation/queue?${params.toString()}`, { method: "GET" });
}

export function approveListing(productId: string): Promise<{ success: boolean }> {
  return apiFetch(`${BASE}/moderation/${encodeURIComponent(productId)}/approve`, { method: "PATCH" });
}

export function rejectListing(productId: string, reason: string): Promise<{ success: boolean }> {
  return apiFetch(`${BASE}/moderation/${encodeURIComponent(productId)}/reject`, {
    method: "PATCH",
    body: JSON.stringify({ reason }),
  });
}

export function flagListing(productId: string, reason: string): Promise<{ success: boolean }> {
  return apiFetch(`${BASE}/moderation/${encodeURIComponent(productId)}/flag`, {
    method: "PATCH",
    body: JSON.stringify({ reason }),
  });
}

export function getFlaggedListings(): Promise<FlaggedListingsResult> {
  return apiFetch(`${BASE}/flagged`, { method: "GET" });
}

export function getAuditLog(limit = 20): Promise<AuditLogEntry[]> {
  return apiFetch(`${BASE}/audit?limit=${limit}`, { method: "GET" });
}
