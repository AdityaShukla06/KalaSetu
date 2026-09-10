import { describe, it, expect } from "vitest";
import { totalMaterialCost, PricingInputSchema } from "./pricing";

function parse(input: unknown) {
  const result = PricingInputSchema.parse(input);
  return result;
}

describe("totalMaterialCost", () => {
  it("uses materialCost when no rawMaterials are given", () => {
    expect(totalMaterialCost(parse({ category: "pottery", materialCost: 480 }))).toBe(480);
  });

  it("sums rawMaterials when given, ignoring a stale materialCost", () => {
    const data = parse({
      category: "pottery",
      materialCost: 9999,
      rawMaterials: [
        { name: "clay", cost: 150 },
        { name: "glaze", cost: 100 },
      ],
    });
    expect(totalMaterialCost(data)).toBe(250);
  });

  it("returns undefined when neither is given", () => {
    expect(totalMaterialCost({ category: "pottery" } as any)).toBeUndefined();
  });
});

describe("PricingInputSchema", () => {
  it("accepts the new optional fields for the pricing service", () => {
    const data = parse({
      category: "pottery",
      materialCost: 480,
      craftingTime: "3 days",
      state: "Rajasthan",
      hasGiTag: true,
    });
    expect(data.craftingTime).toBe("3 days");
    expect(data.state).toBe("Rajasthan");
    expect(data.hasGiTag).toBe(true);
  });

  it("still requires materialCost or rawMaterials", () => {
    expect(() => PricingInputSchema.parse({ category: "pottery" })).toThrow();
  });

  it("accepts craftingTime as a number", () => {
    const data = parse({ category: "pottery", materialCost: 480, craftingTime: 24 });
    expect(data.craftingTime).toBe(24);
  });
});
