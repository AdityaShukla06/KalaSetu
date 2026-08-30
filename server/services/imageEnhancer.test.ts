import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { enhanceProductImage, UnsupportedImageError, MAX_IMAGE_DIMENSION } from "./imageEnhancer";

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 90, b: 60 },
    },
  })
    .png()
    .toBuffer();
}

describe("enhanceProductImage", () => {
  it("converts to JPEG regardless of the input format", async () => {
    const result = await enhanceProductImage(await makePng(400, 300));

    expect(result.mimeType).toBe("image/jpeg");
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("scales an oversized photo down within the dimension cap", async () => {
    const result = await enhanceProductImage(await makePng(4000, 3000));

    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
    expect(result.width).toBe(MAX_IMAGE_DIMENSION);
  });

  it("leaves a small photo at its original size", async () => {
    const result = await enhanceProductImage(await makePng(320, 240));

    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
  });

  it("preserves the aspect ratio when resizing", async () => {
    const result = await enhanceProductImage(await makePng(4000, 2000));

    expect(result.width / result.height).toBeCloseTo(2, 1);
  });

  it("actually changes the pixels rather than passing the image through", async () => {
    const input = await makePng(400, 300);
    const result = await enhanceProductImage(input);

    expect(result.buffer.equals(input)).toBe(false);
  });

  it("rejects a buffer that is not an image", async () => {
    await expect(enhanceProductImage(Buffer.from("this is not an image"))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
  });
});
