import { apiUpload, apiFetch } from "./_helpers";

export interface EnhanceResult {
  enhancedImageUrl: string;
  originalImageUrl: string;
  width: number;
  height: number;
}

export function enhanceImage(imageBlob: Blob): Promise<EnhanceResult> {
  return apiUpload("/images/enhance", imageBlob, imageBlob.type || "image/jpeg");
}

export interface RemoveBackgroundResult {
  cutoutUrl: string | null;
  backgroundRemoved: boolean;
  notice?: string;
}

export function removeImageBackground(imageBlob: Blob): Promise<RemoveBackgroundResult> {
  return apiUpload("/images/remove-background", imageBlob, imageBlob.type || "image/jpeg");
}

export type BackgroundFill = "white" | "neutral" | "none";
export type CropPreset = "original" | "square" | "portrait";

export interface StudioOptions {
  brightness?: number;
  contrast?: number;
  sharpen?: boolean;
  autoLighting?: boolean;
  backgroundBlur?: boolean;
  backgroundFill?: BackgroundFill;
  cropPreset?: CropPreset;
}

export interface FinalizeResult {
  finalImageUrl: string;
  width: number;
  height: number;
}

export function finalizeImage(sourceUrl: string, options: StudioOptions): Promise<FinalizeResult> {
  return apiFetch("/images/finalize", {
    method: "POST",
    body: JSON.stringify({ sourceUrl, options }),
  });
}

export type ClassificationConfidence = "high" | "medium" | "low";

export interface CategorySuggestion {
  category: string;
  confidence: ClassificationConfidence;
  material?: string;
  source: "gemini" | "groq" | "render";
}

export interface ClassifyResult {
  suggestion: CategorySuggestion | null;
}

export function classifyImage(imageUrl: string): Promise<ClassifyResult> {
  return apiFetch("/images/classify", {
    method: "POST",
    body: JSON.stringify({ imageUrl }),
  });
}
