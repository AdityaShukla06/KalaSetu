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

## Getting started

```bash
npm install
cp .env.example .env    # fill in the values, see SETUP.md
npm run dev
```

Then open `http://localhost:5173`.

Full walkthrough for Supabase, Gemini, and deploying to Vercel is in [SETUP.md](SETUP.md). The on-device checklist is in [TESTING.md](TESTING.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type checks and builds to `dist/` |
| `npm run preview` | Serves the production build |
| `npm run lint` | oxlint |
| `npm run typecheck:server` | Type checks `server/` and `api/` |
| `npm test` | vitest |

CI runs all of these on every pull request.

## Project structure

```
src/                 the PWA
  screens/           one folder per screen
    Onboarding/      welcome, email entry, OTP verification
    Home/            My Shop catalog, product detail sheet, GeM/ONDC banner
    AddProduct/      camera, category, voice description, pricing, publish
    Profile/         profile and language
  components/        Button, Card, Input, OtpInput, LanguageToggle, BottomNav
  context/           Auth, Language, AddProductDraft
    locales/         one JSON dictionary per language
  services/          api/ one module per resource, audio.ts (WAV conversion)
  styles/            variables.css (design tokens), global.css

server/              the API, an ordinary Express app
  routes/            one router per resource, all mounted under /api
  middleware/        session verification, raw body reading, async errors
  lib/               supabase client, env schema, JWT, OTP, email
  services/          pricingEngine.ts, imageEnhancer.ts
  voice-ai/          provider-agnostic STT, translation, description pipeline

api/index.ts         Vercel entry point, exports the Express app
shared/languages.ts  the language registry, used by both halves
supabase/
  schema.sql         tables, index, counter function, RLS, storage bucket
  migrations/        run these against a database created before a change
```

## API

Everything is mounted under `/api` and served from the same origin as the PWA, so `VITE_API_BASE_URL` stays empty in production. All routes except health and auth require `Authorization: Bearer <session token>`.

| Method | Route | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ status, version }` |
| POST | `/api/auth/request-otp` | `{ email }` | `{ success, emailDelivered, expiresInMinutes }` |
| POST | `/api/auth/verify-otp` | `{ email, otp }` | `{ token, userId, email }` |
| GET | `/api/users/me` | | `UserProfile` |
| PATCH | `/api/users/me` | `{ displayName?, shopName?, language? }` | `{ success }` |
| POST | `/api/images/enhance` | raw image bytes | `{ enhancedImageUrl, width, height }` |
| POST | `/api/voice/transcribe` | raw audio bytes, `?category=` and `?language=` | `{ transcript, descriptionEn, descriptionLocal, localLanguage, detectedLanguage }` |
| POST | `/api/pricing/suggest` | `{ category, materialCost or rawMaterials, ... }` | range, confidence, market reference, breakdown |
| POST | `/api/products` | `ProductInput` | `{ productId }` |
| GET | `/api/products` | | `Product[]` |
| PATCH | `/api/products/:id` | partial `ProductInput` | `{ success }` |
| DELETE | `/api/products/:id` | | `{ success }` |

Uploads send the file as the raw request body with its real type in an `X-File-Type` header rather than as multipart. Serverless runtimes buffer and consume the request stream before the handler runs, which breaks multipart parsers; reading a raw body works both under a normal Express server and on Vercel.

## Auth

Email OTP, issued by this API rather than a third party. SMS was not viable: sending to Indian numbers requires DLT registration, which takes days and a registered entity.

`request-otp` stores a SHA-256 hash of a 4 digit code with a 10 minute expiry and emails it through Resend. `verify-otp` checks it and returns a JWT that the client sends on every later request. Codes are single use, capped at 5 attempts, and compared with a timing safe comparison. Sessions last 7 days; changing `JWT_SECRET` revokes all of them at once.

Email delivery is optional. Without `RESEND_API_KEY` the app still works through the demo fallback code, which is documented in [SETUP.md](SETUP.md) along with how to turn it off.

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

## Data and ownership

Two tables plus one for OTPs, defined in [`supabase/schema.sql`](supabase/schema.sql). Every product read, update, and delete is scoped by `user_id` in the query itself, so knowing a product ID is not enough to touch someone else's listing. Row level security is enabled on every table with no public policies, so the anon key cannot read anything even if it ends up in the browser bundle. The API uses the service role key server side only.

`users.total_products` is maintained by a Postgres function rather than a read-modify-write, so it cannot drift under concurrent writes.

## How the features work

**Photo.** `getUserMedia` with the rear camera, falling back to a native file picker if the camera is unavailable or denied. The captured image goes to `/api/images/enhance`, which runs a real `sharp` pipeline: EXIF auto rotation, resize to fit 1600px, contrast normalisation, a slight saturation lift, mild sharpening, and mozjpeg encoding. Auto rotation matters most in practice, since phone photos carry an orientation flag that would otherwise show the product sideways. Enhancement is deliberately deterministic rather than generative, because a marketplace photo has to keep showing the artisan's actual product.

**Voice.** `MediaRecorder` produces `audio/webm` on Chrome for Android. Groq accepts that, Gemini does not, so recordings are decoded and re-encoded to 16kHz mono WAV in the browser ([`src/services/audio.ts`](src/services/audio.ts)), which is the one format both accept. That keeps the provider switch a server side concern the frontend never has to know about. The backend independently validates the incoming type against the active provider and rejects an unsupported one with a clear error. The pipeline then transcribes in the original script, translates to English if needed, generates the English description under a strict no-invention prompt, and translates that result into the artisan's chosen language rather than generating it separately. If the mic is unavailable the flow falls back to typing, and either language alone is enough to publish.

**Pricing.** A cost-based, market-anchored formula in [`server/services/pricingEngine.ts`](server/services/pricingEngine.ts). Material cost, plus labour and overhead estimated from the inferred complexity, forms a production cost. A fair artisan margin on top of that sets the minimum fair price. Where a market benchmark exists, its median is blended in (weighted by how many samples back it), but the recommended price is never allowed to drop below the fair floor. Results are rounded to sensible rupee values and scored for recommendation reliability based on market evidence, product identification, and cost estimate confidence. The artisan can always override the suggestion.

**Catalog.** Products load from Postgres newest first. The detail sheet edits price and description in place, and delete asks for confirmation first.

**Offline and install.** A custom install prompt on `beforeinstallprompt`, an offline banner, and a cache-first app shell so cached screens and a hard refresh keep working with no network.

## Contributing

- Branch off `main` and open a pull request. Keep `main` deployable.
- `npm run lint`, `npm run build`, `npm run typecheck:server`, and `npm test` all pass before opening one.
- Test UI changes in English and at least one Indian language. Devanagari and Tamil strings run longer than English and break layouts first, and Urdu flips the layout right to left.
- New user-facing copy goes into `src/context/locales/en.json`, then run `node scripts/build-translations.mjs` to fill in the rest.
- House style: no comments in committed files, and no em dashes anywhere.
- `server/__smoke.test.ts` drives the whole API against a real Supabase project. It only runs when `.env` has credentials, skips itself in CI, and cleans up everything it creates.

## Design system

Tokens live in `src/styles/variables.css`. Primary is terracotta `#C1502E`, background is cream `#FBF4EA`. Headings use Martel, body text uses Mukta, both covering Latin and Devanagari. Buttons use `min-height` rather than a fixed height so labels that wrap to two lines in Hindi grow instead of clipping.
