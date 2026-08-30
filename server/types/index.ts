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
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string | null;
  shopName: string | null;
  language: string;
  totalProducts: number;
  createdAt: string;
}

declare global {
  namespace Express {
    interface Request {
      uid: string;
      email: string;
    }
  }
}
