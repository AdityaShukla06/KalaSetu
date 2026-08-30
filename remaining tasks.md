# Remaining tasks

Last updated after the backend integration pass (Phase 11).

## Needs your input, nobody can do these for you

These are blocked on an account, a key, or a device. Everything else in this file is code work.

- **Firebase project and credentials.** Nobody has run `firebase login` yet, so nothing is deployed. Follow `FIREBASE_SETUP_HANDOVER.md` end to end: create the project, upgrade to Blaze (Cloud Functions require it), enable Phone Auth, create Firestore and Storage in `asia-south1`, register the web app, then fill in `.env` at the root and `functions/.env`. Both files are gitignored, do not commit them.
- **`GEMINI_API_KEY`.** Get one from [Google AI Studio](https://aistudio.google.com/apikey). Put it in `functions/.env` for the emulator, and run `npx firebase-tools functions:secrets:set GEMINI_API_KEY` for production. The `api` function already declares this secret, so it is injected at runtime once set. Without it, `/api/voice/transcribe` returns 500 and every other route keeps working.
- **Confirm the Gemini model IDs.** `functions/src/voice-ai/config/env.ts` defaults `GEMINI_TRANSCRIBE_MODEL` and `GEMINI_FLASH_MODEL` to `gemini-2.5-flash`. That model is GA and handles audio input, text generation, and structured JSON output, so the pipeline works on it today. The model IDs the backend originally shipped with (`gemini-3.5-transcribe`, `gemini-3.5-flash`) do not exist in the installed `@google/genai` SDK's model list and would have failed at runtime. Check the current Gemini model list against your key and, if a newer or cheaper model suits, set the env vars rather than editing source. Note `gemini-2.5-flash` has a published shutdown date, so this will need revisiting.
- **BHASHINI credentials, optional.** The ULCA adapter is now fully implemented (config call plus compute call), but it has never run against real credentials, so the response shape is verified only against BHASHINI's public docs, not against a live response. Until `BHASHINI_ULCA_USER_ID`, `BHASHINI_ULCA_API_KEY`, and `BHASHINI_PIPELINE_ID` are all set, the factory silently uses Gemini for translation instead, which works fine. If you do set them and the shape is wrong, it fails loudly naming the exact field that did not match, so it is a quick fix rather than a silent wrong answer. Do not set them the day of the demo without testing first.
- **Deploy, then a real Android device test pass.** `TESTING.md` has a 20 item checklist, all still untested. Item 18, a real voice transcription from a real recording, is the single highest risk check in the project. Camera and mic need a secure context, so this cannot be done against a local dev server over plain HTTP. It needs the deployed URL.
- **Write the live URL down** in `TESTING.md` once deployed, and share it with the team.

## Known gaps, not started

- **GeM / ONDC integration.** Deliberately a "coming soon" banner only, per the original scope. Do not build a fake flow behind it, wait for an actual integration decision.
- **Product titles** are auto derived from the selected category (for example "Pottery") since there is no dedicated title entry step in the flow. Worth revisiting if a real title field turns out to matter for the catalog or for GeM/ONDC listings later.
- **Draft and failed product statuses** exist in the design (status badge colors, `Product.status` type) but nothing in the current flow actually produces a `draft` or `failed` product, every publish either fully succeeds or fully fails with a retry. Only relevant if a "save as draft" or background upload feature gets added later.
- **Tamil speech to text is unverified.** The voice pipeline lists Tamil as supported, but it has never been tested with real Tamil audio. If it turns out the model handles it poorly, a different STT provider can be dropped in behind the existing `SpeechToTextService` interface without touching the pipeline.
- **No frontend tests.** The backend has a vitest suite, the React side has none. Screens are still verified by hand.
- **Enhancement is deterministic, not generative.** `POST /api/images/enhance` now does a real pass with sharp: EXIF auto rotation, resize to fit 1600px, contrast normalisation, a slight saturation lift, mild sharpening, and mozjpeg encoding. It deliberately does not use generative image editing, because a marketplace photo has to keep showing the artisan's actual product, and the same no-invention rule that governs the description prompt applies at least as strongly to the picture. If a stronger effect is ever wanted, that is a product decision, not a bug.
- **`sharp` is a native dependency.** It builds per platform, so the binary that works locally is not the one that runs in the cloud. Firebase installs dependencies during deploy, so this resolves itself, and CI installs it on Linux on every pull request, which is the check that would catch a break. Worth knowing if a deploy ever fails during the install step.

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
- Backend test suite added (36 tests: pricing engine, voice pipeline, BHASHINI adapter, image enhancer, audio format handling) plus a CI workflow that runs frontend lint and build and backend build and tests on every pull request.

## Done in the second pass

- Voice recordings are converted to WAV in the browser before upload. MediaRecorder produces `audio/webm` on Chrome for Android, which is the target device, and webm is not an audio format the model accepts, so transcription would have failed on every real recording even with the STT rewrite in place. The backend also normalises and validates the incoming audio type, rejecting an unsupported one with a clear message instead of a provider error.
- Image enhancement is real work now, not a passthrough. See the note above for what it does and what it deliberately does not do.
- The description fallback no longer dead ends. Someone who denies the microphone and types only Hindi was bounced back to the description step forever, because the pricing step required English specifically. Publishing with one language empty also failed validation with an unhelpful error. Either language now satisfies the guard, and a missing side is filled from the other at publish time.
- Material cost is revalidated at publish. Clearing the field after getting a price suggestion sent a zero and failed validation server side.
- Firestore timestamps are serialised to ISO strings. `createdAt` was typed as a string on the frontend but arrived as a Firestore timestamp object, so anything that tried to render or sort by it would have misbehaved.
- The profile screen reads and writes the profile, so `displayName` and `shopName` can actually be set. `phoneNumber` is filled from the verified token.
- Removed a leftover `console.info` from the description step.
