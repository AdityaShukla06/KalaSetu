# KalaSetu, project summary

What this app is, and everything that has been built into it so far. For technical detail (API routes, schema, exact design decisions) see `README.md`; this file is the plain-English "what does it do" version.

## What KalaSetu is

A platform connecting Indian artisans with buyers, built for Smart India Hackathon 2026 (problem statement SIH26090). An artisan photographs and voice-describes a product in their own language, gets a fair price suggestion, and publishes it. Buyers (including larger B2B buyers) browse, search, and send inquiries. An admin oversees both sides: artisan accounts, listing quality, and platform-wide stats.

Three roles share one login: `artisan`, `buyer`, `admin`. Every account picks a role once at signup (artisan or buyer; admin is never self-selectable) and is routed to the matching part of the app after every login.

## Artisan features

The original, most-built-out side of the app. Mobile-first, large tap targets, built for low digital literacy.

- **Email OTP login.** No password. A 4-digit code, or a demo fallback code for offline/no-email situations.
- **Photo capture.** Rear camera via `getUserMedia`, with a native file-picker fallback if the camera is denied or unavailable.
- **Automatic photo enhancement.** Every photo gets EXIF auto-rotation, resizing, contrast normalisation, a slight saturation lift, sharpening, and JPEG compression, done deterministically with `sharp` (not generative, so the photo always shows the real product).
- **Photo enhancement studio.** After the basic enhancement, a dedicated screen offers: AI background removal (one explicit button tap, using a swappable provider, currently remove.bg), brightness and contrast as stepped +/- controls, sharpen and an auto-lighting preset, a background treatment (white, soft cream, or blur) once the background is removed, and e-commerce crop presets (original, square, portrait). Every control is a preset or a step, never a slider with a number. If background removal is slow, rate-limited, or unavailable, the photo pipeline falls back to the plain enhanced photo and the listing is never blocked.
- **Voice-to-listing.** The artisan speaks a description in their own language. It's transcribed, translated if needed, and turned into a product description that never invents details the artisan didn't say. A typed fallback exists if the microphone is unavailable.
- **Category and material.** A picker for product category (textiles, pottery, jewelry, woodwork, bamboo/cane, other) and an optional material tag (cotton, silk, clay, brass, and so on) used later for buyer-side filtering.
- **Price suggestion.** A rule-based, cost-based, market-anchored pricing formula (not a trained model), using material cost plus an estimated labour/overhead cost and any available market benchmark. A "see how this was calculated" disclosure shows the full plain-language breakdown: material cost, labour, overhead, margin, category. The artisan can always override the suggested price.
- **Material cost sanity check.** Material cost is the one number in the whole formula the artisan types in directly, so it's checked against a small reference table of typical cost per category. Enter something far outside that range and you'll see a plain note; enter something wildly high and the number actually used in the calculation is capped, so one inflated figure can't drag the suggested price up without limit. Your displayed material cost is never silently changed, only what feeds the formula.
- **Publish.** Instant. A listing is live in the marketplace the moment it's published; there's no waiting on admin approval to go live (moderation is retrospective, not a gate, see the admin section below). Every published product also gets a Craft Heritage Passport (see below), and the success screen links straight to it. Pricing freedom is complete: any price can be listed. If it's well above the typical range for the category, everyone involved (the artisan before and after publishing, the buyer, and the admin) sees the same neutral, factual note, never an accusation.
- **My Shop.** A grid of the artisan's own listings with status badges, a real view count on every card, a detail view to edit price/description or delete a listing (soft, with a confirmation step), and empty/loading/error states. Links to the analytics dashboard, the inquiry inbox, and the ONDC catalog export (all below) all live here.
- **Profile.** Display name, shop name, region (used for buyer-side filtering), an optional WhatsApp number (turns on the WhatsApp button buyers see on that artisan's listings), an optional pincode (enables the shipping cost estimate on that artisan's listings), and language, with a save confirmation.
- **Approximate weight.** An optional step when publishing: pick a size ("light," "medium," "heavy," "very heavy") or type an exact weight in kg. Only used to estimate shipping cost, never shown to buyers directly.
- **Language switch.** Changing the interface language also offers to re-translate the artisan's existing listings into the new language.
- **PWA basics.** Install prompt, offline banner, and a cache-first app shell so the app still opens (to cached screens) with no network.

## Buyer features

A separate portal, reachable only by an account with the buyer role, that works as a real website (desktop and mobile browser), not just a mobile app shell.

- **Browse.** A responsive grid of every published, unflagged product, showing image, title, price, artisan name, and region, from 360px phone width up to 1440px desktop.
- **Search and filter.** Free-text search over title and description (in both English and the artisan's language), plus filters for category, material, region, and price range, and sorting by newest or by price. Paginated with a "load more" pattern.
- **Product detail.** Full description (English/local language tabs), price, category and material tags, an estimated shipping cost and delivered total once a buyer enters their pincode (see "Shipping cost estimate" below), a live summary of the artisan (shop name, region, how many products they have listed), and a prominent inquiry form.
- **Inquiries.** A buyer can message an artisan about a specific product with a quantity, a free-text message, and how they'd like to be reached (email, phone, or WhatsApp), or skip the form entirely and message the artisan directly on WhatsApp if the artisan has added a number. The buyer has a running list of everything they've sent, with status and whether the artisan has responded.
- **Buyer profile.** Display name, company name, region, language, and the inquiry list above.
- **Loading, empty, and error states everywhere.** Real skeleton loaders (not blank-screen spinners), "no products match these filters" instead of a blank grid, and retry buttons on every failure.

## Buyer-to-artisan inquiries

An async message-plus-handoff flow instead of real-time chat, because that's closer to how this trade actually happens: a quick message or a WhatsApp ping, not a live chat window.

- **The inquiry form** asks a buyer for a quantity, a message, and how they'd like to be contacted back (email, phone, or WhatsApp, with a number required for the last two).
- **A prominent WhatsApp button** sits above that form, not hidden behind it: if the artisan has added a WhatsApp number to their profile, a buyer can tap it and go straight to a WhatsApp chat with the product name and passport ID already filled in, no form required at all.
- **The artisan gets emailed** the moment an inquiry comes in (product name, photo, the buyer's message, quantity, and how to reach them), with a link straight back into the app. If email delivery fails for any reason, the inquiry is never lost, it was already saved before the email was even attempted, and the artisan still sees it in their inbox.
- **An inquiry inbox** on the artisan side lists everything received, marks messages read just by opening the inbox, and has an explicit "Mark as responded" action separate from that, since responding usually happens over WhatsApp or a phone call, not inside the app. A "Reply on WhatsApp" shortcut appears right there when the buyer left a phone number.
- **Buyers see the status too**, including a "responded" indicator on their own sent-inquiries list once the artisan has marked it.

## Shipping cost estimate

A rule-based shipping cost calculator, not a courier integration: no merchant account, no live rate quote, no booking. Just a transparent, honest estimate so prices stop excluding shipping and misleading buyers.

- **How it works.** Real Indian courier rate cards price a shipment by zone (how far it's going) and weight (in 500g steps), then add a fuel surcharge and GST. KalaSetu models that same structure with representative numbers in one clearly labelled, heavily commented file, so it's easy to update and easy to explain.
- **Always a range.** Different couriers charge differently for the same zone and weight by a well-known 15-20%, so the estimate is always shown as a range, never a single suspiciously precise number.
- **Two optional details make it work.** An artisan's approximate product weight, and an artisan's own pincode (both optional, added to the existing profile and listing screens). A buyer types their own destination pincode right on the product page, it's never saved to their account.
- **Shown to both sides.** A buyer sees "Estimated shipping" and an "estimated delivered total" next to the price once they enter their pincode. An artisan sees the same rate card applied to their own product's weight at listing time, broken down across all five zones, so they understand the real landed cost before they publish, not after a buyer complains.
- **Labelled honestly everywhere.** Every place this appears says "estimate," and explicitly says it is not a live quote, a courier booking, or a guaranteed price.

## Craft Heritage Passport

A digital certificate of origin, generated for every product, meant to be the single most shareable screen in the whole app.

- **A human, sequential product ID**, `ART-2026-001892` style: year plus a 6-digit running number, assigned the moment a product is created. Existing products were given IDs matching the year and order they were actually created in.
- **A public certificate page**, `/passport/ART-2026-001892`, viewable by anyone with the link, no login required. It shows the product ID, a scannable QR code to itself, the artisan's name and region, craft type and technique, materials, time taken, creation date, an optional GI/ODOP tag, care instructions, the product's photo, and a short written Product Story, laid out to look like a certificate, not a normal product listing.
- **The Product Story is written by AI (Groq, with Gemini as the fallback) from only what the artisan actually provided**: the description they gave, plus whatever of technique/material/time-taken/GI-tag they filled in. The model is explicitly forbidden from inventing regional history, cultural claims, or heritage details that weren't stated, even when the craft type would typically suggest one, and it's told outright to leave a part out rather than guess at it. It's written once and stored, not regenerated every time someone opens the page. If it fails to generate for any reason, the passport still works, it just shows a plain "not available" line instead of a story, exactly like the rest of this app never lets an AI failure block a listing.
- **No official claim.** The page carries a visible line stating this is a self-declared record made by the artisan, not a government or third-party certification, and the AI prompt itself is separately forbidden from ever implying otherwise.
- **Share and print.** A share button (native share sheet, or copy-link as a fallback) and a print stylesheet that produces a clean, single-page certificate with no buttons or navigation on it.
- **Linked from everywhere the product itself is shown**: the artisan's own listing detail, the buyer-facing product page, and the publish success screen.

## View tracking and artisan analytics

Every artisan gets a real, honest picture of how their listings are actually doing, no invented numbers anywhere.

- **View tracking.** Opening a product detail page as a buyer quietly records a view: which product, that the viewer was a buyer, a coarse region (copied from the buyer's own profile, never their IP or identity), and when. Refreshing the page or clicking back and forth doesn't inflate the count, each product only counts once per browser session.
- **Analytics dashboard**, reachable from My Shop: total views, views in the last week, total inquiries, and how many listings are currently active, as plain number cards. A line chart of views over the last 30 days. A sortable table of every listing with its view count and inquiry count, so an artisan can see at a glance what's working.
- **Honest empty states.** An artisan with no products yet, or products nobody has viewed yet, sees a plain "not enough data yet" message, never a chart or table padded with fake numbers to look impressive.
- **Per-product view counts** also show right on each product card in My Shop, without needing to open the full dashboard.

## ONDC catalog export

A JSON export that maps KalaSetu's product data onto the real ONDC retail catalog structure, verified against the official ONDC protocol specification (not written from memory), so an artisan's listings are engineering-ready to bring onto the ONDC network.

- **What it is, in plain terms.** "Export catalog (ONDC format)" on My Shop downloads every currently published listing, mapped field by field onto ONDC's `Provider`/`Item` catalog objects. "Export this product (ONDC format)" does the same for one listing at a time.
- **What it deliberately is not.** KalaSetu is not registered on the ONDC network, has no subscriber ID, and makes no network calls anywhere in this feature. Nothing in the UI implies otherwise. The exported file says so explicitly. Going live on ONDC is a registration process on ONDC's side from here, not more development on ours, and that is the entire claim this feature makes.
- **Where the field names came from.** Every ONDC field name used (`Item.descriptor`, `Item.price`, `Item.category_id`, `Item.tags`, and so on) was looked up directly from ONDC's own public GitHub specification while building this feature, not recalled from memory. The exact source and the full field-by-field mapping are in `ONDC_CATALOG_MAPPING.md` at the repo root.
- **Gaps are listed, never invented.** Things ONDC expects that KalaSetu doesn't track yet, stock quantity, shipping/fulfillment setup, return and cash-on-delivery policy, a real network provider ID, a full pickup address, are called out by name in the export itself and in the mapping doc, and simply left out rather than filled with a guessed value.
- **GeM is untouched.** The existing "Connect to GeM / ONDC" banner stays exactly as it was, a "coming soon" placeholder; this is a separate, real, additional feature next to it, not a replacement.

## Admin console

A separate, deliberately hidden part of the app for platform oversight, reachable only by an account with the admin role, at a non-obvious URL that is never linked from anywhere in the public app.

- **Access control.** Anyone who isn't an admin, including someone not logged in at all, sees a generic "page not found," identical to visiting a URL that doesn't exist. There is no "access denied" message anywhere, at the page or at the API, which would otherwise confirm the route exists. This is enforced independently at the frontend and at every API endpoint (re-checking the role fresh from the database on every request, never trusting the login session alone), backed by database-level row security as a second, independent layer.
- **Dashboard.** Total artisans, total buyers, total products, products awaiting review, total inquiries, a 30-day signup chart, and a feed of recent admin actions.
- **Artisan management.** A searchable, paginated table of every artisan (name, shop, email, region, product count, active/deactivated status). Opening one shows their full profile and every listing they've ever made, regardless of status. An admin can deactivate an artisan (with a required reason), which blocks that account's next login without touching their existing listings, and can reactivate them just as easily. Nothing is ever hard-deleted.
- **Listing moderation.** A queue of products an admin hasn't reviewed yet. Three actions: approve (marks it reviewed, changes nothing else, since it was already live), reject with a required reason (pulls the listing from the marketplace and returns it to draft, reversibly), or flag with a required reason (pulls the listing from the marketplace immediately). Moderation is retrospective by design: publishing itself stays instant, and the review queue never blocks a new listing from going live. The queue also shows a small "Above typical range" badge next to any listing the pricing engine auto-flagged, so a reviewer sees it without opening the listing.
- **Flagged listings.** A dedicated screen listing every product priced well above the typical range for its category, computed automatically by the pricing engine on every create and price edit. This never hides the listing or blocks anything, it's advisory only; an admin can still choose to reject or flag it manually from here if warranted.
- **Audit log.** Every moderation action and every artisan activation/deactivation is recorded: who did it, what they did, to which record, when, and why. Visible on the dashboard.
- **Demo access.** A seed script creates one admin account directly, so the console can be logged into and shown during judging without going through the normal artisan/buyer signup choice.

## Demo seed data

A script that fills the app with realistic content for judging, so the marketplace, admin console, and analytics dashboard don't look empty during a demo.

- **What it creates.** 14 artisan accounts spread across genuine Indian craft regions (Varanasi's Banarasi silk, Kanchipuram's silk, Bengal's clay figures, Rajasthan's terracotta and block print, Assam's bamboo work, Mizoram's cane weaving, Moradabad's brassware, Bidar's Bidriware, Gujarat's Ajrakh block print, Odisha's silver filigree, Jaipur's silver jewellery, Kashmir's walnut carving, and Channapatna's lacquered toys), about 45 products between them, 5 buyer accounts, a dozen or so buyer inquiries, and 28 days of realistic view history so the analytics chart actually shows a trend instead of a flat line.
- **Correct on purpose, not just plausible.** Every craft is paired with the real region it actually comes from, and a heritage tag (GI tag) is only added where that craft genuinely holds one. Nothing here associates a craft with a place it isn't actually known for.
- **A realistic moderation queue too.** Roughly one in five seeded products is left waiting for admin review, so the moderation queue has something in it, not just an empty state.
- **Clearly marked and easy to remove.** Every row this script creates is flagged internally as demo data, so it can be wiped out completely with one command, without touching any real account or listing.
- **Photos**, ideally real craft photographs the team supplies in a folder per craft type; any craft without photos yet gets an obvious "photo pending" placeholder instead of a broken image, so the demo still runs before all photos are sourced.

## Shared platform features

- **One login for everyone.** Email OTP, a single flow, routing by role after verification. No separate login systems for artisans, buyers, or admins.
- **22 languages.** English plus all 22 languages of the Eighth Schedule of the Constitution, chosen once and applied to every label, the voice pipeline, and product listings. Translation quality is tracked and documented per language; some low-resource languages (Manipuri, Bodo, Santali) are flagged as needing a native speaker review. The admin console is the one part of the app that is English-only by design, since its audience is internal staff, not artisans or buyers.
- **Three-role permission model.** Enforced twice: once in the application code (every query already scoped to the right owner or role) and once in the database itself (Postgres row-level security), so a leaked service key or a future direct-to-database code path would still be constrained by the same rules.
- **No self-promotion, anywhere.** A user can pick artisan or buyer once, at signup. Nobody can make themselves an admin, or change their own role afterward, through any code path in the running app.

## What runs underneath

- Vite + React + TypeScript frontend, plain CSS with design tokens, no UI framework.
- Express API, deployed as a single Vercel serverless function.
- Supabase (Postgres + file storage), with row-level security enabled on every table.
- Groq (Whisper for speech, gpt-oss-120b for text) as the default AI provider, Gemini as a swappable fallback, remove.bg as the swappable background-removal provider.
- Ten schema migrations: nine already live on the project's Supabase database (multilingual product fields, the three-role model, buyer marketplace fields (region, material), the admin console (deactivation, review status, audit log), the Craft Heritage Passport (passport id, technique/time-taken/GI-tag/care-instructions, product story), the pricing overcharge auto-flag (`products.auto_flag_reason`), view tracking (the `product_views` table), inquiry details plus a WhatsApp number (`inquiries.quantity/contact_preference/contact_value/read_at/responded_at/notified_at`, `users.whatsapp_number`), and the shipping estimate (`products.weight_kg`, `users.pincode`)), plus a tenth (an `is_seed` flag on artisans/buyers and products, for the demo seed script above) written but not yet applied.
- The ONDC catalog export needs no new schema at all; it's computed entirely from data already in `products`.

## Testing

- 312 automated tests, all passing against the live Supabase project, covering login, the full artisan publish flow, role and permission boundaries, the marketplace search and filters, the entire admin console (access control, deactivation, moderation, the audit trail), the heritage passport (id format, public visibility rules, story stability), the pricing overcharge flag (capping, neutral wording, pricing freedom preserved), view tracking (recording, per-artisan isolation, honest zeroed summaries), the ONDC catalog mapping (correct field mapping, gaps always reported, cost and moderation data never leaking into an export), the inquiry flow (contact-preference validation, read/responded tracking, per-artisan isolation, the email never losing the record), and the shipping estimate (zone classification, always a range, correct rate-card math).
- A separate script checks the row-level security policies directly against Postgres, independent of the API.
- Full lint and type checks pass across both the frontend and the server, and a production build succeeds.

## What is deliberately not built yet

- **Multi-image galleries.** Each product still stores exactly one photo. The buyer-facing product page is built to show a gallery, but there's only ever one image in it today.
- **An artisan-facing "resubmit" flow.** If an admin rejects a listing, it returns to draft with no listing UI on the artisan's side to see why or republish it; that data exists (the review reason is stored) but there's no screen for the artisan to read it yet.
- **Live deployment.** The app has not yet been deployed to a public Vercel URL.
- **On-device testing.** The 20-item mobile checklist in `TESTING.md` (camera, microphone, install, offline) has not been run on a real phone yet; it requires the live deployed URL, since camera and microphone need a secure context.

## To try it yourself right now

- Artisan or buyer: open the app, pick a role on the email screen, sign in with the demo code (see `.env`'s `DEMO_FALLBACK_OTP`).
- Admin: `npm run seed:demo-admin -- you@example.com`, then sign in with that email the same way. You'll land on the hidden console automatically.
- A populated marketplace for judging: run migration 010 once, then `npm run seed:demo-data`. Remove it later with `npm run seed:demo-data:wipe`.
