# KalaSetu setup and deployment

Everything needed to take this from a clean clone to a live URL. Stack is Vercel (PWA + API) and Supabase (Postgres + Storage). No credit card is required for either.

Work through the sections in order. Expect about 45 minutes the first time.

---

## 1. Supabase

1. Go to [supabase.com](https://supabase.com) and sign in with GitHub.
2. **New project**. Name it `kalasetu`. Choose region **South Asia (Mumbai) ap-south-1** for latency. Set a database password and save it somewhere, you will not need it for this app but you cannot see it again.
3. Wait for the project to finish provisioning, about two minutes.
4. Open **SQL Editor** in the sidebar, click **New query**, paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.

   If your database was created before the multilingual change, also run [`supabase/migrations/001-multilingual.sql`](supabase/migrations/001-multilingual.sql). A fresh database does not need it. It creates the tables, the index, the counter function, row level security, and the storage bucket. It is safe to run more than once.
5. Open **Project Settings -> API** and copy two values:
   - **Project URL** goes into `SUPABASE_URL`
   - **`service_role` secret** goes into `SUPABASE_SERVICE_ROLE_KEY`

> The `service_role` key bypasses row level security. It belongs only in server side environment variables. Never put it in the frontend, and never commit it.

## 2. Groq API key

1. Go to [console.groq.com](https://console.groq.com) (Groq the inference provider, not Grok the chatbot) and sign in with Google or GitHub. Free, no card.
2. **API Keys -> Create API Key**, copy it into `GROQ_API_KEY`. It starts with `gsk_`.

This powers voice transcription (Whisper), translation, and description generation (gpt-oss-120b). Without it the voice step returns an error and everything else still works.

Gemini is supported as a fallback: set `VOICE_AI_PROVIDER=gemini` and supply `GEMINI_API_KEY` instead. Worth knowing that Gemini's free tier allows only 5 requests per minute, and one voice note costs up to four of them.

## 3. Background removal (optional)

Powers the "Remove background" button in the photo enhancement studio. Everything else in the studio (brightness, contrast, sharpen, crop, background fill/blur) runs locally in `sharp` and needs no key.

1. Go to [remove.bg](https://www.remove.bg), create an account, and open your account/API settings to get an API key.
2. Set `BACKGROUND_REMOVAL_PROVIDER=remove-bg` and put the key in `REMOVE_BG_API_KEY`.
3. **Free tier:** new accounts get 50 free API calls, at preview resolution (up to 0.25 megapixels). Beyond that it's pay-as-you-go credits. Check your remaining calls on your remove.bg account dashboard before demo day, since the exact allowance is set by remove.bg and can change.

**You can skip this entirely.** Leave `BACKGROUND_REMOVAL_PROVIDER=none` (the default) and the button reports background removal as unavailable; the rest of the photo pipeline, and the rest of the app, is unaffected.

## 4. A session secret

Generate any long random string for `JWT_SECRET`:

```bash
openssl rand -base64 32
```

If you change this later, everyone is signed out. That is the intended way to revoke all sessions.

## 5. Email delivery (optional)

Sign in codes are emailed through [Resend](https://resend.com). Free tier, no card, 3000 emails a month.

1. Sign up, go to **API Keys**, create one, put it in `RESEND_API_KEY`.
2. Leave `OTP_FROM_EMAIL` unset to use Resend's shared `onboarding@resend.dev` sender, which works immediately without verifying a domain.

**You can skip this entirely.** Without a key, codes are not emailed and the demo fallback OTP below is how you sign in.

## 6. Run it locally

```bash
npm install
cp .env.example .env    # then fill in the values from the steps above
npm run dev
```

Open `http://localhost:5173`. Sign in with any email address and the code `5741`.

To check the API is alive: `http://localhost:5173/api/health` should return `{"status":"ok"}`.

## 7. Deploy to Vercel

1. Push your branch to GitHub.
2. Go to [vercel.com](https://vercel.com), sign in with GitHub, **Add New -> Project**, import the repository.
3. Vercel detects Vite from `vercel.json`. Do not change the build settings.
4. Before deploying, open **Environment Variables** and add every server side value from your `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `JWT_SECRET`
   - `GROQ_API_KEY`
   - `BACKGROUND_REMOVAL_PROVIDER` and `REMOVE_BG_API_KEY` (only if you did step 3)
   - `RESEND_API_KEY` (only if you did step 5)
   - `DEMO_FALLBACK_OTP_ENABLED`
5. **Deploy.**

Vercel gives you an HTTPS URL. That matters: the camera and microphone only work in a secure context, so the app cannot be fully tested over plain HTTP.

`VITE_API_BASE_URL` should stay empty in production. The API is served from the same origin at `/api`.

## 8. Verify the deployment

- [ ] `https://<your-app>.vercel.app/api/health` returns `{"status":"ok","version":"1.0.0"}`. **Check this first.** If it fails, everything else will fail in ways that look unrelated.
- [ ] The app loads at the root URL.
- [ ] Sign in with an email and the demo code `5741`.
- [ ] Supabase **Table Editor -> users** shows a row for that email.
- [ ] Add a product end to end. **Table Editor -> products** shows it, and **Storage -> product-images** shows the photo.

Then work through [`TESTING.md`](TESTING.md) on a real Android phone.

---

## The demo fallback OTP

`5741` signs in as whatever email address is typed, no email required.

This exists so a demo cannot be derailed by email delivery. **It is a complete authentication bypass**: anyone who knows the code can sign in as anyone. It is fine for a prototype and a judged demo, and it must not survive contact with real artisans' data.

Turn it off by setting `DEMO_FALLBACK_OTP_ENABLED=false` in Vercel and redeploying. No code change needed. Every use is logged as a `SECURITY` warning in the Vercel function logs.

Change the code itself with `DEMO_FALLBACK_OTP`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` returns 500 | A required env var is missing | Vercel logs name the exact variable. Check all of section 7. |
| `Invalid server environment configuration` | Same as above | The error lists every missing or invalid variable. |
| Sign in says the code is wrong | No email arrived and you typed a guess | Use `5741`, or set `RESEND_API_KEY` to receive real codes. |
| Voice returns 500 with `stage: "stt"` | Provider key, model, or rate limit | The function logs carry the provider's own error. |
| Images 404 after upload | Storage bucket missing or private | Re-run `supabase/schema.sql`, then confirm `product-images` exists and is public. |
| "Remove background" always reports unavailable | `BACKGROUND_REMOVAL_PROVIDER` is `none`, or the key is missing/wrong, or your remove.bg credits ran out | Check section 3, and your remove.bg dashboard for remaining credits. Everything else in the studio still works either way. |
| Everything 401s | `JWT_SECRET` changed between deploys | Expected, sign in again. |
