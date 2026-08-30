import { apiUpload } from "./_helpers";

export function enhanceImage(imageBlob: Blob): Promise<{ enhancedImageUrl: string }> {
  return apiUpload("/images/enhance", imageBlob, imageBlob.type || "image/jpeg");
}
