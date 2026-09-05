# ONDC catalog mapping

What this is, and what it isn't: KalaSetu can export an artisan's products as JSON shaped to match the ONDC retail catalog structure (the `Provider` / `Item` objects used in an `on_search` response). This is a data mapping for onboarding readiness. KalaSetu is not registered as an ONDC network participant, does not hold a subscriber ID or signing keys, and makes no network calls to ONDC. The exported file is a static document, not a signed or transmitted protocol message.

## Source

Field names and structure below are taken verbatim from the official ONDC protocol specification, not from memory:

[`ONDC-Official/ONDC-Protocol-Specs`, `protocol-specifications/core/v0/api/retail-hyperlocal.yaml`](https://github.com/ONDC-Official/ONDC-Protocol-Specs/blob/master/protocol-specifications/core/v0/api/retail-hyperlocal.yaml)

This is the core (domain-independent) retail schema that every ONDC retail vertical (grocery, fashion, home & decor, and so on) builds on. The exact category taxonomy and a handful of domain-specific tag groups (for example the statutory fields for packaged food) differ per vertical and per protocol version in production; those are called out as gaps below rather than guessed at.

## Field mapping

| KalaSetu field | ONDC field | Notes |
|---|---|---|
| `product.passportId` (`ART-YYYY-NNNNNN`) | `Item.id` | Already unique, human-readable, and stable, which is exactly what `Item.id` asks for. |
| `product.titleEn` | `Item.descriptor.name` | English only, see gap below. |
| `product.descriptionEn` | `Item.descriptor.long_desc` | |
| `product.imageUrl` | `Item.descriptor.images[0]` | KalaSetu stores one image per product today, so this is always a single-element array. |
| `product.price` | `Item.price.value`, with `Item.price.currency` set to `"INR"` | Exported as a decimal string, matching `Item.price`'s `DecimalValue` type. |
| `product.category` | `Item.category_id` | Our own category string, not yet the ONDC taxonomy code, see gap below. |
| `product.material` | `Item.tags` → `kalasetu_provenance` tag group, `material` | ONDC's `Tag`/`TagGroup` structure (`Item.tags[]`) is the protocol's own mechanism for extended metadata that has no dedicated field, so this is the correct place for it, not an invented top-level field. |
| `product.technique` | same tag group, `technique` | |
| `product.timeTaken` | same tag group, `time_taken` | This is craft-making time, not `Item["@ondc/org/time_to_ship"]` (a shipping SLA field); the two are not the same thing and are not conflated here. |
| `product.giTag` | same tag group, `gi_odop_tag` | |
| `product.careInstructions` | same tag group, `care_instructions` | |
| `product.artisanName`, `product.region` | same tag group, `artisan_name`, `region` | |
| Craft Heritage Passport URL | same tag group, `kalasetu_passport_url` | Not an ONDC field; included because it's useful provenance context for a buyer app that chooses to render it. |
| Artisan's shop name | `Provider.descriptor.name` | |
| Artisan's account ID | `Provider.id` | Placeholder only, see gap below. |
| Artisan's `region` | `Provider.locations[].address.state` | Only the state is known, see gap below. |

Internal-only fields are never exported: `materialCost`, `status`, `flagged`/`flagReason`, `autoFlagReason`, `reviewStatus`/`reviewedAt`/`reviewedBy`/`reviewReason`, `productStory`, and `storyGeneratedAt` have no ONDC counterpart and are not seller-facing catalog data.

## Known gaps

Fields ONDC's schema expects that KalaSetu does not yet have real data for. Each is omitted from the export (or, for `provider.id`, clearly marked as a placeholder) rather than filled with an invented value:

| ONDC field | Gap |
|---|---|
| `Item.category_id` | Exported as KalaSetu's own category (pottery, textiles, woodwork, etc.), not yet mapped to ONDC's official category taxonomy for the applicable retail vertical. That mapping depends on which vertical the seller registers under and must be finalized at onboarding. |
| `Item.quantity` | KalaSetu does not track stock or inventory count at all. Omitted entirely rather than defaulted to a guess (such as "1 in stock"). |
| `Item.fulfillment_id`, `Provider.fulfillments` | Delivery/pickup type, service area, and time-to-ship are not modeled by KalaSetu. Omitted; must be configured at onboarding. |
| `Item.price.maximum_value` | KalaSetu tracks a single artisan-set selling price, no separate MRP or listed price. Omitted rather than duplicating the selling price as a fabricated maximum. |
| `Item["@ondc/org/returnable"]`, `cancellable`, `return_window`, `available_on_cod` | Return, cancellation, and cash-on-delivery policy are not modeled. These carry real consumer-protection and legal weight, so they are deliberately omitted rather than defaulted; the artisan must set them explicitly at onboarding. |
| `Item.descriptor` (regional-language name/description) | The verified core `Descriptor` schema has no documented multi-language name field. Only the English title and description are exported; `product.titleLocal` / `descriptionLocal` are not represented in this format. |
| `Provider.id` | No real ONDC-issued subscriber/provider ID exists, since that is assigned during ONDC network participant registration, which KalaSetu has not done. The artisan's internal KalaSetu account ID is used as a structural placeholder so the JSON is well-formed, and is called out as a placeholder in the export itself. |
| `Provider.locations[].address` (door, street, city, area_code), `Provider.locations[].gps` | KalaSetu collects only a state-level region for an artisan, not a full pickup address, city, pincode, or GPS coordinates. All of those are required by ONDC's `Location` schema for real fulfillment and are omitted here beyond `state`. |

## What "integration-ready" means, and doesn't

The honest claim: the engineering surface is mapped, field by field, against a verified ONDC schema, and the code that produces this mapping is real and tested. Going live on the ONDC network is a registration and onboarding process (network participant registration, a subscriber ID, signing keys, staging sign-off), not a development effort on KalaSetu's side.

The claim this does **not** make: that KalaSetu is connected to, transacting on, or in any way live on the ONDC network today. No UI in this app should ever imply otherwise, and the export itself carries a `_kalasetu_export.note` field saying so explicitly.

## Where this lives in the codebase

- [`shared/ondcCatalog.ts`](shared/ondcCatalog.ts): the pure mapping functions (`mapProductToOndcItem`, `buildOndcCatalogExport`, `buildOndcSingleProductExport`) and the gap list, shared so both a future server-side use and the current client-side export use the same logic.
- [`shared/ondcCatalog.test.ts`](shared/ondcCatalog.test.ts): tests the mapping, the gap list, and specifically that no cost or moderation data ever leaks into an exported item.
- [`src/services/ondcExport.ts`](src/services/ondcExport.ts): adapts KalaSetu's frontend `Product` type into the shared mapper's input shape and triggers the browser download.
- "Export catalog (ONDC format)" on the artisan's My Shop screen exports every currently published, unflagged listing as one catalog (one `Provider`, many `Item`s). The same action is available per product from that product's detail sheet.
