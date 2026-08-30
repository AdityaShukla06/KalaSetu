# KalaSetu

A bilingual (English / Hindi) mobile-first PWA that helps artisans photograph, describe, price, and publish their products.

## Stack

- Vite + React + TypeScript
- react-router-dom for routing
- vite-plugin-pwa for the service worker and web app manifest
- Plain CSS with CSS variables for theming, no Tailwind or CSS-in-JS
- Firebase Cloud Functions (v2) + Express for the backend API, Firestore for data, Cloud Storage for images
- Firebase Phone Auth for login, Gemini for voice transcription, translation, and description generation

## Project structure

```
src/
  screens/       one folder per screen (Onboarding, Home, AddProduct, Profile)
    Home/        My Shop catalog grid, product detail sheet, GeM/ONDC banner
    AddProduct/  camera capture, category, voice description, pricing and publish
  components/    shared UI: Button, Card, Input, OtpInput, LanguageToggle, BottomNav
  services/      firebase.ts, api.ts barrel, api/ one module per resource
  context/       Auth, Language (with translations.ts), AddProductDraft state
  styles/        variables.css (design tokens), global.css
public/
  icons/         PWA icons (192x192, 512x512, 512x512 maskable)
functions/
  src/
    routes/      one Express router per resource, all mounted under /api
    middleware/  Firebase token verification, async route error forwarding
    services/    pricingEngine.ts, the SIH26090 smart pricing formula
    voice-ai/    provider-agnostic STT, translation, and description pipeline
```

## Scripts

Frontend, from the repo root:

- `npm run dev` starts the local dev server
- `npm run build` type-checks and builds for production
- `npm run preview` serves the production build locally
- `npm run lint` runs oxlint

Backend, from `functions/`:

- `npm run build` compiles TypeScript to `lib/`
- `npm test` runs the vitest suite (pricing engine, voice pipeline, BHASHINI adapter)
- `npm run serve` builds and starts the functions emulator

Both are run on every pull request by `.github/workflows/ci.yml`.

## Progress

- [x] Phase 1: PWA scaffold, routing shell (Home, Add Product, Profile), design system tokens, PWA manifest and service worker, typed API stub contract
- [x] Phase 2: Onboarding (Welcome, phone entry, OTP verification), phone OTP auth with localStorage persistence, language toggle with a small translation dictionary
- [x] Phase 3: Add Product, camera capture (live preview, freeze frame, retake), image enhancement with before/after compare, file picker fallback when the camera is unavailable
- [x] Phase 4: Add Product, category selector, voice recording with playback, AI description with editable EN/HI review, text fallback when the mic is unavailable
- [x] Phase 5: Add Product, pricing suggestion with an editable override, publish with retry, draft reset and success confirmation
- [x] Phase 6: My Shop catalog grid, empty state, product detail sheet, GeM/ONDC roadmap banner
- [x] Phase 7: Finalized routing and auth guards, sequential Add Product step guards, real Profile screen, top level error boundary, fetch ready API layer
- [x] Phase 8: Real icon set, custom install prompt, offline banner and offline app shell, visual polish pass
- [~] Phase 9: Firebase Hosting config and deploy script ready (`firebase.json`, `DEPLOY.md`), actual deploy and Android device test pass deferred, see `TESTING.md`
- [x] Phase 10: Real backend, Firebase Functions API (users, products, images, voice, pricing), Firestore and Storage rules, smart pricing engine, Gemini voice pipeline, real Phone Auth, frontend wired off mocks onto real endpoints
- [x] Phase 11: Backend integration fixes (working Gemini transcription, BHASHINI compute call, ID token refresh, first-publish crash), Edit and Delete wired up, backend test suite and CI
- [x] Phase 12: Real image enhancement, browser side WAV conversion so voice works on Android, description fallback fixes, editable profile, timestamp serialisation

## Deploy

See `DEPLOY.md` for the one time Firebase setup and `npm run deploy`. See `TESTING.md` for the on-device test checklist and the live URL once deployed.

## Design system

Colors, type, spacing, radius, and component specs live as CSS variables in `src/styles/variables.css`. Primary color is terracotta `#C1502E`, background is cream `#FBF4EA`. Headings use Martel, body and UI text use Mukta, both support Latin and Devanagari.

## API contract

The mock layer is gone. `src/services/api/` now calls the real backend, one module per resource, re-exported through `src/services/api.ts`. Set `VITE_API_BASE_URL` in `.env`: use `/api` in production (Hosting rewrites `/api/**` to the `api` function), or the emulator's function URL locally. See `FIREBASE_SETUP_HANDOVER.md`.

Every route below is mounted under `/api` and, except for health, requires `Authorization: Bearer <Firebase ID token>`:

- `GET /api/health` -> `{ status, version }`, unauthenticated
- `GET /api/users/me` -> `UserProfile`, creates the profile on first call
- `PATCH /api/users/me` `{ displayName?, shopName?, phoneNumber?, language? }` -> `{ success }`
- `POST /api/images/upload` multipart `image` -> `{ imageUrl }`
- `POST /api/images/enhance` multipart `image` -> `{ enhancedImageUrl }`
- `POST /api/voice/transcribe` multipart `audio` + `category` -> `{ transcript, descriptionEn, descriptionHi, detectedLanguage }`
- `POST /api/pricing/suggest` `{ category, materialCost | rawMaterials, ... }` -> suggested range, confidence, market reference, breakdown
- `POST /api/products` a `ProductInput` -> `{ productId }`
- `GET /api/products` -> `Product[]` for the signed in user
- `PATCH /api/products/:id` a partial `ProductInput` -> `{ success }`
- `DELETE /api/products/:id` -> `{ success }`

Auth is Firebase Phone Auth, not a custom OTP endpoint: `sendOtp` calls `signInWithPhoneNumber` with an invisible reCAPTCHA, and `verifyOtp` exchanges the code for a Firebase ID token. `apiFetch` asks the Firebase SDK for the current ID token on every request, so tokens that expire (they last one hour) are refreshed transparently rather than leaving the session silently 401ing.

Products are owned: every read, update, and delete checks `userId` against the caller both in the route and again in `firestore.rules`, so a stolen product ID is not enough to touch someone else's listing.

## Auth and language

`AuthContext` persists `token`, `userId`, and `phoneNumber` to localStorage, so a logged in session survives a page refresh, and subscribes to `onIdTokenChanged` so a refreshed Firebase ID token is written back to storage and a sign out elsewhere clears the session. `LanguageContext` persists the chosen language and exposes a small `t(key)` translation function backed by `src/context/translations.ts`, extend that dictionary as new screens add copy.

## Routing and guards

- `/login`: the entire onboarding flow (welcome and language, phone entry, OTP verification) lives in one route, `LoginScreen` switches between three sub-components by local state, only the URL changes when login actually succeeds and the app navigates to `/`. Only reachable when signed out (`RedirectIfAuthed` sends an already authenticated user to `/`)
- `/`, `/profile`: wrapped in `AppLayout`, bottom tab bar visible
- `/add-product/photo`, `/add-product/describe`, `/add-product/price`: the Add Product wizard, no bottom tab bar since it is a focused task, but the draft in `AddProductDraftContext` survives navigating away and back
- Everything except `/login` requires `AuthContext.isAuthenticated`, enforced by `RequireAuth`, which redirects to `/login`

The Add Product steps guard each other in order: `/add-product/describe` redirects to `/add-product/photo` if there is no captured image yet, and `/add-product/price` redirects to `/add-product/photo` or `/add-product/describe` depending on what is missing. Typing a later step's URL directly always bounces back to the right earlier step instead of rendering with missing data.

A class based `ErrorBoundary` wraps the whole app and shows a bilingual "Something went wrong" screen with a reload button instead of a blank page if a render error escapes anywhere in the tree.

## Profile

`/profile` loads the artisan's profile from `GET /api/users/me`, which creates it on first call, and shows the phone number (filled in from the verified Firebase token, so it is correct even though the client never sends it). "Your name" and "Shop name" are editable and save through `PATCH /api/users/me`, with the save button disabled until something actually changes. The screen also carries the same `LanguageToggle` used on the welcome screen and a "Log out" button that clears `AuthContext`, signs out of Firebase, and redirects to `/login`.

## Add Product, photo capture

`/add-product/photo` is an immersive full screen route with no bottom tab bar, since it is the start of a multi step wizard (photo, voice, pricing). It uses `getUserMedia` with the rear camera by default. If the camera throws (permission denied, unsupported browser, no camera), it falls back to a native `<input type="file" accept="image/*" capture="environment">` styled to match the rest of the flow. The camera stream is stopped as soon as the live view unmounts, whether that is a successful capture or leaving the screen entirely.

`enhanceImage` runs the photo through a real sharp pipeline on the backend (EXIF auto rotation, resize to fit 1600px, contrast normalisation, a slight saturation lift, mild sharpening, mozjpeg encoding), stores it in Cloud Storage under `products/<userId>/enhanced/`, and returns a tokenized download URL. The auto rotation matters most in practice, phone photos routinely carry an EXIF orientation flag that would otherwise show the product sideways. Enhancement is deliberately deterministic rather than generative, a marketplace photo has to keep showing the artisan's actual product. The captured blob and the enhanced image URL are stored in `AddProductDraftContext` so the voice and pricing steps can read them later without prop drilling.

## Add Product, voice description

`/add-product/describe` starts with a category grid (single select, stored in the draft), then a `MediaRecorder` based voice recorder: tap to start, tap to stop, a live timer, an animated bar indicator while recording, and native playback with a re-record option before submitting. If `MediaRecorder` or `getUserMedia` is unavailable or the user denies the mic, it skips straight to the manual text entry screen instead of dead ending.

Recordings are converted to 16kHz mono WAV in the browser before upload (`src/services/audio.ts`). MediaRecorder produces `audio/webm` on Chrome for Android, which the transcription model does not accept, so this conversion is what makes voice work on the target device at all. If decoding fails the original blob is sent unchanged, and the backend then rejects an unsupported format with a clear error rather than a raw provider failure.

Submitting a recording calls `transcribeAndDescribe`, which runs the backend voice pipeline: Gemini transcribes the audio in its original script and reports the spoken language, a regional transcript is translated to English, Gemini writes the English product description under a strict no-invention prompt, and that description is translated to Hindi rather than generated separately. The result lands on an editable review screen with independent English and Hindi tabs (`DescriptionEditor`), labeled "Review and edit if needed" so it is clear the AI text is a draft, not a final answer. "Continue" saves both descriptions into `AddProductDraftContext` and moves on to pricing. The mic stream is released as soon as recording stops, or immediately on unmount if the screen is left mid-recording.

## Add Product, pricing and publish

`/add-product/price` redirects back to an earlier step if the draft is missing an image, category, or description, so it cannot be reached with incomplete state. It shows a read-only recap (photo thumbnail, description in the current app language, an "Edit" link back to the description step), a required material cost field, and a "Get price suggestion" button that calls `suggestPrice`. The result shows the suggested range and reasoning plus an editable "Your selling price" field pre-filled with the midpoint, with copy making clear the number is a suggestion the artisan can override.

"Publish" calls `createProduct` with the assembled product, deriving `titleEn`/`titleHi` from the selected category since this flow has no separate title step. A failed publish keeps all filled in form data intact. On success the screen shows a confirmation with "Your product is live!", clears `AddProductDraftContext` so the next "Add Product" starts fresh, and "View in My Shop" returns to the Home tab.

## My Shop catalog

`listProducts` reads the signed in artisan's products from Firestore, ordered newest first, so a published product survives a reload and follows the account across devices. A fresh account has zero products, the empty state is just what a new account looks like.

Home shows a dashed, muted "Connect to GeM / ONDC, Coming soon" banner above the catalog, deliberately styled unlike the primary action buttons so it reads as a roadmap item, not a working feature. Tapping it reveals a plain "coming soon" note, there is no fake flow behind it. Products render as a 2 column grid with a status badge (published, draft, failed) using the design system's success/warning/error colors. Tapping a card opens a bottom sheet with the full image, an English/Hindi description toggle, and category. "Edit" turns the price and the currently selected description language into editable fields and saves through `PATCH /api/products/:id`. "Delete" asks for confirmation first, then removes the product and refreshes the grid. Both keep the sheet open and show an inline error if the request fails.

## Installability, install prompt, and offline

The app icon is a simple geometric mark, a dot ("Kala", art) above an arch ("Setu", bridge), in warm white on terracotta, generated at `public/icons/icon-192.png`, `icon-512.png`, and a `icon-512-maskable.png` with extra safe zone padding for masked home screen shapes.

`npx lighthouse` no longer scores a standalone "PWA" category as of Lighthouse v11+, Google moved installability checks into Chrome DevTools directly. The equivalent, more authoritative check is Chrome's own `Page.getInstallabilityErrors` (what actually powers "Add to Home Screen"), verified directly via the Chrome DevTools Protocol against the production build: zero installability errors, valid manifest (name, icons at 192/512/maskable, `start_url`, `display: standalone`, `theme_color`, `background_color`), an active service worker, and matching `theme-color` and `viewport` meta tags.

`InstallPrompt` listens for `beforeinstallprompt`, stores the event, and shows a dismissible banner ("Install KalaSetu for quick access") instead of relying on the browser's own install UI. Dismissing it is remembered in localStorage. `OfflineBanner` listens for `online`/`offline` and shows a persistent "You're offline, some features may not work" banner while offline. Both banners sit in normal document flow (not a fixed overlay) so they push page content down instead of covering it. The existing `CacheFirst` app shell strategy from `vite-plugin-pwa` means navigation and cached screens keep working, and a page reload succeeds, even with no network connection at all.

Buttons use `min-height` rather than a fixed `height` so a button whose label wraps to two lines (routine for the longer Hindi strings) grows instead of clipping, and its sibling in the same row stretches to match via the flex container's default `align-items: stretch`, keeping button rows the same height in both languages.
