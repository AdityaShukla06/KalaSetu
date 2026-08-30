import sharp from "sharp";

export const MAX_IMAGE_DIMENSION = 1600;
export const JPEG_QUALITY = 86;

export interface EnhancedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export class UnsupportedImageError extends Error {
  public readonly originalError?: unknown;

  constructor(originalError?: unknown) {
    super("Image could not be read, the format may be unsupported");
    this.name = "UnsupportedImageError";
    this.originalError = originalError;
  }
}

export async function enhanceProductImage(input: Buffer): Promise<EnhancedImage> {
  try {
    const pipeline = sharp(input, { failOn: "none" })
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .normalise()
      .modulate({ saturation: 1.06 })
      .sharpen({ sigma: 0.8 })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      mimeType: "image/jpeg",
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    throw new UnsupportedImageError(err);
  }
}

export async function normaliseProductImage(input: Buffer): Promise<EnhancedImage> {
  try {
    const pipeline = sharp(input, { failOn: "none" })
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      mimeType: "image/jpeg",
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    throw new UnsupportedImageError(err);
  }
}
