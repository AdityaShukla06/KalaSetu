import { describe, it, expect } from "vitest";
import { matchesSearch } from "./products";

function makeRow(overrides: Partial<Parameters<typeof matchesSearch>[0]> = {}) {
  return {
    id: "1",
    user_id: "u1",
    category: "pottery",
    material: null,
    region: null,
    artisan_name: null,
    title_en: "Blue ceramic vase",
    title_local: "नीला मिट्टी का फूलदान",
    description_en: "A hand painted vase for flowers",
    description_local: "फूलों के लिए हाथ से पेंट किया गया फूलदान",
    local_language: "hi",
    image_url: "https://example.com/a.jpg",
    price: 500,
    material_cost: 100,
    status: "published",
    flagged: false,
    flag_reason: null,
    review_status: "pending",
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchesSearch", () => {
  it("matches the English title case-insensitively", () => {
    expect(matchesSearch(makeRow(), "CERAMIC")).toBe(true);
  });

  it("matches the English description", () => {
    expect(matchesSearch(makeRow(), "hand painted")).toBe(true);
  });

  it("matches the local-language title", () => {
    expect(matchesSearch(makeRow(), "फूलदान")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesSearch(makeRow(), "bamboo basket")).toBe(false);
  });
});
