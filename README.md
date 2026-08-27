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
- [ ] Phase 6: My Shop catalog and GeM/ONDC roadmap banner
- [ ] Phase 7: Full navigation and state integration
- [ ] Phase 8: Install prompt, offline handling, Lighthouse polish
- [ ] Phase 9: Deploy to Firebase Hosting, device testing

## Design system

Colors, type, spacing, radius, and component specs live as CSS variables in `src/styles/variables.css`. Primary color is terracotta `#C1502E`, background is cream `#FBF4EA`. Headings use Martel, body and UI text use Mukta, both support Latin and Devanagari.

## API contract

`src/services/api.ts` defines every function the backend needs to implement: `sendOtp`, `verifyOtp`, `enhanceImage`, `transcribeAndDescribe`, `suggestPrice`, `createProduct`, `listProducts`. Each currently returns mock data with a short delay. Swap the implementation for real fetch calls once endpoints exist, nothing else in the app should need to change.

`verifyOtp` rejects when the OTP is exactly `000000`, so the wrong OTP error state can be demoed without a real backend. Any other 6 digit code succeeds.

## Auth and language

`AuthContext` persists `token` and `userId` to localStorage, so a logged in session survives a page refresh. `LanguageContext` persists the chosen language and exposes a small `t(key)` translation function backed by `src/context/translations.ts`, extend that dictionary as new screens add copy.

## Add Product, photo capture

`/add-product` is an immersive full screen route with no bottom tab bar, since it is the start of a multi step wizard (photo, voice, pricing). It uses `getUserMedia` with the rear camera by default. If the camera throws (permission denied, unsupported browser, no camera), it falls back to a native `<input type="file" accept="image/*" capture="environment">` styled to match the rest of the flow. The camera stream is stopped as soon as the live view unmounts, whether that is a successful capture or leaving the screen entirely.

`enhanceImage` randomly rejects about 30 percent of the time so the retry UI can be exercised without a real backend. The captured blob and the enhanced image URL are stored in `AddProductDraftContext` so the voice and pricing steps can read them later without prop drilling.

## Add Product, voice description

`/add-product/describe` starts with a category grid (single select, stored in the draft), then a `MediaRecorder` based voice recorder: tap to start, tap to stop, a live timer, an animated bar indicator while recording, and native playback with a re-record option before submitting. If `MediaRecorder` or `getUserMedia` is unavailable or the user denies the mic, it skips straight to the manual text entry screen instead of dead ending.

Submitting a recording calls `transcribeAndDescribe`, which also randomly rejects about 30 percent of the time to exercise the retry path. The result lands on an editable review screen with independent English and Hindi tabs (`DescriptionEditor`), labeled "Review and edit if needed" so it is clear the AI text is a draft, not a final answer. "Continue" saves both descriptions into `AddProductDraftContext` and moves on to pricing. The mic stream is released as soon as recording stops, or immediately on unmount if the screen is left mid-recording.

## Add Product, pricing and publish

`/add-product/price` redirects back to `/add-product` if the draft is missing an image, category, or description, so it cannot be reached with incomplete state. It shows a read-only recap (photo thumbnail, English description, an "Edit" link back to the description step), a required material cost field, and a "Get price suggestion" button that calls `suggestPrice`. The result shows the suggested range and reasoning plus an editable "Your selling price" field pre-filled with the midpoint, with copy making clear the number is a suggestion the artisan can override.

"Publish" calls `createProduct` with the assembled product, deriving `titleEn`/`titleHi` from the selected category since this flow has no separate title step. `suggestPrice` and `createProduct` both randomly reject about 30 percent of the time so their retry paths are exercisable, and a failed publish keeps all filled in form data intact. On success the screen shows a confirmation with "Your product is live!", clears `AddProductDraftContext` so the next "Add Product" starts fresh, and "View in My Shop" returns to the Home tab.
