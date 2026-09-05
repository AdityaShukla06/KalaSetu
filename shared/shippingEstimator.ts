import {
  ZONE_RATES,
  FUEL_SURCHARGE_RATE,
  GST_RATE,
  ESTIMATE_RANGE_LOW_FACTOR,
  ESTIMATE_RANGE_HIGH_FACTOR,
  METRO_PINCODE_PREFIXES,
  SPECIAL_ZONE_PINCODE_PREFIX_RANGES,
  SHIPPING_ZONES,
  type ShippingZone,
  type ZoneRate,
} from "./shippingRateCard";

export interface ShippingCostRange {
  minCost: number;
  maxCost: number;
}

export interface ShippingEstimate extends ShippingCostRange {
  zone: ShippingZone;
}

export function isValidIndianPincode(value: string): boolean {
  return /^[1-9][0-9]{5}$/.test(value.trim());
}

export function classifyShippingZone(originPincode: string, destinationPincode: string): ShippingZone {
  const origin = originPincode.trim();
  const destination = destinationPincode.trim();

  const originPrefix3 = origin.slice(0, 3);
  const destinationPrefix3 = destination.slice(0, 3);
  if (originPrefix3 === destinationPrefix3) return "local";

  const destinationPrefix3Num = Number(destinationPrefix3);
  const isSpecial = SPECIAL_ZONE_PINCODE_PREFIX_RANGES.some(
    ([min, max]) => destinationPrefix3Num >= min && destinationPrefix3Num <= max,
  );
  if (isSpecial) return "special";

  const isMetroPair =
    METRO_PINCODE_PREFIXES.includes(originPrefix3) && METRO_PINCODE_PREFIXES.includes(destinationPrefix3);
  if (isMetroPair) return "metroToMetro";

  const originPrefix2 = origin.slice(0, 2);
  const destinationPrefix2 = destination.slice(0, 2);
  if (originPrefix2 === destinationPrefix2) return "withinState";

  return "restOfIndia";
}

function costRangeForZone(weightKg: number, rate: ZoneRate): ShippingCostRange {
  const grams = weightKg * 1000;
  const extraSlabs = Math.max(0, Math.ceil((grams - 500) / 500));
  const baseCost = rate.baseFor500g + extraSlabs * rate.perAdditional500g;
  const withSurcharges = baseCost * (1 + FUEL_SURCHARGE_RATE) * (1 + GST_RATE);

  return {
    minCost: Math.round(withSurcharges * ESTIMATE_RANGE_LOW_FACTOR),
    maxCost: Math.round(withSurcharges * ESTIMATE_RANGE_HIGH_FACTOR),
  };
}

export function estimateShippingCost(
  weightKg: number,
  originPincode: string,
  destinationPincode: string,
): ShippingEstimate | null {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (!isValidIndianPincode(originPincode) || !isValidIndianPincode(destinationPincode)) return null;

  const zone = classifyShippingZone(originPincode, destinationPincode);
  return { zone, ...costRangeForZone(weightKg, ZONE_RATES[zone]) };
}

export function estimateShippingByZone(weightKg: number): Record<ShippingZone, ShippingCostRange> | null {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;

  const result = {} as Record<ShippingZone, ShippingCostRange>;
  for (const zone of SHIPPING_ZONES) {
    result[zone] = costRangeForZone(weightKg, ZONE_RATES[zone]);
  }
  return result;
}
