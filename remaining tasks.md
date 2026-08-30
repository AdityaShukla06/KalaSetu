# Remaining tasks

Last updated after the Supabase and Vercel migration (Phase 13).

Firebase and BHASHINI are both gone. The stack is now Vercel (PWA plus the Express API as a serverless function) and Supabase (Postgres plus Storage), with email OTP sign in. Neither service needs a credit card.

## Needs your input, nobody can do these for you

Everything here is an account or a key. Full walkthrough in `SETUP.md`, roughly 45 minutes.

- **Supabase project.** Create it, pick the Mumbai (`ap-south-1`) region, then run `supabase/schema.sql` once in the SQL editor. Copy the project URL and the `service_role` key into `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The service role key bypasses row level security, so it is server side only and must never be committed or shipped to the browser.
- **`GEMINI_API_KEY`.** From [Google AI Studio](https://aistudio.google.com/apikey). Powers transcription, translation, and description generation. Without it only the voice step fails.
- **`JWT_SECRET`.** Any long random string, `openssl rand -base64 32`. Changing it later signs everybody out, which is the intended way to revoke all sessions.
- **Vercel project.** Import the repo from GitHub, add the environment variables above, deploy. `vercel.json` already carries the build and routing config, so do not change the detected build settings.
- **`RESEND_API_KEY`, optional.** Only needed if you want sign in codes actually emailed. Without it the app still works through the demo fallback code below.
- **Confirm the Gemini model IDs.** `GEMINI_TRANSCRIBE_MODEL` and `GEMINI_FLASH_MODEL` both default to `gemini-2.5-flash`, which is GA and handles audio, text, and structured output. Check it against your key, and note it has a published shutdown date. Override with env vars rather than editing source.
- **Device test pass.** `TESTING.md` has 20 items, all still untested, and it needs the deployed HTTPS URL because the camera and microphone will not work over plain HTTP. Item 18, a real voice recording, is the highest risk check in the project: it is the first time the WAV conversion, the Gemini call, and your API key run together.
- **Write the live URL down** in `TESTING.md` once deployed.

## Turn this off before real users

- **The demo fallback OTP.** `5741` signs in as whatever email address is typed. It exists so a demo cannot be derailed by email delivery, and it is a complete authentication bypass. Fine for a prototype and a judged demo, not fine for real artisans' data. Set `DEMO_FALLBACK_OTP_ENABLED=false` in Vercel and redeploy, no code change needed. Every use is logged as a `SECURITY` warning in the Vercel function logs.

## Known gaps, not started

- **GeM / ONDC integration.** Deliberately a "coming soon" banner only, per the original scope. Do not build a fake flow behind it, wait for an actual integration decision.
- **Product titles** are auto derived from the selected category (for example "Pottery") since there is no dedicated title entry step in the flow. Worth revisiting if a real title field turns out to matter for the catalog or for GeM/ONDC listings later.
- **Draft and failed product statuses** exist in the design (status badge colors, `status` column) but nothing in the current flow produces a `draft` or `failed` product. Only relevant if a "save as draft" or background upload feature gets added later.
- **Tamil speech to text is unverified.** The voice pipeline lists Tamil as supported, but it has never been tested with real Tamil audio. If the model handles it poorly, a different provider can be dropped in behind the existing `SpeechToTextService` interface without touching the pipeline.
- **No frontend tests.** The server has a vitest suite, the React side has none. Screens are still verified by hand.
- **No OTP rate limiting per email.** A caller can request unlimited codes for an address. Attempts on a given code are capped at 5, so this is a nuisance and an email cost issue rather than a way in. Worth adding if this ever leaves prototype status.
- **Old OTP rows are never cleaned up.** Harmless at demo scale. A scheduled delete of consumed and expired rows would be the fix.
- **Enhancement is deterministic, not generative.** `POST /api/images/enhance` does EXIF auto rotation, resize to fit 1600px, contrast normalisation, a slight saturation lift, mild sharpening, and mozjpeg encoding. It deliberately does not use generative image editing, because a marketplace photo has to keep showing the artisan's actual product. Changing that is a product decision, not a bug.
- **`sharp` is a native dependency.** Vercel installs it for its own platform at deploy time, and CI installs it on Linux on every pull request, which is the check that would catch a break.

## Done in the Supabase and Vercel migration

- Firebase removed entirely: Auth, Firestore, Storage, Cloud Functions, Hosting, the security rules files, and the `firebase` client dependency. The frontend bundle dropped from about 400KB to about 294KB as a result.
- BHASHINI removed. It was optional and never ran against real credentials; Gemini handles translation.
- Backend moved from `functions/` to `server/`, with `api/index.ts` as the Vercel entry point. It is still the same Express app, so the routes and the API contract are unchanged apart from the items below.
- Postgres schema in `supabase/schema.sql`: a `users`, `products`, and `otp_codes` table, a composite index for the catalog query, row level security enabled with no public policies, and an atomic counter function so `total_products` cannot drift under concurrent writes.
- Email OTP sign in replacing phone OTP. Codes are 4 digits, hashed with SHA-256 before storage, single use, expire after 10 minutes, capped at 5 attempts, and compared with a timing safe comparison. Sessions are app issued JWTs lasting 7 days.
- Uploads switched from multipart to a raw request body with the type in an `X-File-Type` header. This is not cosmetic: serverless runtimes buffer and consume the request stream before the handler runs, which silently breaks multipart parsers, so image upload and voice would both have failed on Vercel.
- Product ownership is now enforced in the query itself (`.eq("user_id", uid)`) rather than read-then-check, which removes a race and a round trip.
- Dependencies pinned to the versions the code was written against after npm resolved majors it had not been tested with: `@google/genai` 1.x (2.x changes the API surface), `zod` 3.x, `express` 4.x, `sharp` 0.34.
- 21 new tests covering OTP generation, hashing, matching, email normalisation, JWT signing and verification including forged, tampered, and expired tokens, and the env schema including the fallback OTP toggle. 51 tests total.
- CI collapsed to a single job that lints, type checks the server, builds, and tests.
