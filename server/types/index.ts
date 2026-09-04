export type UserRole = "artisan" | "buyer" | "admin";

export const USER_ROLES: UserRole[] = ["artisan", "buyer", "admin"];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as string[]).includes(value);
}

export type ProductStatus = "draft" | "published" | "failed";

export interface ProductInput {
  category: string;
  titleEn: string;
  titleLocal: string;
  descriptionEn: string;
  descriptionLocal: string;
  localLanguage: string;
  imageUrl: string;
  price: number;
  materialCost: number;
}

export interface Product extends ProductInput {
  productId: string;
  userId: string;
  status: ProductStatus;
  flagged: boolean;
  flagReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type InquiryStatus = "open" | "closed";

export interface Inquiry {
  inquiryId: string;
  productId: string;
  buyerId: string;
  artisanId: string;
  message: string;
  status: InquiryStatus;
  createdAt: string;
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string | null;
  shopName: string | null;
  language: string;
  role: UserRole;
  totalProducts: number;
  createdAt: string;
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
