export const ONDC_SPEC_SOURCE_URL =
  "https://github.com/ONDC-Official/ONDC-Protocol-Specs/blob/master/protocol-specifications/core/v0/api/retail-hyperlocal.yaml";

export interface OndcCatalogProductInput {
  passportId: string;
  titleEn: string;
  descriptionEn: string;
  imageUrl: string;
  price: number;
  category: string;
  material?: string | null;
  region?: string | null;
  artisanName?: string | null;
  technique?: string | null;
  timeTaken?: string | null;
  giTag?: string | null;
  careInstructions?: string | null;
}

export interface OndcCatalogProviderInput {
  providerId: string;
  shopName: string;
  region?: string | null;
}

export interface OndcTag {
  code: string;
  name: string;
  value: string;
}

export interface OndcTagGroup {
  code: string;
  name: string;
  list: OndcTag[];
}

export interface OndcItem {
  id: string;
  descriptor: {
    name: string;
    long_desc: string;
    images: string[];
  };
  price: {
    currency: string;
    value: string;
  };
  category_id: string;
  tags: OndcTagGroup[];
}

export interface OndcProviderLocation {
  id: string;
  address: {
    state: string;
  };
}

export interface OndcProvider {
  id: string;
  descriptor: {
    name: string;
  };
  locations: OndcProviderLocation[];
  items: OndcItem[];
}

export interface OndcGap {
  ondcField: string;
  issue: string;
}

export interface OndcCatalogExport {
  _kalasetu_export: {
    format: string;
    note: string;
    sourceSpec: string;
    exportedAt: string;
  };
  provider: OndcProvider;
  gaps: OndcGap[];
}

function buildProvenanceTagGroup(product: OndcCatalogProductInput): OndcTagGroup {
  const list: OndcTag[] = [];
  if (product.material) list.push({ code: "material", name: "Material", value: product.material });
  if (product.technique) list.push({ code: "technique", name: "Technique", value: product.technique });
  if (product.timeTaken) list.push({ code: "time_taken", name: "Time taken to make", value: product.timeTaken });
  if (product.giTag) list.push({ code: "gi_odop_tag", name: "GI / ODOP tag", value: product.giTag });
  if (product.careInstructions) {
    list.push({ code: "care_instructions", name: "Care instructions", value: product.careInstructions });
  }
  if (product.artisanName) list.push({ code: "artisan_name", name: "Artisan", value: product.artisanName });
  if (product.region) list.push({ code: "region", name: "Region", value: product.region });
  list.push({ code: "kalasetu_passport_url", name: "Craft Heritage Passport", value: `/passport/${product.passportId}` });

  return { code: "kalasetu_provenance", name: "KalaSetu craft provenance", list };
}

export function mapProductToOndcItem(product: OndcCatalogProductInput): OndcItem {
  return {
    id: product.passportId,
    descriptor: {
      name: product.titleEn,
      long_desc: product.descriptionEn,
      images: [product.imageUrl],
    },
    price: {
      currency: "INR",
      value: String(product.price),
    },
    category_id: product.category,
    tags: [buildProvenanceTagGroup(product)],
  };
}

export const ONDC_EXPORT_GAPS: OndcGap[] = [
  {
    ondcField: "item.category_id",
    issue:
      "KalaSetu's own category (pottery, textiles, woodwork, etc.) is exported as category_id, but this is not yet mapped to ONDC's official category taxonomy for the relevant retail vertical. That mapping must be finalized during ONDC seller onboarding.",
  },
  {
    ondcField: "item.quantity",
    issue:
      "KalaSetu does not track stock or inventory count. This field is omitted from the export rather than defaulted to a guessed value; it must be set by the artisan during onboarding.",
  },
  {
    ondcField: "item.fulfillment_id, provider.fulfillments",
    issue:
      "Delivery/pickup type, service area, and time-to-ship are not modeled by KalaSetu today. Omitted from the export; must be configured during onboarding.",
  },
  {
    ondcField: "item.price.maximum_value",
    issue:
      "KalaSetu tracks a single artisan-set selling price only, no separate MRP or listed price. Omitted rather than duplicating the selling price as a fabricated maximum.",
  },
  {
    ondcField:
      "item.@ondc/org/returnable, @ondc/org/cancellable, @ondc/org/return_window, @ondc/org/available_on_cod",
    issue:
      "Return, cancellation, and cash-on-delivery policy are not modeled by KalaSetu. These carry real consumer-protection and legal weight and are intentionally omitted rather than defaulted; the artisan must set them at onboarding.",
  },
  {
    ondcField: "item.descriptor (artisan's own-language title)",
    issue:
      "The verified ONDC core Descriptor schema has no documented multi-language name field. Only the English title is exported; the artisan's own-language title and description are not represented in this format.",
  },
  {
    ondcField: "provider.id",
    issue:
      "No ONDC-issued subscriber or provider id exists, that is assigned during ONDC network participant registration. KalaSetu's internal artisan account id is used here as a structural placeholder only.",
  },
  {
    ondcField: "provider.locations[].gps, provider.locations[].address (door, street, city, area_code)",
    issue:
      "KalaSetu collects only a state-level region for an artisan, not a full pickup address, city, pincode, or GPS coordinates. All of those are required by ONDC's Location schema for real fulfillment and are omitted here beyond state.",
  },
];

export function buildOndcCatalogExport(
  provider: OndcCatalogProviderInput,
  products: OndcCatalogProductInput[],
): OndcCatalogExport {
  return {
    _kalasetu_export: {
      format: "ONDC retail catalog data (Provider/Item, core v0 schema); a static export for onboarding, not a live network transaction",
      note:
        "KalaSetu is not registered as an ONDC network participant and this file is not a signed or transmitted protocol message. It maps our product data to the ONDC retail catalog structure for engineering readiness. See ONDC_CATALOG_MAPPING.md in the KalaSetu repository for the full field mapping and gap list.",
      sourceSpec: ONDC_SPEC_SOURCE_URL,
      exportedAt: new Date().toISOString(),
    },
    provider: {
      id: provider.providerId,
      descriptor: { name: provider.shopName },
      locations: provider.region ? [{ id: "1", address: { state: provider.region } }] : [],
      items: products.map(mapProductToOndcItem),
    },
    gaps: ONDC_EXPORT_GAPS,
  };
}

export function buildOndcSingleProductExport(
  provider: OndcCatalogProviderInput,
  product: OndcCatalogProductInput,
): OndcCatalogExport {
  return buildOndcCatalogExport(provider, [product]);
}
