import { apiFetch } from "./_helpers";

//types
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
  status: ProductStatus;
  createdAt: string;
}

//endpoints

//create product
export function createProduct(product: ProductInput): Promise<{ productId: string }> {
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
