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

const MOCK_DELAY_MS = 600;

function delay<T>(value: T, ms: number = MOCK_DELAY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function delayReject(error: Error, ms: number = MOCK_DELAY_MS): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(error), ms));
}

export function sendOtp(phoneNumber: string): Promise<{ success: boolean }> {
  console.info(`[stub] sendOtp -> ${phoneNumber}`);
  return delay({ success: true });
}

export function verifyOtp(
  phoneNumber: string,
  otp: string,
): Promise<{ token: string; userId: string }> {
  console.info(`[stub] verifyOtp -> ${phoneNumber} / ${otp}`);
  if (otp === "000000") {
    return delayReject(new Error("Invalid OTP"));
  }
  return delay({ token: "mock-token", userId: "mock-user-id" });
}

export function enhanceImage(imageBlob: Blob): Promise<{ enhancedImageUrl: string }> {
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
  console.info(`[stub] transcribeAndDescribe -> ${category}, ${audioBlob.size} bytes`);
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
  console.info(`[stub] suggestPrice -> ${input.category}`);
  const suggestedMin = Math.round(input.materialCost * 1.4);
  const suggestedMax = Math.round(input.materialCost * 2.1);
  return delay({
    suggestedMin,
    suggestedMax,
    reasoning: "Based on material cost and similar items in this category.",
  });
}

export function createProduct(product: ProductInput): Promise<{ productId: string }> {
  console.info(`[stub] createProduct -> ${product.titleEn}`);
  return delay({ productId: `mock-product-${Date.now()}` });
}

export function listProducts(userId: string): Promise<Product[]> {
  console.info(`[stub] listProducts -> ${userId}`);
  return delay([
    {
      productId: "mock-product-1",
      category: "pottery",
      titleEn: "Terracotta Vase",
      titleHi: "टेराकोटा फूलदान",
      descriptionEn: "Handcrafted terracotta vase with traditional motifs.",
      descriptionHi: "पारंपरिक डिज़ाइन के साथ हस्तनिर्मित टेराकोटा फूलदान।",
      imageUrl: "/icons/icon-512.png",
      price: 450,
      materialCost: 200,
      status: "published",
      createdAt: new Date().toISOString(),
    },
  ]);
}
