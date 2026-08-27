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
  status: ProductStatus;
  createdAt: string;
}

// Set VITE_API_BASE_URL (see .env.example) to switch every function below from the
// mock implementation to a real fetch against that base URL, no code changes needed.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

const MOCK_DELAY_MS = 600;

function delay<T>(value: T, ms: number = MOCK_DELAY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function delayReject(error: Error, ms: number = MOCK_DELAY_MS): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(error), ms));
}

// Shared fetch helper: attaches Authorization: Bearer <token> from the stored auth
// token to every real request, and throws on a non-2xx response.
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("kalasetu.token");
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new Error(`${path} failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// TODO: replace with real endpoint.
// POST /auth/send-otp
// Request:  { phoneNumber: string }
// Response: { success: boolean }
export function sendOtp(phoneNumber: string): Promise<{ success: boolean }> {
  if (API_BASE_URL) {
    return apiFetch("/auth/send-otp", {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    });
  }

  console.info(`[stub] sendOtp -> ${phoneNumber}`);
  return delay({ success: true });
}

// TODO: replace with real endpoint.
// POST /auth/verify-otp
// Request:  { phoneNumber: string, otp: string }
// Response: { token: string, userId: string }
export function verifyOtp(
  phoneNumber: string,
  otp: string,
): Promise<{ token: string; userId: string }> {
  if (API_BASE_URL) {
    return apiFetch("/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ phoneNumber, otp }),
    });
  }

  console.info(`[stub] verifyOtp -> ${phoneNumber} / ${otp}`);
  if (otp === "000000") {
    return delayReject(new Error("Invalid OTP"));
  }
  return delay({ token: "mock-token", userId: "mock-user-id" });
}

// TODO: replace with real endpoint.
// POST /images/enhance
// Request:  multipart/form-data, field "image" (the photo file)
// Response: { enhancedImageUrl: string }
export function enhanceImage(imageBlob: Blob): Promise<{ enhancedImageUrl: string }> {
  if (API_BASE_URL) {
    const formData = new FormData();
    formData.append("image", imageBlob);
    return apiFetch("/images/enhance", { method: "POST", body: formData });
  }

  console.info(`[stub] enhanceImage -> ${imageBlob.size} bytes`);
  if (Math.random() < 0.3) {
    return delayReject(new Error("Enhancement failed"));
  }
  return delay({ enhancedImageUrl: URL.createObjectURL(imageBlob) });
}

// TODO: replace with real endpoint.
// POST /voice/transcribe
// Request:  multipart/form-data, field "audio" (the voice note file) + field "category" (string)
// Response: { transcript: string, descriptionEn: string, descriptionHi: string }
export function transcribeAndDescribe(
  audioBlob: Blob,
  category: string,
): Promise<{ transcript: string; descriptionEn: string; descriptionHi: string }> {
  if (API_BASE_URL) {
    const formData = new FormData();
    formData.append("audio", audioBlob);
    formData.append("category", category);
    return apiFetch("/voice/transcribe", { method: "POST", body: formData });
  }

  console.info(`[stub] transcribeAndDescribe -> ${category}, ${audioBlob.size} bytes`);
  if (Math.random() < 0.3) {
    return delayReject(new Error("Transcription failed"));
  }
  return delay({
    transcript: "Mock transcript of the voice note.",
    descriptionEn: "Handcrafted item made with care.",
    descriptionHi: "हाथ से बनाई गई वस्तु, पूरी सावधानी के साथ।",
  });
}

// TODO: replace with real endpoint.
// POST /pricing/suggest
// Request:  { category: string, materialCost: number, descriptionEn: string, imageUrl: string }
// Response: { suggestedMin: number, suggestedMax: number, reasoning: string }
export function suggestPrice(input: {
  category: string;
  materialCost: number;
  descriptionEn: string;
  imageUrl: string;
}): Promise<{ suggestedMin: number; suggestedMax: number; reasoning: string }> {
  if (API_BASE_URL) {
    return apiFetch("/pricing/suggest", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  console.info(`[stub] suggestPrice -> ${input.category}`);
  if (Math.random() < 0.3) {
    return delayReject(new Error("Price suggestion failed"));
  }
  const suggestedMin = Math.round(input.materialCost * 1.4);
  const suggestedMax = Math.round(input.materialCost * 2.1);
  return delay({
    suggestedMin,
    suggestedMax,
    reasoning: "Based on material cost and similar items in this category.",
  });
}

const mockProducts: Product[] = [];

// TODO: replace with real endpoint.
// POST /products
// Request:  ProductInput, i.e. { category, titleEn, titleHi, descriptionEn, descriptionHi, imageUrl, price, materialCost }
// Response: { productId: string }
export function createProduct(product: ProductInput): Promise<{ productId: string }> {
  if (API_BASE_URL) {
    return apiFetch("/products", {
      method: "POST",
      body: JSON.stringify(product),
    });
  }

  console.info(`[stub] createProduct -> ${product.titleEn}`);
  if (Math.random() < 0.3) {
    return delayReject(new Error("Publish failed"));
  }

  const productId = `mock-product-${Date.now()}`;
  mockProducts.unshift({
    ...product,
    productId,
    status: "published",
    createdAt: new Date().toISOString(),
  });
  return delay({ productId });
}

// TODO: replace with real endpoint.
// GET /products?userId=<userId>
// Response: Product[], each { productId, status, createdAt, category, titleEn, titleHi, descriptionEn, descriptionHi, imageUrl, price, materialCost }
export function listProducts(userId: string): Promise<Product[]> {
  if (API_BASE_URL) {
    return apiFetch(`/products?userId=${encodeURIComponent(userId)}`, { method: "GET" });
  }

  console.info(`[stub] listProducts -> ${userId}`);
  if (Math.random() < 0.3) {
    return delayReject(new Error("Failed to load products"));
  }
  return delay([...mockProducts]);
}
