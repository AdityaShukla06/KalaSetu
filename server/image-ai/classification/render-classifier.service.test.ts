import { describe, it, expect, vi, afterEach } from "vitest";
import { RenderClassifierService } from "./render-classifier.service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("RenderClassifierService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises a display-name category and derives confidence from requires_review", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        predicted_category: "Bamboo & Cane",
        confidence_score: 0.92,
        requires_review: false,
        artisan_metadata: { materials: ["Bamboo"] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RenderClassifierService("https://kala-setu-image-classifier.onrender.com", 5000);
    const result = await service.classify(Buffer.from("fake-image"), "image/jpeg");

    expect(result).toEqual({
      category: "bamboo-cane",
      confidence: "high",
      material: "Bamboo",
      source: "render",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://kala-setu-image-classifier.onrender.com/predict",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("marks a low-confidence prediction as requiring review even with a mid-range score", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        predicted_category: "Jewelry",
        confidence_score: 0.55,
        requires_review: true,
        artisan_metadata: { materials: [] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RenderClassifierService("https://kala-setu-image-classifier.onrender.com", 5000);
    const result = await service.classify(Buffer.from("fake-image"), "image/jpeg");

    expect(result.confidence).toBe("low");
    expect(result.material).toBeUndefined();
  });

  it("throws when the provider returns a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new RenderClassifierService("https://kala-setu-image-classifier.onrender.com", 5000);

    await expect(service.classify(Buffer.from("fake-image"), "image/jpeg")).rejects.toThrow(/500/);
  });

  it("throws when the predicted category cannot be mapped to a known id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ predicted_category: "Something Unknown", confidence_score: 0.9, requires_review: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RenderClassifierService("https://kala-setu-image-classifier.onrender.com", 5000);

    await expect(service.classify(Buffer.from("fake-image"), "image/jpeg")).rejects.toThrow(/unknown category/);
  });
});
