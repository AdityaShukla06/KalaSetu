import { describe, it, expect } from "vitest";
import { normaliseCategory, normaliseMaterial } from "./normalise";

describe("normaliseCategory", () => {
  it("maps the render service's display-name labels to app category ids", () => {
    expect(normaliseCategory("Bamboo & Cane")).toBe("bamboo-cane");
    expect(normaliseCategory("Jewelry")).toBe("jewelry");
    expect(normaliseCategory("jewellery")).toBe("jewelry");
    expect(normaliseCategory("Pottery")).toBe("pottery");
  });

  it("passes through an id already in app form", () => {
    expect(normaliseCategory("woodwork")).toBe("woodwork");
  });

  it("returns undefined for anything unrecognised", () => {
    expect(normaliseCategory("Furniture")).toBeUndefined();
    expect(normaliseCategory("")).toBeUndefined();
    expect(normaliseCategory(undefined)).toBeUndefined();
    expect(normaliseCategory(42)).toBeUndefined();
  });
});

describe("normaliseMaterial", () => {
  it("matches case-insensitively against the category's curated material list", () => {
    expect(normaliseMaterial("pottery", "clay")).toBe("Clay");
  });

  it("picks the first matching candidate from an array", () => {
    expect(normaliseMaterial("bamboo-cane", ["Plastic", "cane"])).toBe("Cane");
  });

  it("drops a material that is not in that category's curated list", () => {
    expect(normaliseMaterial("pottery", "Silk")).toBeUndefined();
  });

  it("drops the generic 'Other' placeholder rather than preselecting it", () => {
    expect(normaliseMaterial("pottery", "Other")).toBeUndefined();
  });
});
