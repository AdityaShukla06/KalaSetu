export type UserRole = "artisan" | "buyer" | "admin";

export const USER_ROLES: UserRole[] = ["artisan", "buyer", "admin"];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as string[]).includes(value);
}

export type ProductStatus = "draft" | "published" | "failed";

export interface ProductInput {
  category: string;
  material?: string;
  titleEn: string;
  titleLocal: string;
  descriptionEn: string;
  descriptionLocal: string;
  localLanguage: string;
  imageUrl: string;
  price: number;
  materialCost: number;
  technique?: string;
  timeTaken?: string;
  giTag?: string;
  careInstructions?: string;
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "flagged";

export interface Product extends ProductInput {
  productId: string;
  userId: string;
  region: string | null;
  artisanName: string | null;
  status: ProductStatus;
  flagged: boolean;
  flagReason: string | null;
  autoFlagReason: string | null;
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewReason: string | null;
  passportId: string;
  productStory: string | null;
  storyGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicPassport {
  passportId: string;
  titleEn: string;
  titleLocal: string;
  localLanguage: string;
  category: string;
  technique: string | null;
  material: string | null;
  timeTaken: string | null;
  giTag: string | null;
  careInstructions: string | null;
  imageUrl: string;
  artisanName: string | null;
  region: string | null;
  createdAt: string;
  productStory: string | null;
}

export interface ArtisanSummary {
  userId: string;
  shopName: string | null;
  displayName: string | null;
  region: string | null;
  totalProducts: number;
}

export interface ProductWithArtisan extends Product {
  artisan: ArtisanSummary;
}

export interface ProductWithViewCount extends Product {
  viewCount: number;
}

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

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string | null;
  shopName: string | null;
  region: string | null;
  language: string;
  role: UserRole;
  totalProducts: number;
  createdAt: string;
}

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

declare global {
  namespace Express {
    interface Request {
      uid: string;
      email: string;
      role?: UserRole;
    }
  }
}
