import { apiUpload } from "./_helpers";

export function enhanceImage(imageBlob: Blob): Promise<{ enhancedImageUrl: string }> {
  return apiUpload("/images/enhance", imageBlob, imageBlob.type || "image/jpeg");
}

export function uploadImage(imageBlob: Blob): Promise<{ imageUrl: string }> {
  return apiUpload("/images/upload", imageBlob, imageBlob.type || "image/jpeg");
}
