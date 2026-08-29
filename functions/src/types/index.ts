export type ProductStatus = "draft" | "published" | "failed";

export interface ProductInput {
  category: string;
  titleEn: string;
  titleHi: string;
  descriptionEn: string;
  descriptionHi: string;
  imageUrl: string;
  price: number;
  materialCost: number;
}

export interface Product extends ProductInput {
  productId: string;
  userId: string;
  status: ProductStatus;
  rawImageUrl?: string;
  aiPriceMin?: number;
  aiPriceMax?: number;
  transcript?: string;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface UserProfile {
  userId: string;
  phoneNumber: string;
  displayName: string | null;
  shopName: string | null;
  language: "en" | "hi";
  totalProducts: number;
  createdAt: FirebaseFirestore.Timestamp;
}

declare global {
  namespace Express {
    interface Request {
      uid: string;
      phoneNumber: string | null;
    }
  }
}
