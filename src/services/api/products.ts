import { apiFetch } from "./_helpers";

//types
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

export type MarketplaceSort = "newest" | "price_asc" | "price_desc";

export interface MarketplaceFilters {
  q?: string;
  category?: string;
  material?: string;
  region?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: MarketplaceSort;
  page?: number;
  limit?: number;
}

export interface MarketplaceResult {
  items: Product[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

//endpoints

//create product
export function createProduct(product: ProductInput): Promise<{ productId: string; passportId: string }> {
  return apiFetch("/products", {
    method: "POST",
    body: JSON.stringify(product),
  });
}

//list products
export function listProducts(userId: string): Promise<Product[]> {
  return apiFetch(`/products?userId=${encodeURIComponent(userId)}`, { method: "GET" });
}

//update product
export function updateProduct(
  productId: string,
  updates: Partial<ProductInput>,
): Promise<{ success: boolean }> {
  return apiFetch(`/products/${encodeURIComponent(productId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

//delete product
export function deleteProduct(productId: string): Promise<{ success: boolean }> {
  return apiFetch(`/products/${encodeURIComponent(productId)}`, {
    method: "DELETE",
  });
}

export function relocaliseProducts(
  language: string,
): Promise<{ updated: number; failed: number; remaining: number }> {
  return apiFetch("/products/relocalise", {
    method: "POST",
    body: JSON.stringify({ language }),
  });
}

function buildQueryString(filters: MarketplaceFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.category) params.set("category", filters.category);
  if (filters.material) params.set("material", filters.material);
  if (filters.region) params.set("region", filters.region);
  if (filters.minPrice !== undefined) params.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined) params.set("maxPrice", String(filters.maxPrice));
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function searchMarketplace(filters: MarketplaceFilters): Promise<MarketplaceResult> {
  return apiFetch(`/products/marketplace${buildQueryString(filters)}`, { method: "GET" });
}

export function getMarketplaceProduct(productId: string): Promise<ProductWithArtisan> {
  return apiFetch(`/products/marketplace/${encodeURIComponent(productId)}`, { method: "GET" });
}
