import { describe, it, expect } from "vitest";
import {
  mapProductToOndcItem,
  buildOndcCatalogExport,
  buildOndcSingleProductExport,
  ONDC_EXPORT_GAPS,
  ONDC_SPEC_SOURCE_URL,
  type OndcCatalogProductInput,
} from "./ondcCatalog";

const product: OndcCatalogProductInput = {
  passportId: "ART-2026-000123",
  titleEn: "Blue Ceramic Vase",
  descriptionEn: "A hand-thrown ceramic vase with a glossy blue glaze",
  imageUrl: "https://example.com/vase.jpg",
  price: 1200,
  category: "pottery",
  material: "Clay",
  region: "Karnataka",
  artisanName: "Ravi Kumar",
  technique: "Hand-thrown on a potter's wheel",
  timeTaken: "3 days",
  giTag: "GI-1234",
  careInstructions: "Wipe with a dry cloth",
};

describe("mapProductToOndcItem", () => {
  it("maps the passport id to the ONDC item id", () => {
    const item = mapProductToOndcItem(product);
    expect(item.id).toBe("ART-2026-000123");
  });

  it("maps title and description to the ONDC descriptor", () => {
    const item = mapProductToOndcItem(product);
    expect(item.descriptor.name).toBe("Blue Ceramic Vase");
    expect(item.descriptor.long_desc).toBe(product.descriptionEn);
    expect(item.descriptor.images).toEqual([product.imageUrl]);
  });

  it("maps price with an INR currency code and a string decimal value", () => {
    const item = mapProductToOndcItem(product);
    expect(item.price).toEqual({ currency: "INR", value: "1200" });
  });

  it("carries craft provenance details in a tag group rather than inventing dedicated fields", () => {
    const item = mapProductToOndcItem(product);
    expect(item.tags).toHaveLength(1);
    const group = item.tags[0];
    expect(group.code).toBe("kalasetu_provenance");

    const byCode = Object.fromEntries(group.list.map((tag) => [tag.code, tag.value]));
    expect(byCode.material).toBe("Clay");
    expect(byCode.technique).toBe("Hand-thrown on a potter's wheel");
    expect(byCode.time_taken).toBe("3 days");
    expect(byCode.gi_odop_tag).toBe("GI-1234");
    expect(byCode.care_instructions).toBe("Wipe with a dry cloth");
    expect(byCode.artisan_name).toBe("Ravi Kumar");
    expect(byCode.region).toBe("Karnataka");
    expect(byCode.kalasetu_passport_url).toBe("/passport/ART-2026-000123");
  });

  it("omits optional provenance fields that were never provided, rather than inventing values", () => {
    const sparse: OndcCatalogProductInput = {
      passportId: "ART-2026-000456",
      titleEn: "Bamboo Basket",
      descriptionEn: "A woven bamboo basket",
      imageUrl: "https://example.com/basket.jpg",
      price: 400,
      category: "bamboo-cane",
    };

    const item = mapProductToOndcItem(sparse);
    const codes = item.tags[0].list.map((tag) => tag.code);
    expect(codes).not.toContain("material");
    expect(codes).not.toContain("technique");
    expect(codes).not.toContain("gi_odop_tag");
    expect(codes).toContain("kalasetu_passport_url");
  });

  it("never includes internal cost or moderation data in the exported item", () => {
    const item = mapProductToOndcItem(product);
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain("materialCost");
    expect(serialized).not.toContain("reviewStatus");
    expect(serialized).not.toContain("flagReason");
  });
});

describe("buildOndcCatalogExport", () => {
  const provider = { providerId: "user-123", shopName: "Ravi's Pottery", region: "Karnataka" };

  it("wraps the provider and items with a clear, honest export label, not a fake network message", () => {
    const result = buildOndcCatalogExport(provider, [product]);

    expect(result._kalasetu_export.note).toContain("not registered as an ONDC network participant");
    expect(result._kalasetu_export.note).not.toMatch(/live|connected|synced/i);
    expect(result._kalasetu_export.sourceSpec).toBe(ONDC_SPEC_SOURCE_URL);
  });

  it("maps the provider's own region into the address state field, not a fabricated city or GPS", () => {
    const result = buildOndcCatalogExport(provider, [product]);
    expect(result.provider.locations).toEqual([{ id: "1", address: { state: "Karnataka" } }]);
  });

  it("omits locations entirely when the artisan has no region on file", () => {
    const result = buildOndcCatalogExport({ providerId: "user-123", shopName: "Ravi's Pottery" }, [product]);
    expect(result.provider.locations).toEqual([]);
  });

  it("includes every product as a separate item under one provider for a full catalog export", () => {
    const second: OndcCatalogProductInput = { ...product, passportId: "ART-2026-000789", titleEn: "Clay Pot" };
    const result = buildOndcCatalogExport(provider, [product, second]);

    expect(result.provider.items).toHaveLength(2);
    expect(result.provider.items.map((item) => item.id)).toEqual(["ART-2026-000123", "ART-2026-000789"]);
  });

  it("reports the same standard gap list every time, and never silently invents the missing data instead", () => {
    const result = buildOndcCatalogExport(provider, [product]);
    expect(result.gaps).toEqual(ONDC_EXPORT_GAPS);
    expect(result.gaps.length).toBeGreaterThan(0);

    const fields = result.gaps.map((gap) => gap.ondcField).join(" ");
    expect(fields).toContain("quantity");
    expect(fields).toContain("fulfillment");
    expect(fields).toContain("category_id");
  });

  it("never fabricates a quantity, fulfillment, or maximum price field on the item itself", () => {
    const result = buildOndcCatalogExport(provider, [product]);
    const item = result.provider.items[0] as unknown as Record<string, unknown>;
    expect(item.quantity).toBeUndefined();
    expect(item.fulfillment_id).toBeUndefined();
    expect((item.price as Record<string, unknown>).maximum_value).toBeUndefined();
  });
});

describe("buildOndcSingleProductExport", () => {
  it("produces the same shape as a one-item catalog export", () => {
    const provider = { providerId: "user-123", shopName: "Ravi's Pottery", region: "Karnataka" };
    const single = buildOndcSingleProductExport(provider, product);
    const catalog = buildOndcCatalogExport(provider, [product]);

    expect(single.provider.items).toEqual(catalog.provider.items);
    expect(single.gaps).toEqual(catalog.gaps);
  });
});
