# KalaSetu background removal service

A small self-hosted alternative to remove.bg. Wraps `u2netp` (Apache-2.0, 4.7MB, part of the same model family as the original U-2-Net project) behind one HTTP endpoint using `onnxruntime`, deliberately without pulling in the full `rembg` package (which bundles 16 model backends and has a known memory leak in its own server mode under sustained load).

## Endpoints

- `GET /` returns `{"status": "online", ...}`, used as a health check and as a warm-up ping.
- `POST /remove-background`, multipart field `file`, returns an `image/png` with the background made transparent.

## Deploy to Render

This folder is meant to be deployed as its own Render web service, independent of the main KalaSetu app in the parent repository.

1. On [render.com](https://render.com), **New -> Web Service**, connect this GitHub repository.
2. Set **Root Directory** to `bg-removal-service` so Render only builds this folder.
3. Runtime: **Docker** (Render detects the `Dockerfile` automatically).
4. Instance type: start on the **Free** tier (512MB RAM, 0.1 CPU). `u2netp` was chosen specifically because it is small enough to plausibly fit; watch the Render dashboard's memory graph under a few real requests before trusting this in production. If it proves too tight, move to the cheapest paid instance; this service still has no per-call cost either way, unlike remove.bg's quota.
5. Free services spin down after 15 minutes idle and take 30-60 seconds to cold start. The main KalaSetu app already pings this service's `/` route in the background the moment an artisan uploads a photo (see `server/routes/images.ts`), the same pattern already used for the craft classifier, to absorb that cold start before the artisan reaches the background removal button.
6. Copy the resulting `https://<service>.onrender.com` URL into the main app's `SELF_HOSTED_BG_REMOVAL_URL`, and set `BACKGROUND_REMOVAL_PROVIDER=remove-bg,self-hosted` so remove.bg is tried first and this service only runs when remove.bg fails or its quota is exhausted.

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
| `u2netp` (chosen) | 359MB | 0.09s | Good on plain/simple backgrounds; like the other two, fails completely on a busy patterned-cloth backdrop |
| `isnet-general-use` | 938MB | 0.43s | Noticeably better (e.g. cleanly removed a hand in frame that `u2netp` left in); still fails on the same patterned backdrop |
| BEN2 (`PramaLLC/BEN2`, fp16) | 2.72GB | 25.4s | Best watermark removal of the three; same patterned-backdrop failure |

Render's free tier gives 512MB RAM. `u2netp` is the only one of the three that actually fits it as measured, which is why it's the default here. `isnet-general-use` would need roughly 1GB+, meaning a small paid Render instance, not the free tier. BEN2 is ruled out entirely regardless of budget: 25+ seconds per photo on a fast desktop CPU means considerably worse on Render's throttled free/starter CPU allocations, too slow to be a usable synchronous fallback.

If `u2netp`'s quality proves insufficient and a paid tier is acceptable, `isnet-general-use` is Apache-2.0 licensed and loads through the exact same code path (`rembg`-family models share the same input/output tensor shape); download it, point `MODEL_PATH` at it, and size the Render instance to comfortably clear the measured 938MB peak.

Do not swap in a BRIA RMBG model (RMBG-1.4/2.0) without a paid commercial agreement with BRIA, and do not use IMG.LY's `@imgly/background-removal` package for anything beyond evaluation; it is AGPL-licensed.
