import { describe, it, expect } from "vitest";
import { ChainedBackgroundRemovalService } from "./chained-bg-removal.service";
import { BackgroundRemovalService } from "../types/background-removal.types";
import { BackgroundRemovalError } from "../errors/image-ai.errors";

class AlwaysFailsService implements BackgroundRemovalService {
  constructor(private readonly error: BackgroundRemovalError) {}

  async removeBackground(): Promise<Buffer> {
    throw this.error;
  }
}

class AlwaysSucceedsService implements BackgroundRemovalService {
  constructor(private readonly result: Buffer) {}

  async removeBackground(): Promise<Buffer> {
    return this.result;
  }
}

describe("ChainedBackgroundRemovalService", () => {
  it("returns the first provider's result without trying the rest", async () => {
    const primary = new AlwaysSucceedsService(Buffer.from("primary-result"));
    const fallback = new AlwaysSucceedsService(Buffer.from("fallback-result"));
    const chain = new ChainedBackgroundRemovalService([primary, fallback]);

    const result = await chain.removeBackground(Buffer.from("input"), "image/png");

    expect(result.toString()).toBe("primary-result");
  });

  it("falls through to the next provider when the first one fails", async () => {
    const primary = new AlwaysFailsService(new BackgroundRemovalError("rate_limited", "quota exhausted"));
    const fallback = new AlwaysSucceedsService(Buffer.from("fallback-result"));
    const chain = new ChainedBackgroundRemovalService([primary, fallback]);

    const result = await chain.removeBackground(Buffer.from("input"), "image/png");

    expect(result.toString()).toBe("fallback-result");
  });

  it("throws the last provider's error when every provider fails", async () => {
    const primary = new AlwaysFailsService(new BackgroundRemovalError("rate_limited", "quota exhausted"));
    const fallback = new AlwaysFailsService(new BackgroundRemovalError("provider_error", "fallback broke"));
    const chain = new ChainedBackgroundRemovalService([primary, fallback]);

    await expect(chain.removeBackground(Buffer.from("input"), "image/png")).rejects.toMatchObject({
      reason: "provider_error",
      message: "fallback broke",
    });
  });
});
