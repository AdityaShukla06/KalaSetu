# Remaining tasks

## Blocking the demo

- **Deploy to Firebase Hosting.** Config is ready (`firebase.json`, `DEPLOY.md`, `npm run deploy`), but nobody has run `firebase login` on a machine yet, so nothing is actually live. See `DEPLOY.md`.
- **Real Android device test pass.** `TESTING.md` has a 13 item checklist (OTP login, language persistence, camera + file picker fallback, voice recording + text fallback, price suggestion + override, publish to catalog, Add to Home Screen and standalone mode, offline banner, full flow timed under 2 minutes). All still marked "Not yet tested". Needs the live URL from the item above, camera and mic require a secure context so this cannot be done against localhost.
- **Write the live URL down** once deployed, in `TESTING.md` and anywhere else the team checks before the demo.

## Backend integration

- `src/services/api.ts` currently runs entirely on mocks. Every function already checks `VITE_API_BASE_URL` and will switch to real `fetch` calls with zero code changes once that variable is set, see the request/response shapes documented as `TODO` comments above each function and in the README's API contract section.
- Whoever builds the backend should implement the 7 endpoints listed there: `/auth/send-otp`, `/auth/verify-otp`, `/images/enhance`, `/voice/transcribe`, `/pricing/suggest`, `/products` (POST and GET).
- Until then, `createProduct`/`listProducts` share an in-memory array in the browser tab, so published products do not persist across a real page reload or across devices, that is expected and will resolve itself once a real backend is wired in.

## Known gaps, not started

- **Edit and Delete on a product.** The buttons exist in the product detail sheet and currently just log to the console, no update or delete API call is wired up.
- **GeM / ONDC integration.** Deliberately a "coming soon" banner only, per the original scope, do not build a fake flow behind it, wait for an actual integration decision.
- **Product titles** are auto derived from the selected category (for example "Pottery") since there is no dedicated title entry step in the flow. Worth revisiting if a real title field turns out to matter for the catalog or for GeM/ONDC listings later.
- **Draft and failed product statuses** exist in the design (status badge colors, `Product.status` type) but nothing in the current flow actually produces a `draft` or `failed` product, every publish either fully succeeds or fully fails with a retry. Only relevant if a "save as draft" or background-upload feature gets added later.

## Nice to have, not required

- Automated tests. Everything so far has been verified by hand through real browser sessions during development, there is no test suite yet.
- A CI check that runs `npm run build` and `npm run lint` on every pull request, would catch regressions before merge instead of relying on the checklist in `contribution.md`.
