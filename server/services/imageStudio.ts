import sharp from "sharp";
import { MAX_IMAGE_DIMENSION, JPEG_QUALITY, UnsupportedImageError } from "./imageEnhancer";

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

export interface StudioResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

const FILL_COLORS: Record<Exclude<BackgroundFill, "none">, string> = {
  white: "#ffffff",
  neutral: "#f5efe4",
};

const CROP_RATIOS: Record<Exclude<CropPreset, "original">, number> = {
  square: 1,
  portrait: 4 / 5,
};

export async function applyStudioAdjustments(source: Buffer, options: StudioOptions): Promise<StudioResult> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(source).metadata();
  } catch (err) {
    throw new UnsupportedImageError(err);
  }

  try {
    const hasAlpha = Boolean(meta.hasAlpha);
    let pipeline = sharp(source);

    if (hasAlpha && options.backgroundBlur) {
      const backdrop = await sharp(source).flatten({ background: "#ffffff" }).blur(24).toBuffer();
      pipeline = sharp(backdrop).composite([{ input: source }]);
    } else if (hasAlpha && options.backgroundFill && options.backgroundFill !== "none") {
      pipeline = pipeline.flatten({ background: FILL_COLORS[options.backgroundFill] });
    }

    if (options.autoLighting) {
      pipeline = pipeline.normalise().linear(1.05, -6);
    }

    const brightnessStep = options.brightness ?? 0;
    if (brightnessStep !== 0) {
      pipeline = pipeline.modulate({ brightness: 1 + brightnessStep * 0.08 });
    }

    const contrastStep = options.contrast ?? 0;
    if (contrastStep !== 0) {
      const slope = 1 + contrastStep * 0.12;
      pipeline = pipeline.linear(slope, 128 * (1 - slope));
    }

    if (options.sharpen) {
      pipeline = pipeline.sharpen({ sigma: 1.2 });
    }

    const cropPreset = options.cropPreset ?? "original";
    if (cropPreset !== "original") {
      const ratio = CROP_RATIOS[cropPreset];
      const targetWidth = Math.min(meta.width ?? MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION);
      const targetHeight = Math.round(targetWidth / ratio);
      pipeline = pipeline.resize({ width: targetWidth, height: targetHeight, fit: "cover", position: "centre" });
    }

    const { data, info } = await pipeline
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return { buffer: data, mimeType: "image/jpeg", width: info.width, height: info.height };
  } catch (err) {
    if (err instanceof UnsupportedImageError) throw err;
    throw new UnsupportedImageError(err);
  }
}
