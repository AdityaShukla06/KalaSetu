// KalaSetu shipping estimate rate card
// =====================================
//
// WHAT THIS IS: a rule-based, offline rate table for estimating Indian
// domestic courier shipping cost. It is NOT a live courier API integration.
// KalaSetu has no merchant account with any courier and makes no network
// call to price a shipment. Every number below is a representative,
// hand-set value based on how Indian courier rate cards are publicly known
// to be structured (zone x weight slab, base charge for the first 500g plus
// a per-additional-500g increment, a fuel surcharge, and GST on top), not a
// specific carrier's live, contracted rate.
//
// This file is the ONE place to edit if these numbers need updating before
// a demo, or if you want to walk a judge through exactly how the estimate
// is built. The calculation logic that reads this table lives in
// shippingEstimator.ts and should not need to change when these numbers do.
//
// HOW TO EXPLAIN THIS TO A JUDGE, IN ONE BREATH: "Indian couriers price a
// shipment by zone (how far it's going) and weight slab (500g steps), then
// add a fuel surcharge and GST. We model that same structure with
// representative numbers, and because real couriers differ from each other
// by roughly 15-20% for the same zone and weight, we always show a range,
// never a single fake-precise number."

export type ShippingZone = "local" | "withinState" | "metroToMetro" | "restOfIndia" | "special";

export const SHIPPING_ZONES: ShippingZone[] = ["local", "withinState", "metroToMetro", "restOfIndia", "special"];

export interface ZoneRate {
  // Charge for a shipment weighing up to and including 500g, in INR.
  baseFor500g: number;
  // Additional charge for each further 500g or part thereof, in INR,
  // matching how Indian courier rate cards are commonly structured.
  perAdditional500g: number;
}

// Representative base rates per zone, before fuel surcharge and GST.
// Zones, from cheapest to most expensive:
//   local        - same city / same 3-digit pincode prefix
//   withinState  - same state, different city (approximated by matching the
//                  first 2 digits of the pincode, which correspond to a
//                  postal circle roughly bounded to one state or a small
//                  cluster of states)
//   metroToMetro - both ends are one of the handful of major metro pincode
//                  prefixes (see METRO_PINCODE_PREFIXES below)
//   restOfIndia  - anywhere else: different state, not a metro pair
//   special      - Jammu & Kashmir, Ladakh, the North-Eastern states,
//                  Sikkim, and the Andaman & Nicobar Islands, which every
//                  major Indian courier surcharges for lower delivery
//                  density and longer transit
export const ZONE_RATES: Record<ShippingZone, ZoneRate> = {
  local: { baseFor500g: 35, perAdditional500g: 12 },
  withinState: { baseFor500g: 42, perAdditional500g: 16 },
  metroToMetro: { baseFor500g: 55, perAdditional500g: 20 },
  restOfIndia: { baseFor500g: 65, perAdditional500g: 24 },
  special: { baseFor500g: 95, perAdditional500g: 35 },
};

// Typical fuel surcharge Indian couriers add on top of the base freight
// charge. Real values vary by carrier and month; 10% is a reasonable,
// commonly cited representative figure.
export const FUEL_SURCHARGE_RATE = 0.10;

// GST on domestic courier services, a fixed, publicly known rate.
export const GST_RATE = 0.18;

// The computed cost (base + fuel surcharge + GST) is a single number, but
// real courier-to-courier pricing for the same zone and weight is known to
// vary by roughly 15-20%. Rather than presenting a false-precision single
// figure, the estimator always widens that number into a range using these
// factors, and the UI must always show it as a range.
export const ESTIMATE_RANGE_LOW_FACTOR = 0.85;
export const ESTIMATE_RANGE_HIGH_FACTOR = 1.20;

// 3-digit pincode prefixes for a handful of major Indian metro areas, used
// only to detect a metro-to-metro shipment (both ends in this list). This
// is an approximation for estimation purposes, not an authoritative pincode
// database: Mumbai, Delhi, Bengaluru, Chennai, Kolkata, Hyderabad, Pune,
// Ahmedabad.
export const METRO_PINCODE_PREFIXES: string[] = ["400", "110", "560", "600", "700", "500", "411", "380"];

// 3-digit pincode prefix ranges (inclusive) that fall in the "special" zone:
// Jammu & Kashmir and Ladakh (180-194), Sikkim (737), the North-Eastern
// states (781-799), and the Andaman & Nicobar Islands (744). Like the metro
// list above, this is a reasonable approximation for an estimate, not a
// guaranteed-precise pincode-to-region lookup.
export const SPECIAL_ZONE_PINCODE_PREFIX_RANGES: Array<[number, number]> = [
  [180, 194],
  [737, 737],
  [781, 799],
  [744, 744],
];

export interface WeightCategoryOption {
  id: string;
  labelKey: string;
  weightKg: number;
}

// Preset weight categories shown to an artisan who doesn't have a scale
// handy. Picking one fills in a representative weight in kilograms; an
// artisan who knows the real weight can still enter it directly.
export const WEIGHT_CATEGORIES: WeightCategoryOption[] = [
  { id: "light", labelKey: "shipping.weightCategory.light", weightKg: 0.3 },
  { id: "medium", labelKey: "shipping.weightCategory.medium", weightKg: 1 },
  { id: "heavy", labelKey: "shipping.weightCategory.heavy", weightKg: 3 },
  { id: "veryHeavy", labelKey: "shipping.weightCategory.veryHeavy", weightKg: 7 },
];
