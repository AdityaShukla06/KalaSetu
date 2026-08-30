# Remaining tasks

Last updated after the backend integration pass (Phase 11).

## Needs your input, nobody can do these for you

These are blocked on an account, a key, or a device. Everything else in this file is code work.

- **Firebase project and credentials.** Nobody has run `firebase login` yet, so nothing is deployed. Follow `FIREBASE_SETUP_HANDOVER.md` end to end: create the project, upgrade to Blaze (Cloud Functions require it), enable Phone Auth, create Firestore and Storage in `asia-south1`, register the web app, then fill in `.env` at the root and `functions/.env`. Both files are gitignored, do not commit them.
- **`GEMINI_API_KEY`.** Get one from [Google AI Studio](https://aistudio.google.com/apikey). Put it in `functions/.env` for the emulator, and run `npx firebase-tools functions:secrets:set GEMINI_API_KEY` for production. The `api` function already declares this secret, so it is injected at runtime once set. Without it, `/api/voice/transcribe` returns 500 and every other route keeps working.
- **Confirm the Gemini model IDs.** `functions/src/voice-ai/config/env.ts` defaults `GEMINI_TRANSCRIBE_MODEL` and `GEMINI_FLASH_MODEL` to `gemini-2.5-flash`. That model is GA and handles audio input, text generation, and structured JSON output, so the pipeline works on it today. The model IDs the backend originally shipped with (`gemini-3.5-transcribe`, `gemini-3.5-flash`) do not exist in the installed `@google/genai` SDK's model list and would have failed at runtime. Check the current Gemini model list against your key and, if a newer or cheaper model suits, set the env vars rather than editing source. Note `gemini-2.5-flash` has a published shutdown date, so this will need revisiting.
- **BHASHINI credentials, optional.** The ULCA adapter is now fully implemented (config call plus compute call), but it has never run against real credentials, so the response shape is verified only against BHASHINI's public docs, not against a live response. Until `BHASHINI_ULCA_USER_ID`, `BHASHINI_ULCA_API_KEY`, and `BHASHINI_PIPELINE_ID` are all set, the factory silently uses Gemini for translation instead, which works fine. If you do set them and the shape is wrong, it fails loudly naming the exact field that did not match, so it is a quick fix rather than a silent wrong answer. Do not set them the day of the demo without testing first.
- **Deploy, then a real Android device test pass.** `TESTING.md` has a 15 item checklist, all still untested. Camera and mic need a secure context, so this cannot be done against a local dev server over plain HTTP. It needs the deployed URL.
- **Write the live URL down** in `TESTING.md` once deployed, and share it with the team.

## Known gaps, not started

- **Image enhancement is a passthrough.** `POST /api/images/enhance` stores and returns the image exactly as uploaded, it does not enhance anything. The frontend's before/after compare is therefore comparing an image with itself. Either wire in a real enhancement step (Gemini image editing, or a sharpen and white balance pass) or drop the compare UI, but do not leave it implying work that is not happening.
- **GeM / ONDC integration.** Deliberately a "coming soon" banner only, per the original scope. Do not build a fake flow behind it, wait for an actual integration decision.
- **Profile is read only.** `getMyProfile` and `updateMyProfile` exist in `src/services/api/users.ts` and the backend routes work, but no screen calls them, so `displayName` and `shopName` can never be set. `phoneNumber` now gets filled in automatically from the verified Firebase token on first `GET /api/users/me`. Wiring an edit form into `/profile` is a small, self contained task.
- **Product titles** are auto derived from the selected category (for example "Pottery") since there is no dedicated title entry step in the flow. Worth revisiting if a real title field turns out to matter for the catalog or for GeM/ONDC listings later.
- **Draft and failed product statuses** exist in the design (status badge colors, `Product.status` type) but nothing in the current flow actually produces a `draft` or `failed` product, every publish either fully succeeds or fully fails with a retry. Only relevant if a "save as draft" or background upload feature gets added later.
- **Tamil speech to text is unverified.** The voice pipeline lists Tamil as supported, but it has never been tested with real Tamil audio. If it turns out the model handles it poorly, a different STT provider can be dropped in behind the existing `SpeechToTextService` interface without touching the pipeline.
- **No frontend tests.** The backend has a vitest suite, the React side has none. Screens are still verified by hand.

## Done in the backend integration pass

Recorded here so nobody re-investigates something already fixed.

- Gemini transcription rewritten onto real SDK surface. The original called `client.interactions.create` with a `transcription_config` field and read `output_text` back, neither of which exists in `@google/genai`, so every transcription request would have failed. It now sends the audio as an `inlineData` part to `models.generateContent` with a JSON response schema, returning transcript and detected language in one call instead of two.
- BHASHINI compute call implemented, replacing the placeholder that threw on every call.
- First publish no longer fails. Creating a product incremented `totalProducts` with a Firestore `update()`, which throws when the user document does not exist yet, and nothing in the app created that document. It now uses `set(..., { merge: true })`.
- Firebase ID tokens are refreshed. The token was stored once at login and never renewed, so every session started returning 401 after one hour. `apiFetch` now asks the SDK for a live token per request, and `AuthContext` subscribes to `onIdTokenChanged`.
- `GEMINI_API_KEY` is declared as a secret on the `api` function, so the documented `functions:secrets:set` step actually reaches the running function.
- Voice AI dependencies are built lazily. They were constructed at module load, so a missing `GEMINI_API_KEY` crashed the entire function on cold start, taking down `/api/health` and every unrelated route with it.
- Async route errors are handled. Express 4 does not catch rejected promises from async handlers, so any Firestore or Storage failure left the request hanging until timeout. Handlers are wrapped and there is a real error middleware, including a 413 for oversized uploads.
- Image uploads no longer depend on bucket ACLs. `makePublic()` throws on buckets with uniform bucket level access enabled. Uploads now use a Firebase download token instead, which works regardless of bucket configuration. Uploads are also restricted to JPEG, PNG, and WebP.
- Edit and Delete on a product are wired up, replacing buttons that only logged to the console.
- Backend test suite added (23 tests: pricing engine, voice pipeline, BHASHINI adapter) plus a CI workflow that runs frontend lint and build and backend build and tests on every pull request.
