import { apiUpload } from "./_helpers";

export function transcribeAndDescribe(
  audioBlob: Blob,
  category: string,
): Promise<{
  transcript: string;
  descriptionEn: string;
  descriptionHi: string;
  detectedLanguage: string;
}> {
  return apiUpload(
    `/voice/transcribe?category=${encodeURIComponent(category)}`,
    audioBlob,
    audioBlob.type || "audio/wav",
  );
}
