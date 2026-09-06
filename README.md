# KalaSetu

A multilingual mobile-first PWA that helps Indian artisans photograph, describe, price, and publish their products, using their voice instead of a keyboard.

An artisan records a voice note in their own language. The app transcribes it, writes a product description that invents nothing they did not say, suggests a fair price from their material cost, and publishes the listing.

## Stack

- Vite + React + TypeScript, plain CSS with custom properties, no UI framework
- English plus all 22 languages of the Eighth Schedule, chosen on the welcome screen
- `vite-plugin-pwa` for the service worker, manifest, and offline app shell
- Express API deployed as a single Vercel serverless function
- Supabase Postgres for data, Supabase Storage for images
- Email OTP sign in with app issued JWT sessions
- Groq (Whisper and gpt-oss-120b) for transcription, translation, and description, with Gemini as a switchable fallback
- `sharp` for image enhancement
- `qrcode` for the Craft Heritage Passport's scannable link, generated entirely client side

## Getting started

```bash
npm install
cp .env.example .env    # fill in the values, see SETUP.md
npm run dev
```

Then open `http://localhost:5173`. `npm run dev` runs the Vite frontend and the Express API together (labelled `[web]` and `[api]`); Vite proxies `/api/*` to the API process, so the app talks to a real backend at the same origin locally, the same as it does in production on Vercel.

Full walkthrough for Supabase, Gemini, and deploying to Vercel is in [SETUP.md](SETUP.md). The on-device checklist is in [TESTING.md](TESTING.md). The ONDC catalog field mapping is in [ONDC_CATALOG_MAPPING.md](ONDC_CATALOG_MAPPING.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs the Express API (`:8787`) and the Vite dev server (`:5173`, proxying `/api` to the API) together |
| `npm run dev:web` | Vite dev server only, no working `/api` |
| `npm run dev:api` | Express API only, on `:8787`, restarts on file changes |
| `npm run build` | Type checks and builds to `dist/` |
| `npm run preview` | Serves the production build |
| `npm run lint` | oxlint |
| `npm run typecheck:server` | Type checks `server/` and `api/` |
| `npm test` | vitest |
| `npm run verify:rls` | Checks row level security policies directly against Postgres |
| `npm run promote:admin -- <email>` | Promotes an existing account to admin (they must have signed in once first) |
| `npm run seed:demo-admin -- [email]` | Creates (or fixes up) one admin account directly, no prior sign-in needed. Defaults to `admin@kalasetu.demo` |
| `npm run admin:set-password -- <email> <password>` | Sets or changes an admin's sign-in password (8+ characters). They sign in with it instead of an OTP from then on |
| `npm run seed:demo-data` | Populates the marketplace with realistic demo artisans, products, buyers, inquiries, and view history. Wipes and regenerates its own data, safe to re-run |
| `npm run seed:demo-data:wipe` | Removes everything the seed script created, without regenerating it |

CI runs all of these on every pull request.

## Project structure

```
src/                 the PWA
  screens/           one folder per screen
    Onboarding/      welcome, email entry, OTP verification
    Home/            My Shop catalog, product detail sheet, GeM/ONDC banner
    AddProduct/      camera, enhancement studio, category, voice description, pricing, publish
    Profile/         profile and language
    Marketplace/     buyer portal: browse/search/filter, product detail, inquiries, profile
    Console/         admin console: dashboard, artisans, moderation, flagged listings
    Passport/        the public Craft Heritage Passport certificate page
    Analytics/       artisan-facing view and inquiry analytics dashboard
    Inquiries/       artisan-facing inbox for buyer inquiries
    NotFound/        generic 404, also used to hide the console route from non-admins
  components/        Button, Card, Input, OtpInput, LanguageToggle, RegionSelect, Skeleton, ConfirmDialog, BottomNav
  context/           Auth, Language, AddProductDraft
    locales/         one JSON dictionary per language
  services/          api/ one module per resource, audio.ts (WAV conversion)
  styles/            variables.css (design tokens), global.css

server/              the API, an ordinary Express app
  app.ts             the Express app and its middleware/route mounting, imported by both vercel.ts and dev.ts
  vercel.ts          Vercel's serverless entry point, wraps app.ts as a Node request handler
  dev.ts             local-only entry point, app.listen() on :8787, used by `npm run dev:api`
  routes/            one router per resource, all mounted under /api
  middleware/        session verification, role checks, raw body reading, async errors
  lib/               supabase client, env schema, JWT, OTP, inquiry email, own-storage URL guard, passport id generation
  services/          pricingEngine.ts, imageEnhancer.ts, imageStudio.ts
  voice-ai/          provider-agnostic STT, translation, description pipeline
  image-ai/          swappable background removal provider, mirrors voice-ai/

api/index.ts         Vercel entry point, exports the Express app
shared/languages.ts  the language registry, used by both halves
shared/regions.ts    the fixed list of Indian states/UTs, used by both halves
shared/materials.ts  the fixed list of product materials, used by both halves
shared/ondcCatalog.ts the ONDC retail catalog field mapping, used by the frontend export today
shared/whatsapp.ts   number normalisation and wa.me link building, used by both the buyer and artisan sides
shared/shippingRateCard.ts the shipping estimate rate table, the one file to edit to change the numbers
shared/shippingEstimator.ts pure zone classification and cost-range calculation over that rate card
supabase/
  schema.sql         tables, index, counter function, RLS, storage bucket
  migrations/        run these against a database created before a change
```

## API

Everything is mounted under `/api` and served from the same origin as the PWA, so `VITE_API_BASE_URL` stays empty in production. All routes except health and auth require `Authorization: Bearer <session token>`.

| Method | Route | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ status, version }` |
| POST | `/api/auth/request-otp` | `{ email }` | `{ success, emailDelivered, expiresInMinutes, requiresPassword }`, sends no code when `requiresPassword` is true |
| POST | `/api/auth/verify-otp` | `{ email, otp, intendedRole? }` | `{ token, userId, email, role }` |
| POST | `/api/auth/admin-login` | `{ email, password }` | `{ token, userId, email, role }`, admin only, locks for 15 minutes after 5 wrong attempts |
| GET | `/api/users/me` | | `UserProfile` |
| PATCH | `/api/users/me` | `{ displayName?, shopName?, region?, whatsappNumber?, pincode?, language? }` | `{ success }` |
| POST | `/api/images/enhance` | raw image bytes | `{ enhancedImageUrl, originalImageUrl, width, height }`, artisan only |
| POST | `/api/images/remove-background` | raw image bytes | `{ cutoutUrl, backgroundRemoved, notice? }`, artisan only |
| POST | `/api/images/finalize` | `{ sourceUrl, options }` | `{ finalImageUrl, width, height }`, artisan only |
| POST | `/api/voice/transcribe` | raw audio bytes, `?category=` and `?language=` | `{ transcript, descriptionEn, descriptionLocal, localLanguage, detectedLanguage }` |
| POST | `/api/pricing/suggest` | `{ category, materialCost or rawMaterials, ... }` | range, confidence, market reference, breakdown |
| POST | `/api/products` | `ProductInput` | `{ productId, passportId }`, artisan only |
| GET | `/api/products` | | `ProductWithViewCount[]`, the caller's own, each with a real view count |
| GET | `/api/products/marketplace` | `?q=&category=&material=&region=&minPrice=&maxPrice=&sort=&page=&limit=` | `{ items, page, limit, total, hasMore }`, published and unflagged only |
| GET | `/api/products/marketplace/:id` | | `ProductWithArtisan`, a single published listing plus a live artisan summary |
| PATCH | `/api/products/:id` | partial `ProductInput` | `{ success }`, artisan only, own product |
| DELETE | `/api/products/:id` | | `{ success }`, artisan only, own product |
| POST | `/api/inquiries` | `{ productId, message, quantity?, contactPreference, contactValue? }` | `{ inquiryId, emailDelivered }`, buyer only, emails the artisan (best effort) |
| GET | `/api/inquiries/mine` | | `Inquiry[]`, buyer only, sent by the caller |
| GET | `/api/inquiries/received` | | `Inquiry[]`, artisan only, about the caller's products, marks them read as a side effect |
| PATCH | `/api/inquiries/:id` | `{ status: "closed" }` | `{ success }`, either party to the inquiry |
| PATCH | `/api/inquiries/:id/responded` | | `{ success }`, artisan only, own inquiry |
| GET | `/api/internal/console/dashboard` | | `DashboardStats`, admin only, 404 for everyone else |
| GET | `/api/internal/console/artisans` | `?q=&page=&limit=` | `{ items, page, limit, total, hasMore }`, admin only |
| GET | `/api/internal/console/artisans/:id` | | `ConsoleArtisanDetail` (profile + every listing), admin only |
| PATCH | `/api/internal/console/artisans/:id` | `{ isActive, reason? }` | `{ success }`, admin only, deactivation blocks that artisan's next login |
| GET | `/api/internal/console/moderation/queue` | `?page=&limit=` | `{ items, page, limit, total, hasMore }`, `review_status = 'pending'` only, admin only |
| PATCH | `/api/internal/console/moderation/:id/approve` | | `{ success }`, admin only |
| PATCH | `/api/internal/console/moderation/:id/reject` | `{ reason }` | `{ success }`, admin only, pulls the listing from the marketplace |
| PATCH | `/api/internal/console/moderation/:id/flag` | `{ reason }` | `{ success }`, admin only, pulls the listing from the marketplace |
| GET | `/api/internal/console/flagged` | | `{ available, items }`, admin only, listings auto-flagged as priced above the typical range for their category |
| GET | `/api/internal/console/audit` | `?limit=` | `AuditLogEntry[]`, admin only |
| GET | `/api/passport/:passportId` | | `PublicPassport`, public, no auth, published and unflagged only |
| POST | `/api/analytics/view` | `{ productId }` | `{ success }`, buyer only, debounced client side per session |
| GET | `/api/analytics/summary` | | `AnalyticsSummary`, artisan only, own products only |

Uploads send the file as the raw request body with its real type in an `X-File-Type` header rather than as multipart. Serverless runtimes buffer and consume the request stream before the handler runs, which breaks multipart parsers; reading a raw body works both under a normal Express server and on Vercel.

## Auth

Email OTP, issued by this API rather than a third party. SMS was not viable: sending to Indian numbers requires DLT registration, which takes days and a registered entity.

`request-otp` stores a SHA-256 hash of a 4 digit code with a 10 minute expiry and emails it through Resend. `verify-otp` checks it and returns a JWT that the client sends on every later request. Codes are single use, capped at 5 attempts, and compared with a timing safe comparison. Sessions last 7 days; changing `JWT_SECRET` revokes all of them at once.

Email delivery is optional. Without `RESEND_API_KEY` the app still works through the demo fallback code, which is documented in [SETUP.md](SETUP.md) along with how to turn it off.

**Admin accounts sign in with a password instead, once one is set.** An admin's email never gets an OTP, so there is nothing in an inbox for anyone else to intercept, and no dependency on Resend being configured for the account that runs the moderation console. `POST /api/auth/request-otp` looks the email up first; if it belongs to an admin with `users.password_hash` set, it sends no code at all and returns `{ requiresPassword: true }`, which sends the frontend to a password screen instead of the OTP one. `POST /api/auth/admin-login` verifies the password (salted scrypt via [server/lib/password.ts](server/lib/password.ts), timing-safe compare, no dependency added) and issues the same session token `verify-otp` would. Five wrong passwords locks the account for 15 minutes (`users.failed_login_attempts`/`locked_until`), and every response is a generic `invalid_credentials` regardless of whether the email or the password was wrong, so a failed attempt never confirms which admin emails exist.

**There is deliberately no in-app way to set an admin's own password.** The one and only way is `npm run admin:set-password -- <email> <password>` (a `service_role`-key script, same trust model as `promote:admin`), because a self-serve "set my password" flow would need to exist before the account can prove who it is, which is exactly the bootstrap problem OTP already solves for everyone else. An admin promoted via `promote:admin` or created via `seed:demo-admin` keeps signing in with OTP until someone runs this script for them; nothing breaks in the meantime.

## Roles

Every account is `artisan`, `buyer`, or `admin`, stored in `users.role` and defaulting to `artisan`. `verify-otp` reads the role fresh from the database and returns it alongside the token; the frontend uses it once, right after login, to send an artisan to `/`, a buyer to `/marketplace`, or an admin to `/internal/console`. Nothing about that redirect is trusted afterward: every admin-only route re-checks the role from the database on every request, never from the session token, so revoking someone's access takes effect on their very next request rather than waiting out a 7 day token.

`users.is_active` (default `true`) is the other login gate: `verify-otp` rejects a deactivated account with `403 { error: "account_deactivated" }` before it ever issues a token, regardless of role. The admin console is the only thing that can flip it, and only for artisans.

The email screen asks "I'm here to sell / buy" before sending the code. That choice (`intendedRole`, restricted to `artisan` or `buyer`, `admin` is not a legal value here) sets the role the moment `verify-otp` first creates the account row. For an email that already has an account, picking the *same* role signs them in as usual; picking the *other* one is refused outright with `409 { error: "email_role_mismatch", existingRole }` rather than silently logging them into their existing account under the wrong assumption, so a seller's email can never end up fronting as a buyer account or the reverse. Admin is exempt from this check both ways: it's never a legal `intendedRole`, and an existing admin account signs in regardless of which of "sell"/"buy" they happened to click, since neither describes what they actually do. No code path accepts a `role` value for an *existing* account either: `PATCH /api/users/me` never lists `role` as an updatable field, and `users.role` also has `UPDATE` revoked from the `authenticated` and `anon` Postgres roles as a second, independent lock.

Admin cannot be self-selected anywhere, by design. Promote an existing account (they must have signed in at least once) with `npm run promote:admin -- someone@example.com`, or by hand in the Supabase dashboard's Table Editor. Either way it's a one-off, out-of-band action with the service role key, never something the running app can do to itself.

Buyers browse `GET /api/products/marketplace`, which returns published, unflagged listings from every artisan. An artisan's own `GET /api/products` still only returns their own listings, exactly as before roles existed. Admin moderation (`flagged`, `flag_reason`) is guarded by a database trigger rather than a column grant, because an artisan and an admin share the same Postgres `authenticated` role, so a column-level `REVOKE` cannot tell them apart; only Postgres RLS combined with a per-row role lookup can.

## Buyer marketplace

Four screens under `src/screens/Marketplace/`: browse (search, filter, sort, pagination), product detail (gallery, description, artisan summary, a WhatsApp handoff, and an inquiry form, see "Buyer-to-artisan inquiries" below), and a buyer profile (details plus sent inquiries). All of it sits behind `MarketplaceLayout`, a top nav shared across the three, because buyers need this to work as a real desktop website as well as inside a mobile WebView. A buyer's profile is deliberately just a name, a region, and a language: there is no company name field, since nothing in the app reads one and a B2B buyer's company adds nothing an artisan acts on.

**Filtering fields that didn't exist before this**: `products.material`, `products.region`, and a denormalized `products.artisan_name`, plus `users.region` as the source an artisan sets once in their profile and that gets copied onto each new listing at creation time, the same snapshot pattern already used for `title_local` and `inquiries.artisan_id`. All three are nullable; existing accounts and products just read as unspecified until an artisan fills them in. [`shared/regions.ts`](shared/regions.ts) and [`shared/materials.ts`](shared/materials.ts) are the fixed lists both the artisan-side pickers and the buyer-side filters validate against, the same pattern as [`shared/languages.ts`](shared/languages.ts).

**Search never touches raw SQL.** `GET /api/products/marketplace` applies category/material/region/price as ordinary parameterized `.eq()`/`.gte()`/`.lte()` calls, safe by construction, then runs the free-text `q` match and the price sort as plain JavaScript over the already-filtered rows (capped at 1000 candidates) before slicing out the requested page. That's deliberate: building a raw `.or()` filter string out of buyer-supplied search text is exactly the injection surface a PostgREST filter string opens up, and at this data scale doing the last mile in application code is both simpler and safer than getting that escaping right.

**RLS as the backstop, per the brief**: buyers reading only published/unflagged rows is enforced first in the query (`.eq("status", "published").eq("flagged", false)`), same as the existing `products_select_published` policy already covers as backstop; nothing new was needed there. There is no write path for a buyer to reach a product at all, at any layer: `POST/PATCH/DELETE /api/products` are all `requireRole("artisan")`, and the buyer role has no product-write RLS policy either.

**Desktop responsiveness required one shared-shell change.** The whole app was capped at `max-width: 390px` on `#root`, fine for a mobile-only experience, wrong for a page meant to also work as a desktop website. `#root`'s max-width now reads a `--shell-max-width` custom property (default still `390px`), which `MarketplaceLayout`, `ConsoleLayout`, `PassportScreen` and (see "Artisan section on desktop" below) `AppLayout` each override to `none` while mounted.

**Scope note**: "image gallery" on the product detail screen renders whatever a multi-image gallery would, but today's schema only ever stores one `image_url` per product, so it's a gallery of one. Adding multi-image capture to the artisan side is a separate, larger feature this didn't pull in.

## Artisan section on desktop

The artisan side was built mobile-first and stayed that way, so on a laptop it was a 390px column stranded in the middle of the screen. It is now responsive at a single `900px` breakpoint, and **below that breakpoint nothing changed at all**: every rule is additive, inside `@media (min-width: 900px)`, so the phone layout is byte-for-byte the one that was there before.

**What changes at 900px.** `AppLayout` (My Shop, Analytics, Inquiries, Profile) sets `--shell-max-width: none` the same way `MarketplaceLayout` already did, and an `.artisan-shell` wrapper takes over width control: 390px below the breakpoint, `1180px` above it. The fixed bottom tab bar becomes a sticky full-width **top** bar (same component, same three links, CSS only, via a `.bottom-nav-inner` wrapper that keeps the links aligned to the same 1180px column), because a 390px tab bar pinned to the bottom of a wide screen is the single most obviously-mobile thing about the old layout. The "Add" tab keeps its accent treatment but drops the raised FAB circle, which only makes sense in a thumb-reach bar.

**Using the space, rather than just stretching into it.** My Shop's product grid goes from a fixed 2 columns to `auto-fill` at a 220px minimum (4 to 5 across on a laptop), the product detail bottom sheet becomes a centred modal, Analytics' stat cards go 2 across to 4 across, and the inquiry inbox becomes a 2-column card grid. Text-and-form screens deliberately do **not** stretch: Profile is capped at a readable 560px column (`.artisan-form-column`), because a full-width text input at 1180px is worse, not better.

**The add-product flow is deliberately left at mobile width.** It is a camera-first, one-decision-per-screen capture wizard; widening it would mean redesigning every step for a shape it was never meant to have, and a centred narrow column is the normal, correct treatment for that kind of flow on desktop. That is a scope decision, not an oversight.

## Buyer-to-artisan inquiries

Async, not real-time chat, on purpose: an inquiry plus a WhatsApp handoff is closer to how this trade actually happens than an in-app chat would be, and building real-time messaging wasn't a good use of the time available.

**The inquiry form** on the buyer's product detail page asks for a quantity (optional), a free-text message, and a contact preference (email, phone, or WhatsApp; a phone number is required for the latter two, validated both client and server side).

**The send button never silently does nothing.** It used to be `disabled` whenever the message was empty or a phone number was missing, with no explanation anywhere on screen, so entering a perfectly good 10 digit number and pressing send looked like the form was broken rather than incomplete. The button is now always enabled (except while a send is in flight) and validates on click, marking the specific field at fault: an empty message gets a red border and "add a short message", and a phone number that isn't one gets an inline error under the field. The number itself is checked with the same `isValidWhatsAppNumber` from [`shared/whatsapp.ts`](shared/whatsapp.ts) that the artisan's own WhatsApp field uses, so a 10 digit Indian mobile and a `+91`-prefixed one are both accepted and neither side of the app disagrees about what a valid number is. `inquiries` gained `quantity`, `contact_preference`, `contact_value`, `read_at`, `responded_at`, and `notified_at` columns for this; the original `status` (`open`/`closed`) column is untouched and still means what it always meant.

**WhatsApp is the obvious option, not a hidden one.** If the artisan has added a WhatsApp number to their profile (`users.whatsapp_number`, optional, artisan side only, validated with [`shared/whatsapp.ts`](shared/whatsapp.ts)), a prominent green "Message on WhatsApp" button sits above the inquiry form, not after it, opening `wa.me` with the product name and passport ID pre-filled. The in-app form is the fallback, not the primary path, deliberately, per the brief.

**Email never risks the record.** `POST /api/inquiries` inserts the inquiry row first; only after that succeeds does it attempt to email the artisan via the existing Resend setup (`sendInquiryEmail` in [`server/lib/mailer.ts`](server/lib/mailer.ts), same never-throws contract as the OTP mailer). The email includes the product name, its photo, the buyer's message, the requested quantity, the preferred contact, and a deep link (`PUBLIC_APP_URL/inquiries`) back into the artisan's inbox. If Resend is unreachable, misconfigured, or rejects the request, the inquiry is already saved and the artisan still sees it in the app; only `notified_at` stays null.

**The artisan inbox** at `/inquiries`, linked from My Shop, lists every inquiry received. Opening the inbox marks the inquiries visible in that load as read as a side effect of `GET /api/inquiries/received` itself (the response still reflects each row's read state from just before that update, so the badge that says "New" is accurate for that one view). "Mark as responded" is a separate, explicit action (`PATCH /api/inquiries/:id/responded`, artisan only, own inquiries only) from either reading it or closing it, since responding usually happens over WhatsApp or a phone call, outside the app entirely; the inbox surfaces a "Reply on WhatsApp" shortcut using the buyer's own contact value when they gave one.

**RLS** needed no changes here: the existing `inquiries_select_buyer`/`inquiries_select_artisan`/`inquiries_select_admin`/`inquiries_update_parties` policies already cover every new column, since they're scoped by row, not by field.

## Shipping cost estimate

Product prices exclude shipping, which used to make the buyer's total misleading and let an artisan under-price without realising a courier would eat into their margin. This is a rule-based estimator, not a courier integration: KalaSetu has no merchant account with any courier and makes no network call to price a shipment, ever.

**How it's built, and why it's trustworthy enough to explain to a judge.** Indian courier rate cards are publicly known to be structured as zone (how far the shipment is going) x weight slab (500g steps), plus a fuel surcharge and GST on top; [`shared/shippingRateCard.ts`](shared/shippingRateCard.ts) models that exact structure with representative numbers and is the one file to edit if those numbers need updating, heavily commented (a deliberate, narrow exception to this project's usual no-comments rule, because the brief specifically asked for a rate table that's "easy to update and easy to explain to judges"). [`shared/shippingEstimator.ts`](shared/shippingEstimator.ts) is the pure calculation logic that reads it and needs no comments of its own; [`shared/shippingEstimator.test.ts`](shared/shippingEstimator.test.ts) covers the zone classification and cost math, 21 tests, no database needed.

**Five zones, cheapest to most expensive**: same city, within state, metro-to-metro, rest of India, and a "special" zone for Jammu & Kashmir, Ladakh, Sikkim, the North-Eastern states, and the Andaman & Nicobar Islands, the same handful of buckets every major Indian courier uses. A zone is inferred from comparing the first few digits of an origin and destination pincode (matching pincode prefix conventions, not a live address lookup), which is exactly why this is an estimate and is labelled as one everywhere.

**Always a range, never a fake-precise number.** Different couriers charge differently for the same zone and weight, by a well-documented 15-20%. Rather than presenting false precision, every estimate widens the computed cost into a range using that same spread, and the UI never shows a single number.

**Two inputs an artisan and a buyer provide, both optional so nothing existing breaks.** `products.weight_kg` (an approximate weight, picked from a preset "light/medium/heavy/very heavy" or typed exactly, on the same optional-details step as technique and care instructions) and `users.pincode` (an artisan's own origin pincode, and, separately, a buyer types their own destination pincode inline on the product page, cached in `sessionStorage` only, never saved to their account, since a buyer might be shipping somewhere other than home).

**Shown twice, honestly labelled both times.** The buyer's product detail page shows "Estimated shipping" as a range next to the price once they enter a pincode, plus an "estimated delivered total" (price plus that range), with a disclaimer that it is not a live quote, a courier booking, or a guaranteed price. The artisan sees the same rate card applied to their own product's weight at listing time, broken down by all five zones at once (there's no real buyer yet to pick one destination for), specifically so they can see how much of their margin shipping might actually take before they publish.

**Extending two more already-shipped, high-traffic routes** (`GET /api/users/me`, marketplace product detail) with `pincode` reused the same 42703-catch-and-retry fallback already added for `whatsapp_number`, so neither breaks on a database that hasn't run migration 009 yet. `products.weight_kg` deliberately was **not** added to the shared `PRODUCT_COLUMNS` constant used by browsing, moderation, and the public passport page, none of which need it; it's fetched separately, and fails soft, only in the two places that actually use it (My Shop and the buyer's product detail).

## Admin console

Four screens under `src/screens/Console/`, deliberately unlinked from anywhere in the public app: dashboard (stat cards, a hand-rolled SVG bar chart of signups, recent audit activity), artisan management (searchable paginated table, per-artisan profile and listing history, deactivate/reactivate, and a permanent delete-with-reason on any of that artisan's own listings), listing moderation (a search box, a queue, approve/reject-with-reason/flag-with-reason), and flagged listings. It's the one part of this app written in plain English with no `t()` calls: the audience is internal admin staff, not artisans or buyers, and translating a dense data table across 22 languages for that audience isn't a good trade.

**Route obscurity is convenience, not the security boundary, exactly as asked.** The path is `/internal/console`, linked from nowhere. A non-admin hitting any `/api/internal/console/*` endpoint gets a bare `404`, indistinguishable from a route that doesn't exist, whether they're a logged-in artisan, a logged-in buyer, or not logged in at all: `requireAdminOr404` in [server/middleware/requireAdminOr404.ts](server/middleware/requireAdminOr404.ts) verifies the session token and re-checks the role from the database itself, and answers 404 for every failure mode uniformly, never 401 or 403, since either of those would confirm to a curious visitor that a gated route exists here. The frontend guard (`RequireAdminOr404` in `App.tsx`) does the same: a non-admin sees the same generic "Page not found" screen as any bad URL, never a redirect, since a redirect would itself leak "you're logged in as someone this route knows about." RLS backs both: `products_select_admin`/`users_select_admin`/`users_update_admin` already gate the tables this reads and writes.

**Retrospective moderation, not a publish gate**, a deliberate choice: publishing stays instant and artisan-facing messaging is unchanged. Every product still gets `review_status = 'pending'` at creation, but that's advisory bookkeeping for the admin queue, not a visibility switch, and a brand new listing is already live in the marketplace the moment it's created, same as before this existed. `status` and `flagged`, the two fields that actually gate marketplace visibility, are untouched by "pending." Approve marks `review_status = 'approved'` and changes nothing else, since the listing was already visible. Reject requires a reason, sets `review_status = 'rejected'`, and moves `status` to `'draft'`, pulling it from the marketplace, reversibly (the row still exists, nothing is deleted). Flag requires a reason and reuses the `flagged`/`flag_reason` columns the buyer marketplace already excludes. Because "Pending" (not yet reviewed) and "already live" are two independent facts about the same row, the artisan detail screen's listing table spells this out directly next to the Review column, so an admin doesn't read "Pending" as "hidden, waiting for approval."

**Moderation queue search** follows the same pattern as artisan search: fetch pending candidates (capped at 1000), filter by title/artisan/category in application code, then paginate the filtered result, rather than building a raw filter string out of admin-typed search text.

**Deactivating an artisan** sets `users.is_active = false`, checked at `verify-otp`, so the very next sign-in attempt is refused; it does not touch their existing listings. Reactivating is the same endpoint with the flag flipped back.

**Deleting a listing is the one genuine hard delete in this feature**, and it's deliberately scoped narrowly: `DELETE /api/internal/console/products/:id`, admin only, requires a reason like reject/flag do, removes the row outright (its passport link and inquiry history go with it, both foreign keys cascade), and decrements the artisan's `total_products` the same way an artisan deleting their own listing does. It exists specifically so an admin can remove a listing that should never have existed (spam, a genuine policy violation) rather than only ever being able to reject or flag it back into draft. Every other moderation action in this console stays reversible; this one is the deliberate exception, gated behind a required, audited reason.

**Every moderation action and every deactivate/reactivate writes to `audit_log`** (actor, action, target table and id, an optional reason, optional metadata, timestamp) via `recordAudit()` in [server/lib/auditLog.ts](server/lib/auditLog.ts). It's best-effort: a failed audit write is logged server side and does not roll back or block the underlying action, a deliberate choice given the scope here (an admin tool's activity trail, not a financial ledger needing transactional guarantees).

**Flagged listings, now live.** `GET /api/internal/console/flagged` returns every listing with a non-null `products.auto_flag_reason`, set automatically by the pricing engine's overcharge check (see "Pricing overcharge auto-flag" below). It still catches Postgres's `42703` (undefined column) and returns `{ available: false, items: [] }` gracefully for a database that predates `supabase/migrations/006-pricing-overcharge-flag.sql`, but on a migrated database this screen now genuinely populates. The moderation queue also shows a small "Above typical range" badge for the same reason, so admins reviewing new listings see it without an extra click.

**Confirm dialogs are one reusable component** ([src/components/ConfirmDialog.tsx](src/components/ConfirmDialog.tsx)), used for deactivate and for reject/flag's required-reason prompt, matching the existing design system rather than adding a modal library.

**Demo login**: `npm run seed:demo-admin -- you@example.com` (or no argument, defaults to `admin@kalasetu.demo`) creates the account directly with the service role key, no prior sign-in required, unlike `promote:admin`. Sign in through the normal email screen afterward; the role choice on that screen is ignored for an account that already exists. Optionally follow it with `npm run admin:set-password -- you@example.com yourpassword` so that account signs in with a password from then on instead of an OTP.

## Craft Heritage Passport

Every product gets a public, shareable certificate of origin at `/passport/ART-YYYY-NNNNNN`, viewable with no login. It exists to give a handmade product a digital identity beyond the commercial listing: a QR code, the artisan's name and region, craft type, technique, materials, time taken, creation date, an optional GI/ODOP tag, care instructions, and a short Product Story, styled to read like a certificate rather than a normal product page.

**Passport ID.** `ART-` plus the creation year plus a 6-digit sequence number, e.g. `ART-2026-001892`, assigned at product creation by [`next_passport_number`](supabase/migrations/005-heritage-passport.sql), a Postgres function that does an atomic upsert-and-return on a `passport_counters(year, last_value)` table, the same race-safe pattern already used for `increment_total_products`. Existing products were backfilled by actual creation year and creation order, so historical listings get historically appropriate numbers rather than being bunched into the current year.

**The Product Story is the one place in this app with an explicit anti-fabrication prompt**, because a fabricated cultural claim in front of anyone evaluating this would be worse than no story at all. [`server/voice-ai/description/heritagePrompt.ts`](server/voice-ai/description/heritagePrompt.ts) builds one shared prompt used by both the Groq and Gemini implementations, so the rule can't drift between providers. It explicitly marks every field the artisan didn't provide as "(not provided, omit this from the story)" rather than silently leaving it out, which is a stronger signal against the model quietly filling the gap, and it forbids inventing regional history or heritage claims even when the category or material would typically suggest one. The artisan's region is deliberately never passed into this prompt at all, specifically so the model has no place name to "helpfully" reason a tradition from. Generation happens once at product creation and the result is stored in `products.product_story`; the passport page never regenerates it. If generation fails for any reason, product creation still succeeds, `product_story` stays null, and the passport shows a plain "story not available" line instead of blocking the listing, the same non-blocking pattern used for background removal.

**No official claim, anywhere.** The passport's footer carries an explicit self-declared-record disclaimer, and the story prompt itself (rule 4) separately forbids the model from ever implying government verification or third-party certification. Both exist independently of each other on purpose.

**Public by design, narrow on purpose.** `GET /api/passport/:passportId` and the `/passport/:passportId` frontend route carry no auth middleware at all, deliberately, and the frontend route sits outside every auth-gating wrapper so a logged-in user isn't redirected away from a shared link either. The response is a hand-picked `PublicPassport` shape that excludes price, the owning user id, and every moderation field; a draft, flagged, or nonexistent passport id all return a plain 404. A matching anon-role RLS policy (`products_select_public_passport`) backs the same restriction at the database level.

**QR code and print.** The QR (linking to the passport's own public URL) renders client side with the `qrcode` package, no network call. Share uses the Web Share API where available and falls back to copying the link. A `@media print` stylesheet hides every button and produces a clean single-page certificate.

## Languages

The artisan picks a language on the welcome screen and the whole app follows: every label, the voice description, and the product listing.

[`shared/languages.ts`](shared/languages.ts) is the single source of truth, imported by both the PWA and the API. Interface copy lives in `src/context/locales/<code>.json`, keyed off the English file.

Those dictionaries are generated by `node scripts/build-translations.mjs`, which translates any key missing from a locale and leaves existing ones alone, so a hand corrected string is never overwritten. Run it after adding English copy.

**Every dictionary except English is machine translated and unreviewed.** Quality tracks how much of a language the models have seen. Spot checks at the time of writing:

| Quality | Languages | Notes |
|---|---|---|
| Good | Hindi, Bengali, Marathi, Tamil, Telugu, Gujarati, Kannada, Malayalam, Punjabi, Urdu, Odia, Assamese, Nepali, Sanskrit, Sindhi | Reads naturally on inspection |
| Unverified | Maithili, Kashmiri, Dogri, Konkani | Plausible, but Konkani looks like Marathi |
| Poor, needs a native speaker | Manipuri, Bodo, Santali | Visibly wrong: repeated words and mixed scripts |

Fix any of them by editing the JSON directly. The generator will not overwrite a key that already has a value.

The six `category.*` labels get the most scrutiny, because they are also used as product titles. Several were wrong on inspection and have been corrected by hand: Tamil rendered pottery as limestone, Gujarati rendered jewellery as "deep", Telugu rendered woodwork as banyan, and Bengali, Marathi, Urdu and Malayalam all mistranslated cane. Others may still be wrong in languages nobody on the team reads.

A product stores English plus the artisan's own language, with the language recorded alongside it, so a listing can always be shown in both. Speech is not restricted to the app's list: the artisan can speak anything the model can hear, and the detected language never gates the request. Urdu, Sindhi and Kashmiri render right to left.

## Swapping the AI provider

`VOICE_AI_PROVIDER` selects `groq` (default) or `gemini`. Nothing else changes: the pipeline talks to `SpeechToTextService`, `TranslationService`, and `ProductDescriptionService`, and the factory picks the implementations. Only the selected provider's key is required, and the health endpoint reports which one is active.

Groq is the default because its free tier is far more generous. Gemini's free tier allows 5 requests per minute, and one voice note costs up to four, so a second recording inside a minute fails.

Groq's free tier caps tokens per day per model rather than per minute, and each model has its own allowance. When the primary model runs out, `groqChat` falls through to `GROQ_LLM_FALLBACK_MODEL` instead of failing the request, and logs that it did so. A heavy day on one model no longer takes the voice feature down.

## Surviving a spent Groq quota

Two independent allowances are worked through before a Groq request is allowed to fail, because running out of daily quota mid-demo is the most likely way this app breaks in front of anyone.

**Model fallback** is the first (above): each model has its own daily allowance, so a 429 on the primary model retries on `GROQ_LLM_FALLBACK_MODEL`.

**Key rotation** is the second. `GROQ_API_KEY_2` and `GROQ_API_KEY_3` are spare key slots tried in order after `GROQ_API_KEY`, and `GROQ_FALLBACK_API_KEYS` takes the same thing as a comma-separated list for anyone who wants more than two spares or prefers one line. The two spellings merge, in that order, and a duplicate key is only counted once; a blank slot costs nothing. [`server/voice-ai/groq/keyPool.ts`](server/voice-ai/groq/keyPool.ts) owns the pool and is shared by all three Groq paths (transcription, translation, description/heritage story) plus `scripts/build-translations.mjs`, which is where the quota actually gets burned in practice.

**The catch, and it is the whole story here: Groq counts the daily quota per organisation, not per key.** The 429 body says so itself ("in organization `org_...`"). Extra keys minted inside one Groq account all draw down the same allowance, so rotating between them buys exactly nothing. This only helps when each key belongs to a **separate Groq account**.

**A spent key rests rather than being dropped**, so nothing needs a redeploy to recover: a key that returns a daily-quota 429 is parked for 15 minutes, a per-minute limit is parked for however long the provider's own "try again in ..." hint says (capped at an hour), and once the cooldown passes the key rejoins the rotation. If every key happens to be resting, the pool hands back the full list rather than an empty one, so a mis-timed cooldown costs one failed attempt instead of turning a recoverable request into an instant failure. Only a 429 rotates; a genuine error (a 500, a bad request) fails immediately rather than replaying a broken request against every key in turn.

The cooldown map lives in memory, so on Vercel it only spans a warm instance. That is deliberate rather than worth a datastore: the worst case is one wasted probe per cold start, not a broken request. `GET /api/health` reports `config.groqKeys`, the number of keys actually parsed, which is the quickest way to confirm a deployment picked up more than one. Keys are masked (`gsk_...abcd`) wherever they are logged.

## Data and ownership

`users`, `products`, `inquiries`, `audit_log`, and `otp_codes`, defined in [`supabase/schema.sql`](supabase/schema.sql). Every product and inquiry read, update, and delete is scoped by ownership in the query itself, so knowing an ID is not enough to touch someone else's row. The API uses the service role key server side only, which bypasses row level security entirely, so this ownership scoping in the route code is what actually gates every request that comes through the API today.

Row level security is enabled on every table and carries the full three-role rule set: an artisan sees and writes only their own products and profile, a buyer reads published listings and writes only their own inquiries and profile, and an admin reads everything and can update moderation fields. It exists as a second, independent layer for anything that isn't the service-role-authenticated API, such as a leaked anon key or a future direct-from-browser read. [`scripts/verify-rls.mjs`](scripts/verify-rls.mjs) proves those policies directly against Postgres, and [`server/__roles.test.ts`](server/__roles.test.ts) proves the same six rules through the live API.

`users.total_products` is maintained by a Postgres function rather than a read-modify-write, so it cannot drift under concurrent writes.

## View tracking and artisan analytics

`products.select("id", { count: "exact", head: true })`-style aggregate queries over a new `product_views` table back an artisan-facing analytics dashboard at `/analytics`, linked from the "View analytics" text link on My Shop.

**What gets recorded, and what deliberately doesn't.** `product_views` stores only `product_id`, `viewer_role` (`buyer`, since `POST /api/analytics/view` is buyer-only), an optional coarse `region` copied from the buyer's own profile (never derived from IP), and a timestamp. No buyer identity, no IP address, ever. `POST /api/products/marketplace/:id` is unaffected: recording a view is a separate, fire-and-forget call the frontend makes only after that page has already loaded successfully.

**Debounced client side, not server side.** `ProductDetailScreen` records a view once per product per browser session (a small id list in `sessionStorage`), so a refresh or navigating back and forth doesn't inflate the count; opening the same listing again in a new tab or session is a genuinely new view, which is the right call for an engagement metric like this. The server independently re-validates the product is still published and unflagged before inserting, the same check `POST /api/inquiries` already does.

**Inquiries are not double-tracked.** `inquiries` already has `product_id`, `artisan_id`, and `created_at`; the analytics endpoint reads that table directly for inquiry counts rather than adding a redundant events table for something already normalized.

**`GET /api/analytics/summary` (artisan only)** returns real totals only, computed the same way the admin dashboard's signup chart already is (fetch raw rows in a date range, bucket by day in application code, no new SQL aggregation functions): `totalViews` and `totalInquiries` are all-time exact counts; `viewsThisWeek` is a 7-day count; `viewsOverTime` is a 30-day daily series; and `listings` is every one of the artisan's products with a view count and inquiry count computed over the same 30-day window, sortable by either in the UI. An artisan with no products, or products with no views yet, gets honest zeros back, not invented numbers, and the frontend renders a plain empty-state message instead of a flat chart or table when there's nothing to show yet.

**`GET /api/products` (My Shop)** now also returns a real per-product `viewCount`, computed the same way and shown on each product card. If the view-count lookup fails for any reason (including on a database that predates this migration), My Shop still loads, just with `viewCount: 0` everywhere, the same non-blocking philosophy used for background removal and the heritage story.

**RLS**: `product_views` carries `product_views_select_own` (an artisan reads rows only for products they own, via an `exists` subquery against `products`) and `product_views_select_admin`, mirroring every other table's three-role pattern. There is no insert policy, matching `audit_log`: only the service-role server ever writes a row.

## ONDC catalog export

"Export catalog (ONDC format)" on My Shop, and "Export this product (ONDC format)" on a single listing, download a JSON file that maps KalaSetu's product data onto the ONDC retail catalog structure (`Provider` and `Item` objects). Full field-by-field mapping and the list of gaps is in [ONDC_CATALOG_MAPPING.md](ONDC_CATALOG_MAPPING.md); the short version:

**This is a mapping, not a network integration**, and the code and copy are deliberately built to only claim the former. KalaSetu is not registered as an ONDC network participant, has no subscriber ID or signing keys, and makes no network calls anywhere in this feature. The exported file carries a `_kalasetu_export.note` field saying so explicitly, and there is no UI anywhere implying a live connection. Going live is a registration and onboarding process on ONDC's side, not further development on ours; that is the entire claim this feature makes.

**Verified against the real spec, not memory.** Every field name (`Item.descriptor`, `Item.price.value`, `Item.category_id`, `Item.tags`, `Provider.locations[].address.state`, and so on) is taken from the official [`ONDC-Official/ONDC-Protocol-Specs`](https://github.com/ONDC-Official/ONDC-Protocol-Specs/blob/master/protocol-specifications/core/v0/api/retail-hyperlocal.yaml) repository, fetched and quoted directly while building this feature.

**[`shared/ondcCatalog.ts`](shared/ondcCatalog.ts)** holds the pure mapping (no React, no Express), the same "used by both halves" pattern as `shared/languages.ts`/`shared/regions.ts`/`shared/materials.ts`, so it's covered by the same `shared/**/*.test.ts` suite rather than needing a new frontend test setup. `src/services/ondcExport.ts` adapts the frontend `Product` shape into the mapper's input and triggers the browser download; there is no new API route, since every field the mapper needs is already present client side.

**Fields ONDC expects that KalaSetu doesn't have yet** (inventory quantity, fulfillment/shipping configuration, return and COD policy, a real network provider ID, a full pickup address) are listed as gaps in the export's own `gaps` array and in the mapping doc, never filled with an invented value. A few fields that do exist in KalaSetu but have no dedicated ONDC slot (technique, time taken, GI/ODOP tag, care instructions, the passport link) are carried in `Item.tags`, which is ONDC's own documented mechanism for exactly this kind of extended metadata.

**GeM is untouched.** The existing "Connect to GeM / ONDC" banner on My Shop stays exactly as it was, a "coming soon" roadmap placeholder; this feature is a separate, additional action, not a replacement for that banner.

## Demo seed data

`scripts/seed-demo-data.mjs` fills the marketplace, admin console, and analytics dashboard with realistic content for a demo, rather than leaving them looking empty: 14 artisans across genuine Indian craft regions, around 45 products, 5 buyer accounts, a dozen or so inquiries, and 28 days of historical view data.

**Idempotent by wiping and recreating, not upserting.** Every seeded `users` row (artisan and buyer alike) is marked `is_seed = true`; every run starts by deleting all of them, which cascades through the existing foreign keys to remove every seeded product, inquiry, and view record in one step. That's also the entire "remove it cleanly" story: `npm run seed:demo-data:wipe` runs the same deletion and stops there.

**Writes to Postgres directly with the service role key, bypassing the API on purpose.** Running everything through `POST /api/products` would fire the real heritage-story and pricing-overcharge AI calls dozens of times and force every timestamp to `now()`; this needs realistic, spread-out `created_at`, `reviewed_at`, and view timestamps instead.

**Every craft-region pairing is real**, not invented: Banarasi silk brocade from Varanasi, Kanchipuram silk from Tamil Nadu, Krishnanagar clay figures from West Bengal, Bikaner terracotta from Rajasthan, bamboo basketry from Assam, cane weaving from Mizoram, brassware from Moradabad, Bidriware from Bidar, block print from Bagru and from Bhuj, silver filigree from Cuttack, oxidised silver jewellery from Jaipur, walnut wood carving from Kashmir, and lacquered toys from Channapatna. A GI tag is set only where one is genuinely registered (Banarasi, Kanchipuram, Bidriware, Channapatna, Cuttack filigree); every other product leaves it blank rather than guessing.

Two of those craft names don't have their own entry in `products.category`, which only supports six values app-wide: block print is filed under `textiles` (a textile technique, not a separate top-level category here), and brassware/Bidriware under `other`. The real craft is still fully captured in each product's material, technique, and title.

**Images come from `seed-images/<craft>/`**, one folder per craft (`handloom-textiles`, `pottery-terracotta`, `bamboo-cane`, `brassware-metalwork`, `block-print`, `jewellery`, `wood-carving`), uploaded to the existing `product-images` Storage bucket and cycled across that craft's products. Any folder left empty falls back to a generated placeholder image that says so, so the script runs immediately without real photos and can be re-run once they're added.

**A realistic mix of moderation states, on purpose.** Roughly one in five seeded products is left at `review_status = 'pending'` so the admin moderation queue has something to review; the rest start `approved`. All products are `published` from the start, matching how the app's retrospective moderation actually works.

Requires migration `010-seed-data-flag.sql` to already be applied (adds `is_seed` to `users` and `products`).

## How the features work

**Photo.** `getUserMedia` with the rear camera, falling back to a native file picker if the camera is unavailable or denied. The captured image goes to `/api/images/enhance`, which runs a real `sharp` pipeline: EXIF auto rotation, resize to fit 1600px, contrast normalisation, a slight saturation lift, mild sharpening, and mozjpeg encoding. Auto rotation matters most in practice, since phone photos carry an orientation flag that would otherwise show the product sideways. Enhancement is deliberately deterministic rather than generative, because a marketplace photo has to keep showing the artisan's actual product. The original and the enhanced image are both kept, at their own storage paths, so neither is ever overwritten.

**Enhancement studio.** After the before/after compare screen, the artisan lands on a studio: background removal, brightness, contrast, sharpen, an auto lighting preset, a background treatment (white, soft cream, or blur), and e-commerce crop presets (original, square, portrait). Every control is a preset or a stepped +/- button, never a slider with a number, per the low digital literacy requirement. Toggling brightness, contrast, sharpen, auto lighting, or crop only updates a live CSS-filter preview client side; nothing hits the server until "Use this photo," which bakes the real pixels with `sharp` in `/api/images/finalize`. Background removal is the one control that's a real API call (behind [server/image-ai](server/image-ai)'s swappable provider interface, the same pattern as Groq/Gemini), because it needs actual image understanding, not a filter, so it stays a manual, explicit action rather than firing on page load. `/api/images/finalize` only reads from the caller's own storage folder (checked by [server/lib/ownStorageUrl.ts](server/lib/ownStorageUrl.ts) against the origin and normalised path, not a string prefix, so a `..` cannot walk into another artisan's folder) never an arbitrary URL, since that source string comes from the client.

**Either thumbnail can be tapped to zoom.** The "Original"/"Processed" tiles are small by necessity (they sit side by side), which makes a subtle edit like a light sharpen or a soft-cream background hard to actually see. Tapping either one opens the same content (including the live composite of a background cutout over its blurred/filled backdrop, not a flattened screenshot of it) full screen with `object-fit: contain`, so nothing gets cropped the way `object-fit: cover` does in the small tiles.

Background removal defaults to `BACKGROUND_REMOVAL_PROVIDER=none`, which means the studio's remove-background button reports it as unavailable and the rest of the pipeline is completely unaffected. Set it to `remove-bg` with a key from remove.bg to turn it on. If the provider times out, hits its rate limit, or errors, `enhanceProductImage` catches it, logs the reason server side, and returns the artisan's photo through the ordinary `sharp` pipeline unchanged, with a short notice code the studio turns into a plain sentence. A slow or failed background removal call never blocks the listing and never loses the photo.

**Voice.** `MediaRecorder` produces `audio/webm` on Chrome for Android. Groq accepts that, Gemini does not, so recordings are decoded and re-encoded to 16kHz mono WAV in the browser ([`src/services/audio.ts`](src/services/audio.ts)), which is the one format both accept. That keeps the provider switch a server side concern the frontend never has to know about. The backend independently validates the incoming type against the active provider and rejects an unsupported one with a clear error. The pipeline then transcribes in the original script, translates to English if needed, generates the English description under a strict no-invention prompt, and translates that result into the artisan's chosen language rather than generating it separately. If the mic is unavailable the flow falls back to typing, and either language alone is enough to publish.

**Pricing.** A cost-based, market-anchored formula in [`server/services/pricingEngine.ts`](server/services/pricingEngine.ts), a transparent rule-based calculation, not a trained model. Material cost, plus labour and overhead estimated from the inferred complexity, forms a production cost. A fair artisan margin on top of that sets the minimum fair price. Where a market benchmark exists, its median is blended in (weighted by how many samples back it), but the recommended price is never allowed to drop below the fair floor. Results are rounded to sensible rupee values and scored for recommendation reliability based on market evidence, product identification, and cost estimate confidence. The artisan can always override the suggestion, and the pricing screen shows a full plain-language breakdown (material cost, labour, overhead, margin, category) behind a "see how this was calculated" disclosure.

**Material cost is the one artisan-entered number in the whole formula, so it's the one thing bounded against something else.** [`MATERIAL_COST_REFERENCE_RANGES`](server/services/pricingEngine.ts) is a small, rule-based, explicitly-labelled-as-reference table of typical raw-material cost per category, not verified market data. `assessMaterialCost()` compares the entered cost against it: within roughly 2x the typical range is normal; beyond that the artisan sees a plain-language note (and, if it's more than 3x the typical maximum, the number actually used in the formula is capped there, so a single inflated figure can't drag the suggested price arbitrarily high, though the artisan's own displayed material cost is never silently altered). The existing "scales proportionally with material cost" test in [`pricingEngine.test.ts`](server/services/pricingEngine.test.ts) still passes unchanged for ordinary inputs; new tests cover the capping behaviour directly.

**Pricing overcharge auto-flag.** Every product create and price edit calls `calculateSmartPrice` again server side (never trusting a client-supplied suggestion) and compares the listed price against `overchargeCeiling`, a configurable multiple of the suggested maximum (`PRICING_CONFIG.overchargeThreshold`, currently 30% above it). Artisans keep complete pricing freedom: a high price is never blocked, and this never changes `status` or hides the listing. It only sets `products.auto_flag_reason` to a neutral, factual sentence, e.g. "Priced above typical range for this category. Listed at ₹X; suggested range ₹Y–₹Z." The same sentence is shown to the artisan on the pricing screen before they publish, on their own listing afterward, to the buyer on the product detail page, and to the admin in the moderation queue and the Flagged Listings screen, deliberately avoiding any accusatory language like "overcharging."

**Catalog.** Products load from Postgres newest first. The detail sheet edits price and description in place, and delete asks for confirmation first.

**Offline and install.** A custom install prompt on `beforeinstallprompt`, an offline banner, and a cache-first app shell so cached screens and a hard refresh keep working with no network.

## Contributing

- Branch off `main` and open a pull request. Keep `main` deployable.
- `npm run lint`, `npm run build`, `npm run typecheck:server`, and `npm test` all pass before opening one.
- Test UI changes in English and at least one Indian language. Devanagari and Tamil strings run longer than English and break layouts first, and Urdu flips the layout right to left.
- New user-facing copy goes into `src/context/locales/en.json`, then run `node scripts/build-translations.mjs` to fill in the rest.
- House style: no comments in committed files, and no em dashes anywhere.
- `server/__smoke.test.ts`, `server/__roles.test.ts`, `server/__marketplace.test.ts`, `server/__console.test.ts`, `server/__passport.test.ts`, `server/__pricing_flag.test.ts`, `server/__analytics.test.ts`, `server/__inquiries.test.ts`, and `server/__shipping.test.ts` drive the whole API against a real Supabase project. All nine only run when `.env` has credentials, skip themselves in CI, and clean up everything they create.
- `npm run verify:rls` checks the row level security policies directly against Postgres, independent of the API. It needs `SUPABASE_ANON_KEY` and `SUPABASE_JWT_SECRET` in `.env` on top of the usual credentials.
- After a schema change, run the matching file in `supabase/migrations/` against your Supabase project (SQL Editor) before pulling in code that depends on it. The API and the tests above expect the new columns and policies to already exist.

## Design system

Tokens live in `src/styles/variables.css`. Primary is terracotta `#C1502E`, background is cream `#FBF4EA`. Headings use Martel, body text uses Mukta, both covering Latin and Devanagari. Buttons use `min-height` rather than a fixed height so labels that wrap to two lines in Hindi grow instead of clipping.
