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
  from: string | null,
  to: string,
): Promise<{ translation: string; from: string | null; to: string }> {
  return apiFetch("/translate", {
    method: "POST",
    body: JSON.stringify({ text, from, to }),
  });
}

/**
 * Translates text whose language is not known for certain, letting the server
 * work out the source and report it back. `hint` is a guess worth passing (the
 * sender's interface language) but never trusted: romanised text often belongs
 * to a different language than the one the writer's app was set to.
 */
export function translateUnknownText(
  text: string,
  to: string,
  hint?: string | null,
): Promise<{ translation: string; from: string | null; to: string }> {
  return apiFetch("/translate", {
    method: "POST",
    body: JSON.stringify({ text, to, hint: hint ?? undefined }),
  });
}
