import {
  buildOndcCatalogExport,
  buildOndcSingleProductExport,
  type OndcCatalogExport,
  type OndcCatalogProductInput,
  type OndcCatalogProviderInput,
} from "../../shared/ondcCatalog";
import type { Product } from "./api";

function toOndcProductInput(product: Product): OndcCatalogProductInput {
  return {
    passportId: product.passportId,
    titleEn: product.titleEn,
    descriptionEn: product.descriptionEn,
    imageUrl: product.imageUrl,
    price: product.price,
    category: product.category,
    material: product.material ?? null,
    region: product.region,
    artisanName: product.artisanName,
    technique: product.technique ?? null,
    timeTaken: product.timeTaken ?? null,
    giTag: product.giTag ?? null,
    careInstructions: product.careInstructions ?? null,
  };
}

function toOndcProviderInput(userId: string, products: Product[]): OndcCatalogProviderInput {
  const withName = products.find((product) => product.artisanName);
  return {
    providerId: userId,
    shopName: withName?.artisanName ?? "KalaSetu artisan",
    region: withName?.region ?? null,
  };
}

export function buildCatalogExport(userId: string, products: Product[]): OndcCatalogExport {
  const provider = toOndcProviderInput(userId, products);
  return buildOndcCatalogExport(
    provider,
    products.map((product) => toOndcProductInput(product)),
  );
}

export function buildSingleProductExport(userId: string, product: Product): OndcCatalogExport {
  const provider = toOndcProviderInput(userId, [product]);
  return buildOndcSingleProductExport(provider, toOndcProductInput(product));
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
