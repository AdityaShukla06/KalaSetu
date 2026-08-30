import { apiFetch, apiUpload } from "./_helpers";

export function transcribeAndDescribe(
  audioBlob: Blob,
  category: string,
  language: string,
): Promise<{
  transcript: string;
  descriptionEn: string;
  descriptionLocal: string;
  localLanguage: string;
  detectedLanguage: string;
}> {
  return apiUpload(
    `/voice/transcribe?category=${encodeURIComponent(category)}&language=${encodeURIComponent(language)}`,
    audioBlob,
    audioBlob.type || "audio/wav",
  );
}

export function translateText(
  text: string,
  from: string,
  to: string,
): Promise<{ translation: string }> {
  return apiFetch("/translate", {
    method: "POST",
    body: JSON.stringify({ text, from, to }),
  });
}
