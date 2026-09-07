# KalaSetu setup and deployment

Everything needed to take this from a clean clone to a live URL. Stack is Vercel (PWA + API) and Supabase (Postgres + Storage). No credit card is required for either.

Work through the sections in order. Expect about 45 minutes the first time.

---

## 1. Supabase

1. Go to [supabase.com](https://supabase.com) and sign in with GitHub.
2. **New project**. Name it `kalasetu`. Choose region **South Asia (Mumbai) ap-south-1** for latency. Set a database password and save it somewhere, you will not need it for this app but you cannot see it again.
3. Wait for the project to finish provisioning, about two minutes.
4. Open **SQL Editor** in the sidebar, click **New query**, paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. It creates the tables, the indexes, the counter function, row level security, and the storage bucket. It is safe to run more than once.

   If your database predates a later change, also run whichever files in [`supabase/migrations/`](supabase/migrations/) you're missing, in order: `001-multilingual.sql`, `002-roles.sql` (the artisan/buyer/admin role model), `003-marketplace-fields.sql` (region, material, and the buyer marketplace), `004-admin-console.sql` (artisan deactivation, retrospective listing review, the audit log). A fresh database created from `schema.sql` today already has all of this and needs none of them. Each file is safe to run more than once and says at the top what it does.
5. Open **Project Settings -> API** and copy two values:
   - **Project URL** goes into `SUPABASE_URL`
   - **`service_role` secret** goes into `SUPABASE_SERVICE_ROLE_KEY`

> The `service_role` key bypasses row level security. It belongs only in server side environment variables. Never put it in the frontend, and never commit it.

## 2. Groq API key

1. Go to [console.groq.com](https://console.groq.com) (Groq the inference provider, not Grok the chatbot) and sign in with Google or GitHub. Free, no card.
2. **API Keys -> Create API Key**, copy it into `GROQ_API_KEY`. It starts with `gsk_`.

This powers voice transcription (Whisper), translation, and description generation (gpt-oss-120b). Without it the voice step returns an error and everything else still works.

Gemini is supported as a fallback: set `VOICE_AI_PROVIDER=gemini` and supply `GEMINI_API_KEY` instead. Worth knowing that Gemini's free tier allows only 5 requests per minute, and one voice note costs up to four of them.

### Extra Groq keys, so a spent quota does not stop the app

There are two spare key slots in `.env`, used automatically once `GROQ_API_KEY` is out of quota for the day. Paste a key into each and restart:

```
GROQ_API_KEY_2=gsk_second...
GROQ_API_KEY_3=gsk_third...
```

Leave either blank if you don't have it, that costs nothing. If you want more than two spares, `GROQ_FALLBACK_API_KEYS` takes a comma-separated list that gets merged with the slots above:

```
GROQ_FALLBACK_API_KEYS=gsk_fourth...,gsk_fifth...
```

**This only works if each key comes from a different Groq account.** Groq counts the daily token quota per organisation, so three keys generated inside one account share one allowance and rotating between them changes nothing. If you are pooling keys, they have to be genuinely separate accounts (for a team, each member's own account). Check Groq's terms before creating extra accounts purely to raise a limit.

`GET /api/health` reports `config.groqKeys`, so you can confirm how many keys a deployment actually picked up.

## 3. Background removal (optional)

Powers the "Remove background" button in the photo enhancement studio. Everything else in the studio (brightness, contrast, sharpen, crop, background fill/blur) runs locally in `sharp` and needs no key.

1. Go to [remove.bg](https://www.remove.bg), create an account, and open your account/API settings to get an API key.
2. Set `BACKGROUND_REMOVAL_PROVIDER=remove-bg` and put the key in `REMOVE_BG_API_KEY`.
3. **Free tier:** new accounts get 50 free API calls, at preview resolution (up to 0.25 megapixels). Beyond that it's pay-as-you-go credits. Check your remaining calls on your remove.bg account dashboard before demo day, since the exact allowance is set by remove.bg and can change.

**You can skip this entirely.** Leave `BACKGROUND_REMOVAL_PROVIDER=none` (the default) and the button reports background removal as unavailable; the rest of the photo pipeline, and the rest of the app, is unaffected.

## 4. Craft category suggestion (optional)

After an artisan takes a photo, the app suggests which category it belongs to (textiles, pottery, jewelry, woodwork, bamboo & cane, or other) so the next screen opens with that tile already picked. It is always editable with one tap, and nothing here is required for the app to work: with no keys configured at all, the category screen behaves exactly as if this feature did not exist.

Three providers are tried in order, each one only used if the one before it fails or is not configured, and each one is time-boxed so a single slow tier cannot eat the whole request's time budget:

1. **Groq**, using the same key pool from section 2, on `qwen/qwen3.6-27b` (`GROQ_VISION_MODEL`) with `qwen/qwen3.8-27b` as its own model fallback (`CRAFT_CLASSIFIER_TIMEOUT_MS`, default 6 seconds). In testing this tier answered in a couple of seconds and correctly classified real product photos across every category, which is why it goes first.
2. **Gemini**, using the `GEMINI_API_KEY` from section 2, also bounded by `CRAFT_CLASSIFIER_TIMEOUT_MS`. Gemini's vision calls measured 5-25 seconds in testing, too slow to reliably win a 6-second window, so it is kept as a fallback rather than tried first, even though its JSON-schema-constrained output is the most reliable of the three when it does answer in time.
3. The **KalaSetu craft classifier**, a small model purpose-trained on these six categories, called through `CRAFT_CLASSIFIER_URL` (defaults to the hosted instance, no key needed), bounded by `CRAFT_CLASSIFIER_RENDER_TIMEOUT_MS` (default 20 seconds). It free-tier hosts on Render and can take up to a minute to answer after 15 minutes idle, which is why the `/enhance` step already sends it a background warm-up ping the moment a photo is uploaded, and why this is the last tier tried: by the time it's reached, the artisan has already spent several seconds on the earlier two tiers on top of however long they spent reviewing the photo, giving Render's cold start a real head start.

**Why the timeouts matter beyond just user-perceived speed:** the whole API runs as one Vercel serverless function with a 60-second budget (`vercel.json`'s `maxDuration`). If every configured tier ran to its absolute worst case one after another, an unbounded chain could exceed that budget and get killed by the platform with no response at all, which looks to the artisan exactly like the feature doing nothing. The three timeouts above (6s + 6s + 20s, worst case) are chosen to leave comfortable headroom under that ceiling even when every tier is tried.

To turn a tier off, remove it from the comma-separated `CRAFT_CLASSIFIER_PROVIDERS` (default `groq,gemini,render`). Setting it to an empty string disables the feature entirely.

## 5. A session secret

Generate any long random string for `JWT_SECRET`:

```bash
openssl rand -base64 32
```

If you change this later, everyone is signed out. That is the intended way to revoke all sessions.

## 6. Email delivery (optional)

Sign in codes are emailed through [Resend](https://resend.com). Free tier, no card, 3000 emails a month.

1. Sign up, go to **API Keys**, create one, put it in `RESEND_API_KEY`.
2. Leave `OTP_FROM_EMAIL` unset to use Resend's shared `onboarding@resend.dev` sender, which works immediately without verifying a domain.

**You can skip this entirely.** Without a key, codes are not emailed and the demo fallback OTP below is how you sign in.

The same Resend setup also emails an artisan when a buyer sends an inquiry. Set `PUBLIC_APP_URL` to your deployed URL (defaults to `http://localhost:5173`) so that email's "view and respond" link points somewhere real.

## 7. Run it locally

```bash
npm install
cp .env.example .env    # then fill in the values from the steps above
npm run dev
```

`npm run dev` starts two processes together (labelled `[api]` and `[web]` in the terminal): the Express API on `http://localhost:8787`, and Vite on `http://localhost:5173`, which proxies any `/api/*` request straight through to it. That's what makes `/api` work at the same origin as the frontend locally, matching how a single Vercel deployment serves both in production.

Open `http://localhost:5173`. Sign in with any email address and the code `5741`.

To check the API is alive: `http://localhost:5173/api/health` should return `{"status":"ok", ...}`. If it instead returns the app's HTML, the `[api]` process didn't start, most likely because a required `.env` value is missing; check the `[api]` process's own terminal output for the actual error.

## 8. Deploy to Vercel

1. Push your branch to GitHub.
2. Go to [vercel.com](https://vercel.com), sign in with GitHub, **Add New -> Project**, import the repository.
3. Vercel detects Vite from `vercel.json`. Do not change the build settings.
4. Before deploying, open **Environment Variables** and add every server side value from your `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `JWT_SECRET`
   - `GROQ_API_KEY`
   - `BACKGROUND_REMOVAL_PROVIDER` and `REMOVE_BG_API_KEY` (only if you did step 3)
   - `GEMINI_API_KEY` (only if you want the craft category suggestion's first tier, step 4)
   - `RESEND_API_KEY` (only if you did step 6)
   - `PUBLIC_APP_URL` (your deployed URL, so inquiry notification emails link back correctly)
   - `DEMO_FALLBACK_OTP_ENABLED`
5. **Deploy.**

Vercel gives you an HTTPS URL. That matters: the camera and microphone only work in a secure context, so the app cannot be fully tested over plain HTTP.

`VITE_API_BASE_URL` should stay empty in production. The API is served from the same origin at `/api`.

## 9. Verify the deployment

- [ ] `https://<your-app>.vercel.app/api/health` returns `{"status":"ok","version":"1.0.0"}`. **Check this first.** If it fails, everything else will fail in ways that look unrelated.
- [ ] The app loads at the root URL.
- [ ] Sign in with an email and the demo code `5741`.
- [ ] Supabase **Table Editor -> users** shows a row for that email.
- [ ] Add a product end to end. **Table Editor -> products** shows it, and **Storage -> product-images** shows the photo.

Then work through [`TESTING.md`](TESTING.md) on a real Android phone.

## Admin console for judging

`npm run seed:demo-admin -- you@example.com` creates that account directly as an active admin, no prior sign-in needed (defaults to `admin@kalasetu.demo` if you omit the email). Sign in through the normal email screen with that address; the sell/buy choice on that screen is ignored since the account already exists. You'll land on `/internal/console` automatically. The path is deliberately not linked from anywhere in the app, by design (see the README's "Admin console" section), so bookmark it.

**Give it a password instead of an OTP** (recommended for the account you'll actually use during judging): `npm run admin:set-password -- you@example.com yourpassword`. From then on, entering that email on the sign-in screen skips the emailed code entirely and asks for the password directly, so getting into the console during a demo never depends on Resend or an inbox being reachable. Five wrong attempts locks it for 15 minutes.

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
| Voice or translation stops working partway through a busy day | Groq's daily token quota is spent | Expected on the free tier. Fill `GROQ_API_KEY_2` / `GROQ_API_KEY_3` with keys from separate Groq accounts (see section 2), or wait for the quota to reset. Extra keys from the same account do not help. |
| Added more keys but it still runs out | All the keys belong to one Groq account | The daily quota is per account, not per key. Check `/api/health`'s `config.groqKeys` to confirm they were picked up, then confirm each key really is from a different account. |
| Images 404 after upload | Storage bucket missing or private | Re-run `supabase/schema.sql`, then confirm `product-images` exists and is public. |
| Category is never pre-selected after a photo | All three classifier tiers are unconfigured, disabled, or failed | Expected with no keys set at all, see section 4. Otherwise check the server logs for `craft classifier tier failed` to see which tiers were tried and why. |
| "Remove background" always reports unavailable | `BACKGROUND_REMOVAL_PROVIDER` is `none`, or the key is missing/wrong, or your remove.bg credits ran out | Check section 3, and your remove.bg dashboard for remaining credits. Everything else in the studio still works either way. |
| Everything 401s | `JWT_SECRET` changed between deploys | Expected, sign in again. |
| Sign in returns 403 `account_deactivated` | An admin deactivated that artisan in the console | Reactivate them from `/internal/console/artisans`, or it's expected if that was intentional. |
| `/internal/console` shows "Page not found" | You're not signed in as an admin | That's the intended behaviour for anyone else, not a bug. Seed or promote an admin account (see "Admin console for judging" above). |
| Admin sign-in asks for a password you never set | An earlier run of `npm run admin:set-password` set one and you forgot | Run it again with a new password, it overwrites the old one. |
| Admin sign-in says "too many incorrect attempts" | 5 wrong passwords locks the account for 15 minutes | Wait 15 minutes, or clear `users.locked_until` directly in the Supabase Table Editor if you need to sign in sooner. |
| The app loads but nothing works locally (login hangs, screens stay blank, `/api/health` returns HTML instead of JSON) | The API process isn't running. Running `vite` directly, or an older terminal tab still running just `vite`, skips the API entirely | Use `npm run dev` (not `vite` directly), and check its `[api]`-labelled output for a startup error. Two dev servers on the same ports at once (an old tab left open) will also cause this. |
