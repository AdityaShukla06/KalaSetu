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
  screens/       one folder per screen
  components/    shared UI: Button, Card, BottomNav
  services/      api.ts, typed stub functions for the backend contract
  context/       Auth, Language, AddProductDraft state
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
- [ ] Phase 2: Onboarding, phone OTP auth, language toggle
- [ ] Phase 3: Add Product, camera capture and image enhancement
- [ ] Phase 4: Add Product, voice note and description
- [ ] Phase 5: Add Product, pricing and publish
- [ ] Phase 6: My Shop catalog and GeM/ONDC roadmap banner
- [ ] Phase 7: Full navigation and state integration
- [ ] Phase 8: Install prompt, offline handling, Lighthouse polish
- [ ] Phase 9: Deploy to Firebase Hosting, device testing

## Design system

Colors, type, spacing, radius, and component specs live as CSS variables in `src/styles/variables.css`. Primary color is terracotta `#C1502E`, background is cream `#FBF4EA`. Headings use Martel, body and UI text use Mukta, both support Latin and Devanagari.

## API contract

`src/services/api.ts` defines every function the backend needs to implement: `sendOtp`, `verifyOtp`, `enhanceImage`, `transcribeAndDescribe`, `suggestPrice`, `createProduct`, `listProducts`. Each currently returns mock data with a short delay. Swap the implementation for real fetch calls once endpoints exist, nothing else in the app should need to change.
