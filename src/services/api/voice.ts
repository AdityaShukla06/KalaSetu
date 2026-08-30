import { apiFetch } from "./_helpers";

// POST /voice/transcribe
// Request:  multipart/form-data — field "audio" (Blob), field "category" (string)
// Response: { transcript: string, descriptionEn: string, descriptionHi: string }
export function transcribeAndDescribe(
  audioBlob: Blob,
  category: string,
): Promise<{ transcript: string; descriptionEn: string; descriptionHi: string }> {
  const formData = new FormData();
  formData.append("audio", audioBlob, "recording.wav");
  formData.append("category", category);
  return apiFetch("/voice/transcribe", { method: "POST", body: formData });
}
