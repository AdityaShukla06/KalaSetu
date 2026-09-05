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
- **Price suggestion.** A rule-based, cost-based, market-anchored pricing formula (not a trained model), using material cost plus an estimated labour/overhead cost and any available market benchmark. The artisan can always override the suggested price.
- **Publish.** Instant. A listing is live in the marketplace the moment it's published; there's no waiting on admin approval to go live (moderation is retrospective, not a gate, see the admin section below). Every published product also gets a Craft Heritage Passport (see below), and the success screen links straight to it.
- **My Shop.** A grid of the artisan's own listings with status badges, a detail view to edit price/description or delete a listing (soft, with a confirmation step), and empty/loading/error states.
- **Profile.** Display name, shop name, region (used for buyer-side filtering), and language, with a save confirmation.
- **Language switch.** Changing the interface language also offers to re-translate the artisan's existing listings into the new language.
- **PWA basics.** Install prompt, offline banner, and a cache-first app shell so the app still opens (to cached screens) with no network.

## Buyer features

A separate portal, reachable only by an account with the buyer role, that works as a real website (desktop and mobile browser), not just a mobile app shell.

- **Browse.** A responsive grid of every published, unflagged product, showing image, title, price, artisan name, and region, from 360px phone width up to 1440px desktop.
- **Search and filter.** Free-text search over title and description (in both English and the artisan's language), plus filters for category, material, region, and price range, and sorting by newest or by price. Paginated with a "load more" pattern.
- **Product detail.** Full description (English/local language tabs), price, category and material tags, a live summary of the artisan (shop name, region, how many products they have listed), and a prominent inquiry form.
- **Inquiries.** A buyer can message an artisan about a specific product; the artisan sees it on their side (an existing API endpoint), and the buyer has a running list of everything they've sent, with status.
- **Buyer profile.** Display name, company name, region, language, and the inquiry list above.
- **Loading, empty, and error states everywhere.** Real skeleton loaders (not blank-screen spinners), "no products match these filters" instead of a blank grid, and retry buttons on every failure.

## Craft Heritage Passport

A digital certificate of origin, generated for every product, meant to be the single most shareable screen in the whole app.

- **A human, sequential product ID**, `ART-2026-001892` style: year plus a 6-digit running number, assigned the moment a product is created. Existing products were given IDs matching the year and order they were actually created in.
- **A public certificate page**, `/passport/ART-2026-001892`, viewable by anyone with the link, no login required. It shows the product ID, a scannable QR code to itself, the artisan's name and region, craft type and technique, materials, time taken, creation date, an optional GI/ODOP tag, care instructions, the product's photo, and a short written Product Story, laid out to look like a certificate, not a normal product listing.
- **The Product Story is written by AI (Groq, with Gemini as the fallback) from only what the artisan actually provided**: the description they gave, plus whatever of technique/material/time-taken/GI-tag they filled in. The model is explicitly forbidden from inventing regional history, cultural claims, or heritage details that weren't stated, even when the craft type would typically suggest one, and it's told outright to leave a part out rather than guess at it. It's written once and stored, not regenerated every time someone opens the page. If it fails to generate for any reason, the passport still works, it just shows a plain "not available" line instead of a story, exactly like the rest of this app never lets an AI failure block a listing.
- **No official claim.** The page carries a visible line stating this is a self-declared record made by the artisan, not a government or third-party certification, and the AI prompt itself is separately forbidden from ever implying otherwise.
- **Share and print.** A share button (native share sheet, or copy-link as a fallback) and a print stylesheet that produces a clean, single-page certificate with no buttons or navigation on it.
- **Linked from everywhere the product itself is shown**: the artisan's own listing detail, the buyer-facing product page, and the publish success screen.

## Admin console

A separate, deliberately hidden part of the app for platform oversight, reachable only by an account with the admin role, at a non-obvious URL that is never linked from anywhere in the public app.

- **Access control.** Anyone who isn't an admin, including someone not logged in at all, sees a generic "page not found," identical to visiting a URL that doesn't exist. There is no "access denied" message anywhere, at the page or at the API, which would otherwise confirm the route exists. This is enforced independently at the frontend and at every API endpoint (re-checking the role fresh from the database on every request, never trusting the login session alone), backed by database-level row security as a second, independent layer.
- **Dashboard.** Total artisans, total buyers, total products, products awaiting review, total inquiries, a 30-day signup chart, and a feed of recent admin actions.
- **Artisan management.** A searchable, paginated table of every artisan (name, shop, email, region, product count, active/deactivated status). Opening one shows their full profile and every listing they've ever made, regardless of status. An admin can deactivate an artisan (with a required reason), which blocks that account's next login without touching their existing listings, and can reactivate them just as easily. Nothing is ever hard-deleted.
- **Listing moderation.** A queue of products an admin hasn't reviewed yet. Three actions: approve (marks it reviewed, changes nothing else, since it was already live), reject with a required reason (pulls the listing from the marketplace and returns it to draft, reversibly), or flag with a required reason (pulls the listing from the marketplace immediately). Moderation is retrospective by design: publishing itself stays instant, and the review queue never blocks a new listing from going live.
- **Flagged listings.** A screen reserved for products an automated pricing-overcharge check would flag. That automated check doesn't exist yet (a future piece of work); this screen is built to read the field it will populate and shows "not enabled yet" gracefully in the meantime, rather than an error.
- **Audit log.** Every moderation action and every artisan activation/deactivation is recorded: who did it, what they did, to which record, when, and why. Visible on the dashboard.
- **Demo access.** A seed script creates one admin account directly, so the console can be logged into and shown during judging without going through the normal artisan/buyer signup choice.

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
- Five schema migrations so far: multilingual product fields, the three-role model, buyer marketplace fields (region, material), the admin console (deactivation, review status, audit log), and the Craft Heritage Passport (passport id, technique/time-taken/GI-tag/care-instructions, product story). The first four are live on the project's Supabase database; **the fifth, `supabase/migrations/005-heritage-passport.sql`, has not been run yet** and needs to be applied in the Supabase SQL Editor before product creation or the passport feature will work live.

## Testing

- 231 automated tests (7 of them for the passport feature, currently skipping until migration 005 is applied) run against a real Supabase project, covering login, the full artisan publish flow, role and permission boundaries, the marketplace search and filters, the entire admin console (access control, deactivation, moderation, the audit trail), and the heritage passport (id format, public visibility rules, story stability).
- A separate script checks the row-level security policies directly against Postgres, independent of the API.
- Full lint and type checks pass across both the frontend and the server.

## What is deliberately not built yet

- **Migration 005 has not been run against the live database yet.** `supabase/migrations/005-heritage-passport.sql` adds the passport columns and the passport-number function; until it's run in the Supabase dashboard, product creation itself will fail (it now always assigns a passport id), and the seven passport tests skip themselves rather than fail.
- **The pricing overcharge check** that would auto-flag suspiciously priced listings (Section 6 of the original plan). The admin console's Flagged Listings screen is ready for it but has nothing to show until it exists.
- **Multi-image galleries.** Each product still stores exactly one photo. The buyer-facing product page is built to show a gallery, but there's only ever one image in it today.
- **An artisan-facing "resubmit" flow.** If an admin rejects a listing, it returns to draft with no listing UI on the artisan's side to see why or republish it; that data exists (the review reason is stored) but there's no screen for the artisan to read it yet.
- **Live deployment.** The app has not yet been deployed to a public Vercel URL.
- **On-device testing.** The 20-item mobile checklist in `TESTING.md` (camera, microphone, install, offline) has not been run on a real phone yet; it requires the live deployed URL, since camera and microphone need a secure context.

## To try it yourself right now

- Artisan or buyer: open the app, pick a role on the email screen, sign in with the demo code (see `.env`'s `DEMO_FALLBACK_OTP`).
- Admin: `npm run seed:demo-admin -- you@example.com`, then sign in with that email the same way. You'll land on the hidden console automatically.
