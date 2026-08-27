# KalaSetu

A bilingual (English / Hindi) mobile-first PWA that helps artisans photograph, describe, price, and publish their products.

## Stack

- Vite + React + TypeScript
- react-router-dom for routing
- vite-plugin-pwa for the service worker and web app manifest
- Plain CSS with CSS variables for theming, no Tailwind or CSS-in-JS

## Project structure

```
src/
  screens/       one folder per screen (Onboarding, Home, AddProduct, Profile)
    Home/        My Shop catalog grid, product detail sheet, GeM/ONDC banner
    AddProduct/  camera capture, category, voice description, pricing and publish
  components/    shared UI: Button, Card, Input, OtpInput, LanguageToggle, BottomNav
  services/      api.ts, typed stub functions for the backend contract
  context/       Auth, Language (with translations.ts), AddProductDraft state
  styles/        variables.css (design tokens), global.css
public/
  icons/         PWA icons (192x192, 512x512)
```

## Scripts

- `npm run dev` starts the local dev server
- `npm run build` type-checks and builds for production
- `npm run preview` serves the production build locally
- `npm run lint` runs oxlint

## Progress

- [x] Phase 1: PWA scaffold, routing shell (Home, Add Product, Profile), design system tokens, PWA manifest and service worker, typed API stub contract
- [x] Phase 2: Onboarding (Welcome, phone entry, OTP verification), phone OTP auth with localStorage persistence, language toggle with a small translation dictionary
- [x] Phase 3: Add Product, camera capture (live preview, freeze frame, retake), image enhancement with before/after compare, file picker fallback when the camera is unavailable
- [x] Phase 4: Add Product, category selector, voice recording with playback, AI description with editable EN/HI review, text fallback when the mic is unavailable
- [x] Phase 5: Add Product, pricing suggestion with an editable override, publish with retry, draft reset and success confirmation
- [x] Phase 6: My Shop catalog grid, empty state, product detail sheet, GeM/ONDC roadmap banner
- [x] Phase 7: Finalized routing and auth guards, sequential Add Product step guards, real Profile screen, top level error boundary, fetch ready API layer
- [ ] Phase 8: Install prompt, offline handling, Lighthouse polish
- [ ] Phase 9: Deploy to Firebase Hosting, device testing

## Design system

Colors, type, spacing, radius, and component specs live as CSS variables in `src/styles/variables.css`. Primary color is terracotta `#C1502E`, background is cream `#FBF4EA`. Headings use Martel, body and UI text use Mukta, both support Latin and Devanagari.

## API contract

`src/services/api.ts` defines every function the backend needs to implement: `sendOtp`, `verifyOtp`, `enhanceImage`, `transcribeAndDescribe`, `suggestPrice`, `createProduct`, `listProducts`. Every function checks `import.meta.env.VITE_API_BASE_URL` first: if it is set, it makes a real `fetch` call against that base URL, otherwise it falls back to the mock behavior described below. There is no backend yet, so today every environment runs on mocks, copy `.env.example` to `.env` and set `VITE_API_BASE_URL` once real endpoints exist, no code changes needed. Expected request/response shapes for whoever builds the backend:

- `POST /auth/send-otp` `{ phoneNumber }` -> `{ success }`
- `POST /auth/verify-otp` `{ phoneNumber, otp }` -> `{ token, userId }`
- `POST /images/enhance` multipart `image` file -> `{ enhancedImageUrl }`
- `POST /voice/transcribe` multipart `audio` file + `category` field -> `{ transcript, descriptionEn, descriptionHi }`
- `POST /pricing/suggest` `{ category, materialCost, descriptionEn, imageUrl }` -> `{ suggestedMin, suggestedMax, reasoning }`
- `POST /products` a `ProductInput` -> `{ productId }`
- `GET /products?userId=...` -> `Product[]`

All authenticated requests attach `Authorization: Bearer <token>` from the stored auth token automatically.

`verifyOtp` rejects when the OTP is exactly `000000`, so the wrong OTP error state can be demoed without a real backend. Any other 6 digit code succeeds.

## Auth and language

`AuthContext` persists `token`, `userId`, and `phoneNumber` to localStorage, so a logged in session survives a page refresh. `LanguageContext` persists the chosen language and exposes a small `t(key)` translation function backed by `src/context/translations.ts`, extend that dictionary as new screens add copy.

## Routing and guards

- `/login`, `/phone`, `/otp`: the onboarding flow, only reachable when signed out (`RedirectIfAuthed` sends an already authenticated user to `/`)
- `/`, `/profile`: wrapped in `AppLayout`, bottom tab bar visible
- `/add-product/photo`, `/add-product/describe`, `/add-product/price`: the Add Product wizard, no bottom tab bar since it is a focused task, but the draft in `AddProductDraftContext` survives navigating away and back
- Everything except `/login`, `/phone`, `/otp` requires `AuthContext.isAuthenticated`, enforced by `RequireAuth`, which redirects to `/login`

The Add Product steps guard each other in order: `/add-product/describe` redirects to `/add-product/photo` if there is no captured image yet, and `/add-product/price` redirects to `/add-product/photo` or `/add-product/describe` depending on what is missing. Typing a later step's URL directly always bounces back to the right earlier step instead of rendering with missing data.

A class based `ErrorBoundary` wraps the whole app and shows a bilingual "Something went wrong" screen with a reload button instead of a blank page if a render error escapes anywhere in the tree.

## Profile

`/profile` shows the signed in phone number, the same `LanguageToggle` used on the welcome screen, and a "Log out" button that clears `AuthContext` and redirects to `/login`.

## Add Product, photo capture

`/add-product/photo` is an immersive full screen route with no bottom tab bar, since it is the start of a multi step wizard (photo, voice, pricing). It uses `getUserMedia` with the rear camera by default. If the camera throws (permission denied, unsupported browser, no camera), it falls back to a native `<input type="file" accept="image/*" capture="environment">` styled to match the rest of the flow. The camera stream is stopped as soon as the live view unmounts, whether that is a successful capture or leaving the screen entirely.

`enhanceImage` randomly rejects about 30 percent of the time so the retry UI can be exercised without a real backend. The captured blob and the enhanced image URL are stored in `AddProductDraftContext` so the voice and pricing steps can read them later without prop drilling.

## Add Product, voice description

`/add-product/describe` starts with a category grid (single select, stored in the draft), then a `MediaRecorder` based voice recorder: tap to start, tap to stop, a live timer, an animated bar indicator while recording, and native playback with a re-record option before submitting. If `MediaRecorder` or `getUserMedia` is unavailable or the user denies the mic, it skips straight to the manual text entry screen instead of dead ending.

Submitting a recording calls `transcribeAndDescribe`, which also randomly rejects about 30 percent of the time to exercise the retry path. The result lands on an editable review screen with independent English and Hindi tabs (`DescriptionEditor`), labeled "Review and edit if needed" so it is clear the AI text is a draft, not a final answer. "Continue" saves both descriptions into `AddProductDraftContext` and moves on to pricing. The mic stream is released as soon as recording stops, or immediately on unmount if the screen is left mid-recording.

## Add Product, pricing and publish

`/add-product/price` redirects back to an earlier step if the draft is missing an image, category, or description, so it cannot be reached with incomplete state. It shows a read-only recap (photo thumbnail, English description, an "Edit" link back to the description step), a required material cost field, and a "Get price suggestion" button that calls `suggestPrice`. The result shows the suggested range and reasoning plus an editable "Your selling price" field pre-filled with the midpoint, with copy making clear the number is a suggestion the artisan can override.

"Publish" calls `createProduct` with the assembled product, deriving `titleEn`/`titleHi` from the selected category since this flow has no separate title step. `suggestPrice` and `createProduct` both randomly reject about 30 percent of the time so their retry paths are exercisable, and a failed publish keeps all filled in form data intact. On success the screen shows a confirmation with "Your product is live!", clears `AddProductDraftContext` so the next "Add Product" starts fresh, and "View in My Shop" returns to the Home tab.

## My Shop catalog

`listProducts` and `createProduct` now share a small in-memory array in `api.ts`, so the stub behaves like a real backend would: a fresh session has zero products (the empty state is not a special test mode, it is just what a new account looks like), and publishing a product through the Add Product flow makes it actually appear in the grid. `listProducts` also randomly rejects about 30 percent of the time to exercise the error and retry state.

Home shows a dashed, muted "Connect to GeM / ONDC, Coming soon" banner above the catalog, deliberately styled unlike the primary action buttons so it reads as a roadmap item, not a working feature. Tapping it reveals a plain "coming soon" note, there is no fake flow behind it. Products render as a 2 column grid with a status badge (published, draft, failed) using the design system's success/warning/error colors. Tapping a card opens a bottom sheet with the full image, an English/Hindi description toggle, category, and placeholder Edit/Delete buttons that log to the console for now.
