import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { applyStudioAdjustments } from "./imageStudio";

async function makeOpaquePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } },
  })
    .png()
    .toBuffer();
}

async function makeTransparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

describe("applyStudioAdjustments", () => {
  it("returns the source untouched in shape when no options are set", async () => {
    const input = await makeOpaquePng(400, 300);
    const result = await applyStudioAdjustments(input, {});

    expect(result.width).toBe(400);
    expect(result.height).toBe(300);
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("crops to a square", async () => {
    const input = await makeOpaquePng(800, 400);
    const result = await applyStudioAdjustments(input, { cropPreset: "square" });

    expect(result.width).toBe(result.height);
  });

  it("crops to a 4:5 portrait", async () => {
    const input = await makeOpaquePng(1000, 400);
    const result = await applyStudioAdjustments(input, { cropPreset: "portrait" });

    expect(result.width / result.height).toBeCloseTo(4 / 5, 1);
  });

  it("fills a transparent background with white", async () => {
    const input = await makeTransparentPng(300, 300);
    const result = await applyStudioAdjustments(input, { backgroundFill: "white" });

    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    const corner = [data[0], data[1], data[2]];
    expect(corner.every((channel) => channel > 240)).toBe(true);
  });

  it("actually changes the pixels when brightness is adjusted", async () => {
    const input = await makeOpaquePng(200, 200);
    const brighter = await applyStudioAdjustments(input, { brightness: 2 });
    const untouched = await applyStudioAdjustments(input, {});

    expect(brighter.buffer.equals(untouched.buffer)).toBe(false);
  });

  it("ignores background options on an image with no alpha channel", async () => {
    const input = await makeOpaquePng(300, 300);
    const result = await applyStudioAdjustments(input, { backgroundFill: "white", backgroundBlur: true });

    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });
});
