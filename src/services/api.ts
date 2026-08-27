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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

const MOCK_DELAY_MS = 600;

function delay<T>(value: T, ms: number = MOCK_DELAY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function delayReject(error: Error, ms: number = MOCK_DELAY_MS): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(error), ms));
}

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
