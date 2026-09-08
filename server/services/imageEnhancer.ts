import sharp from "sharp";
import { BackgroundRemovalService, BackgroundRemovalError, buildBackgroundRemovalService } from "../image-ai";

export const MAX_IMAGE_DIMENSION = 1600;
export const JPEG_QUALITY = 86;

export interface EnhancedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  backgroundRemoved: boolean;
  cutoutBuffer?: Buffer;
  notice?: string;
}

export interface EnhanceOptions {
  removeBackground?: boolean;
  backgroundRemoval?: BackgroundRemovalService;
}

export class UnsupportedImageError extends Error {
  public readonly originalError?: unknown;

  constructor(originalError?: unknown) {
    super("Image could not be read, the format may be unsupported");
    this.name = "UnsupportedImageError";
    this.originalError = originalError;
  }
}

let defaultBackgroundRemoval: BackgroundRemovalService | undefined;

function getDefaultBackgroundRemovalService(): BackgroundRemovalService {
  if (!defaultBackgroundRemoval) defaultBackgroundRemoval = buildBackgroundRemovalService();
  return defaultBackgroundRemoval;
}

function toBackgroundRemovalNotice(err: unknown): string {
  if (err instanceof BackgroundRemovalError) {
    switch (err.reason) {
      case "not_configured":
        return "background_removal_unavailable";
      case "timeout":
        return "background_removal_timed_out";
      default:
        return "background_removal_failed";
    }
  }
  return "background_removal_failed";
}

async function prepare(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "none" })
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

export async function enhanceProductImage(input: Buffer, options: EnhanceOptions = {}): Promise<EnhancedImage> {
  if (!options.removeBackground) {
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
        backgroundRemoved: false,
      };
    } catch (err) {
      throw new UnsupportedImageError(err);
    }
  }

  let prepared: Buffer;
  try {
    prepared = await prepare(input);
  } catch (err) {
    throw new UnsupportedImageError(err);
  }

  let working = prepared;
  let backgroundRemoved = false;
  let cutoutBuffer: Buffer | undefined;
  let notice: string | undefined;

  try {
    const service = options.backgroundRemoval ?? getDefaultBackgroundRemovalService();
    cutoutBuffer = await service.removeBackground(prepared, "image/png");
    working = await sharp(cutoutBuffer).flatten({ background: "#ffffff" }).png().toBuffer();
    backgroundRemoved = true;
  } catch (err) {
    cutoutBuffer = undefined;
    notice = toBackgroundRemovalNotice(err);
    console.warn("[imageEnhancer] background removal failed, falling back to sharp-only enhancement", {
      reason: err instanceof BackgroundRemovalError ? err.reason : "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const pipeline = sharp(working)
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
      backgroundRemoved,
      cutoutBuffer,
      notice,
    };
  } catch (err) {
    throw new UnsupportedImageError(err);
  }
}
