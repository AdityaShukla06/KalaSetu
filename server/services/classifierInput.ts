import sharp from "sharp";
import { UnsupportedImageError } from "./imageEnhancer";

const CLASSIFIER_EDGE_PX = 512;

export interface ClassifierInput {
  buffer: Buffer;
  mimeType: string;
}

export async function prepareForClassification(input: Buffer): Promise<ClassifierInput> {
  try {
    const buffer = await sharp(input)
      .rotate()
      .resize({ width: CLASSIFIER_EDGE_PX, height: CLASSIFIER_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    return { buffer, mimeType: "image/jpeg" };
  } catch (err) {
    throw new UnsupportedImageError(err);
  }
}
