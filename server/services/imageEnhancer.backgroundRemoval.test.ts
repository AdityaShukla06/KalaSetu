import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { enhanceProductImage } from "./imageEnhancer";
import { BackgroundRemovalError, BackgroundRemovalService } from "../image-ai";

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } },
  })
    .png()
    .toBuffer();
}

class AlwaysFailsService implements BackgroundRemovalService {
  constructor(private readonly error: BackgroundRemovalError) {}

  async removeBackground(): Promise<Buffer> {
    throw this.error;
  }
}

class AlwaysSucceedsService implements BackgroundRemovalService {
  async removeBackground(input: Buffer): Promise<Buffer> {
    const meta = await sharp(input).metadata();
    return sharp({
      create: {
        width: meta.width ?? 400,
        height: meta.height ?? 300,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
  }
}

describe("enhanceProductImage background removal", () => {
  it("does not call the background removal service unless asked", async () => {
    const input = await makePng(400, 300);
    const result = await enhanceProductImage(input);

    expect(result.backgroundRemoved).toBe(false);
    expect(result.cutoutBuffer).toBeUndefined();
  });

  it("falls back to sharp-only enhancement when the provider times out, and never loses the photo", async () => {
    const input = await makePng(400, 300);
    const timeoutError = new BackgroundRemovalError("timeout", "did not respond in time");

    const result = await enhanceProductImage(input, {
      removeBackground: true,
      backgroundRemoval: new AlwaysFailsService(timeoutError),
    });

    expect(result.backgroundRemoved).toBe(false);
    expect(result.notice).toBe("background_removal_timed_out");
    expect(result.buffer.length).toBeGreaterThan(0);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("returns a usable cutout buffer when the provider succeeds", async () => {
    const input = await makePng(400, 300);

    const result = await enhanceProductImage(input, {
      removeBackground: true,
      backgroundRemoval: new AlwaysSucceedsService(),
    });

    expect(result.backgroundRemoved).toBe(true);
    expect(result.cutoutBuffer).toBeDefined();
    const meta = await sharp(result.cutoutBuffer as Buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });
});
