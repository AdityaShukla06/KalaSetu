# KalaSetu background removal service

The background removal used by the main KalaSetu app, running entirely on infrastructure you own rather than a paid third-party API. Wraps `u2netp` (Apache-2.0, 4.7MB, part of the same model family as the original U-2-Net project) behind one HTTP endpoint using `onnxruntime`, deliberately without pulling in the full `rembg` package (which bundles 16 model backends and has a known memory leak in its own server mode under sustained load).

## Endpoints

- `GET /` returns `{"status": "online", ...}`, used as a health check and as a warm-up ping.
- `POST /remove-background`, multipart field `file`, returns an `image/png` with the background made transparent.

## Deploy to Render

This folder is meant to be deployed as its own Render web service, independent of the main KalaSetu app in the parent repository.

1. On [render.com](https://render.com), **New -> Web Service**, connect this GitHub repository.
2. Set **Root Directory** to `bg-removal-service` so Render only builds this folder.
3. Runtime: **Docker** (Render detects the `Dockerfile` automatically).
4. Instance type: the **Free** tier (512MB RAM, 0.1 CPU) is enough, but only because ONNX Runtime's CPU memory arena is explicitly disabled in `build_session()`. Leave that alone unless you have measured the consequences: with the arena at its default, memory sat at 365MB after one request and then jumped to **575-580MB from the second request onward**, permanently over the free tier's 512MB ceiling, which got the container OOM-killed repeatedly in production. With the arena off it stays flat at roughly 86MB across repeated requests, about a 7x reduction, with no loss of speed. Disabling `enable_mem_pattern` goes along with it; do not also pin `intra_op_num_threads` to 1, which measured 4x slower for only another 3MB.
5. Free services spin down after 15 minutes idle and take 30-60 seconds to cold start. The main KalaSetu app already pings this service's `/` route in the background the moment an artisan uploads a photo (see `server/routes/images.ts`), the same pattern already used for the craft classifier, to absorb that cold start before the artisan reaches the background removal button. Separately from cold start, actual inference on Render's free CPU tier measured 14-20 seconds per photo against the real deployed instance (vs under a second measured locally), which is why the main app's `SELF_HOSTED_BG_REMOVAL_TIMEOUT_MS` defaults to 22 seconds; a first deploy shipped with a much shorter shared timeout, which silently failed on every real request until this was caught by testing against the live deployment. The free tier also failed intermittently under real device testing even once the timeout was fixed, likely load or a restart on Render's end, so `SelfHostedBgRemovalService` now retries once before giving up.
6. Copy the resulting `https://<service>.onrender.com` URL into the main app's `SELF_HOSTED_BG_REMOVAL_URL`, and set `BACKGROUND_REMOVAL_PROVIDER=self-hosted`.

## Running locally

```bash
pip install -r requirements-dev.txt
python -m pytest
uvicorn main:app --reload
```

The first run downloads nothing automatically; `main.py` expects `u2netp.onnx` to already exist (`MODEL_PATH`, default `./u2netp.onnx`). Fetch it once:

```bash
curl -fL -o u2netp.onnx https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
```

## Why `u2netp`, measured rather than assumed

Three open models were actually tested against real product photos (jewelry, woodwork, pottery on a patterned cloth backdrop) before picking one, measuring peak RSS in an isolated process for one real inference each, not just file size:

| Model | Peak RSS | Inference time (dev CPU) | Cutout quality |
|---|---|---|---|
| `u2netp` (chosen) | 359MB, but see below | 0.09s | Good on plain/simple backgrounds; like the other two, fails completely on a busy patterned-cloth backdrop |
| `isnet-general-use` | 938MB | 0.43s | Noticeably better (e.g. cleanly removed a hand in frame that `u2netp` left in); still fails on the same patterned backdrop |
| BEN2 (`PramaLLC/BEN2`, fp16) | 2.72GB | 25.4s | Best watermark removal of the three; same patterned-backdrop failure |

Render's free tier gives 512MB RAM. `u2netp` is the only one of the three that actually fits it, which is why it's the default here. `isnet-general-use` would need roughly 1GB+, meaning a small paid Render instance, not the free tier. BEN2 is ruled out entirely regardless of budget: 25+ seconds per photo on a fast desktop CPU means considerably worse on Render's throttled free/starter CPU allocations, too slow to be usable synchronously.

**A caveat about that table, learned the hard way:** those figures are each from a *single* inference in a fresh process, which turned out to be the wrong thing to measure. Repeating the same measurement across ten consecutive requests showed `u2netp` climbing from 365MB on request one to 575-580MB from request two onward and staying there, which is over the free tier's ceiling and is why the deployed service kept getting OOM-killed in production while single-shot tests looked fine. The fix was disabling the ONNX Runtime memory arena, not changing model. If you re-evaluate any model here, measure repeated requests, not one.

If `u2netp`'s quality proves insufficient and a paid tier is acceptable, `isnet-general-use` is Apache-2.0 licensed and loads through the exact same code path (`rembg`-family models share the same input/output tensor shape); download it, point `MODEL_PATH` at it, and size the Render instance to comfortably clear the measured 938MB peak.

Do not swap in a BRIA RMBG model (RMBG-1.4/2.0) without a paid commercial agreement with BRIA, and do not use IMG.LY's `@imgly/background-removal` package for anything beyond evaluation; it is AGPL-licensed.
