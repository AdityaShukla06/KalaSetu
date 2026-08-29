import { apiFetch } from "./_helpers";

// POST /images/enhance
// Request:  multipart/form-data, field "image" (Blob)
// Response: { enhancedImageUrl: string }
export function enhanceImage(imageBlob: Blob): Promise<{ enhancedImageUrl: string }> {
  const formData = new FormData();
  formData.append("image", imageBlob);
  return apiFetch("/images/enhance", { method: "POST", body: formData });
}

// POST /images/upload
// Request:  multipart/form-data, field "image" (Blob)
// Response: { imageUrl: string }
export function uploadImage(imageBlob: Blob): Promise<{ imageUrl: string }> {
  const formData = new FormData();
  formData.append("image", imageBlob);
  return apiFetch("/images/upload", { method: "POST", body: formData });
}
