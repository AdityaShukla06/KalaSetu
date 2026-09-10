# KalaSetu pricing service

Suggests a selling price for a handcrafted item from what the artisan spent, how long they worked,
and what comparable listings actually sell for. Implements `PRICING_ENGINE_SPECIFICATION.md`.

The engine has two halves that are deliberately kept apart:

- **The cost floor** is arithmetic. Materials, plus hours at a regional skilled wage, plus 10%
  overhead, plus a 20% margin. It is checkable by hand and it never depends on a model.
- **The market estimate** is learned. The photo and the description are embedded, the nearest
  comparable listings are retrieved from a priced catalogue, and their similarity weighted median
  becomes a market price.

The two are blended, weighted by how confident the retrieval is, and the floor always wins ties:

```
recommended = max(floor, (1 - w) * floor + w * market_price)
```

The floor can only ever push the price up. That is the point: an artisan is never told to sell
below what their work costs to make at a fair wage.

## Endpoints

- `GET /` returns `{"service": "kalasetu-pricing", "status": "ok"}`. Health check and warm-up ping.
- `GET /health` returns `200` when the catalogue is embedded and searchable, `503` when only the
  cost floor is available. The body always says which, and why.
- `POST /pricing/estimate`, JSON, with an optional `image_base64`.
- `POST /pricing/estimate-upload`, multipart, with an optional `file` field.

Every response carries the full cost breakdown, the retrieved comparables with their prices and
similarities, an `assumptions` array, a reliability score, and per channel listing prices.

## What it refuses to do

The engine never invents an input. This is the design decision that most shapes the code:

- **No material cost, no price.** `400 material_cost_required`. There is no per category default,
  because without knowing how much material a piece used, a category average is a placeholder
  wearing an estimate's clothes.
- **No readable crafting time, no labour.** The price is returned covering materials and overhead
  only, `crafting_hours` is `null`, and a note says so. It does not fall back to a category average.
- **No comparable listings, no market pull.** `w` goes to zero and the price is the cost floor. It
  does not borrow a median from a different category, because benchmarking a bamboo basket against
  a silver necklace produces a number that looks authoritative and means nothing.

One assumption exists and it is disclosed rather than hidden. When an artisan writes "3 days", the
parser converts at 8 hours per working day, matching the statutory day the hourly wage is derived
from, and puts a sentence in the response `assumptions` array telling the artisan what was counted
and inviting them to correct it.

## Running locally

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
.venv/Scripts/python -m pytest
```

The tests run with or without the encoders installed, 134 of them, covering the cost arithmetic,
the weighted median, the free text time parser, the guardrails, the rounding order, catalogue
validation, retrieval ranking and the API contract. Both worked examples from the specification
reproduce to the rupee. Without the encoders they finish in under a second; with them, closer to
seven, because the models load.

To run the service against the sample catalogue:

```bash
PRICING_CATALOGUE=data/catalogue.sample.json .venv/Scripts/python -m uvicorn main:app --port 8099
```

Without the encoders installed it starts in degraded mode: `/health` returns `503`, estimates still
work, and every response says the market comparison did not run. That is the intended behaviour,
not a failure.

To enable the model side:

```bash
.venv/Scripts/python -m pip install -r requirements-model.txt
.venv/Scripts/python embed_catalogue.py data/catalogue.sample.json
PRICING_CATALOGUE=data/catalogue.sample.json HF_HUB_OFFLINE=1 \
  .venv/Scripts/python -m uvicorn main:app --port 8099
```

`HF_HUB_OFFLINE=1` after the first run stops the encoders revalidating against the Hub on every
start. Without it, startup makes roughly a hundred HEAD requests before serving anything.

Verified against the sample catalogue with real embeddings, both branches behave as designed:

| Query | Retrieval | Result |
|---|---|---|
| Kantha saree, 800 materials, 3 days, West Bengal | three kantha sarees ranked top at 0.967, 0.947, 0.927 above the plain handloom rows | `market`, floor 3590 lifted to **4150** |
| Blue pottery vase, 480 materials, 3 days, Rajasthan, GI | "Blue pottery flower vase" first at 0.932 | `cost_floor`, comparables at 2695 below the 3485 floor, priced at **3500** |

The pottery case is the one worth understanding. The model worked, found genuinely similar vases,
and returned a market price *below* what the piece costs to make at a fair wage. The floor won and
the response says why. That is the engine doing its job, not failing at it.

Note that these prices differ slightly from the specification's worked examples. The specification
used illustrative similarity figures; real embeddings produce their own, so `w` differs and the
blend lands elsewhere. The arithmetic is identical, and the unit tests pin the specification's
fixture values exactly.

## The catalogue is the real work

`data/catalogue.sample.json` contains 16 invented listings. They exist to exercise the retrieval
path and they are marked `"synthetic": true`. **They are not market data and must never price a
real item.**

A usable catalogue is `data/catalogue.json`, gitignored because it is scraped data, with this shape
per row:

```json
{
  "id": "ondc-8842",
  "image_url": "https://example.org/vase.jpg",
  "title": "Jaipur blue pottery vase",
  "description": "hand painted cobalt floral vase, 8 inch",
  "price": 2800,
  "category": "pottery",
  "subcategory": "vase",
  "has_gi_tag": true,
  "source": "ondc",
  "observed_date": "2026-08-30"
}
```

Required: `id`, `price`, `category`, `source`, `observed_date`, and at least one of `image_url` or
`description`. Rows missing those, priced at or below zero, or duplicating an `id` are dropped at
load with a count logged. Rejecting aggressively is correct here, because a row that survives is a
row the model prices from.

Target 1,500 to 3,000 rows with no category below roughly 100, from ONDC, GeM, Amazon and Flipkart
handicraft categories, iTokri, Gaatha, and state emporium sites. Keep `observed_date` per row: the
response exposes the catalogue's date range, so "current market trends" stays an honest claim
rather than an implied live feed.

No scraper ships here. Writing one against sites nobody has inspected would be guesswork, and the
sources differ enough that it is a real task rather than a utility.

### Embedding

`embed_catalogue.py` writes `<catalogue>.embeddings.npy` alongside a `.mode` file.

```bash
python embed_catalogue.py data/catalogue.json                      # text only
python embed_catalogue.py data/catalogue.json --image-dir images/  # image and text
```

The mode matters and getting it wrong silently degrades results. Queries are embedded in whatever
mode the catalogue was built in, because the two must live in the same vector space. If the
catalogue is text only and a query were fused with a real image vector, the image half would be
compared against zeros: the ranking would survive but every similarity would fall, `mean_sim` would
drop under `SIM_FLOOR`, and the model would silently stop contributing to any price. Pass
`--image-dir` with listing images named `<id>.jpg` to embed both signals.

## Deploying to Render

Same pattern as `bg-removal-service`: its own web service, **Root Directory** `pricing-service`,
runtime **Docker**.

**The free tier will not fit this.** `bg-removal-service` runs in 512MB only because it avoids
torch entirely and disables ONNX Runtime's memory arena. This service loads torch plus CLIP
ViT-B/32 (~350MB) plus multilingual MiniLM (~470MB), which is comfortably past that ceiling before
a single request arrives. Either pay for an instance with real memory, or export both encoders to
ONNX and run them under `onnxruntime` the way the background removal service already does, which
would drop torch from the image entirely. The second is the better engineering and is not done here.

Cold starts apply as they do to the other services. Point `PRICING_SERVICE_URL` at the deployed URL
and ping `/` on the same schedule the craft classifier already uses.

## Layout

| File | Specification section |
|---|---|
| `cost.py` | 6, the cost floor |
| `crafting_time.py` | 10, free text time parsing |
| `encoders.py` | 7.2, image and text embedding |
| `catalogue.py` | 7.1 and 7.3, loading, validation, search |
| `retrieval.py` | 7.3, weighted median and confidence weight |
| `blend.py` | 8 and 12, the blend and the rounding order |
| `channels.py` | 9, channel gross up |
| `guards.py` | 11, guardrails and refusals |
| `reliability.py` | 15, the reliability score |
| `main.py` | 16, the end to end path |

## Node integration

The Node app can now call this service instead of the local TypeScript engine, with the local
engine kept as an automatic fallback. Set `PRICING_SERVICE_URL` (and optionally
`PRICING_SERVICE_TIMEOUT_MS`, default 20000) in the main app's environment. `server/routes/pricing.ts`
tries this service first; if it is unreachable, times out, or returns an error, it logs a warning
and falls back to `calculateSmartPrice()` so pricing never breaks. Leave `PRICING_SERVICE_URL`
unset to skip this entirely, exactly as if the integration was never added.

The response is translated into the existing `PricingEngineOutput` shape by
`server/services/pricingServiceMapper.ts`, so nothing downstream (the pricing screen, the
overcharge auto-flag) needs to change. One field is deliberately not carried over:
`assumptions.labourFactor` is always `0` when the response came from this service, because this
engine prices labour from real hours times a wage, not a fixed multiple of material cost, and the
old field would be a fabricated number if backfilled from a coincidental ratio.

**Do not point production at this service yet.** It is wired in and tested, but two things gate an
actual deploy: `data/catalogue.json` does not exist yet, only the 16-row synthetic sample, so the
market side would rarely have anything real to compare against; and the service will not fit
Render's free tier as it stands (`requirements-model.txt` pulls in torch), so it needs either a
paid instance or the ONNX conversion described below.

## Known gaps

- **The wage table is placeholder data.** `data/wage_standards.json` carries `"verified": false`
  and a null `notification_date`. Replace the figures with a cited state notification under the
  Minimum Wages Act 1948, or the Chief Labour Commissioner's half yearly revision, before this
  prices anything for a real artisan.
- **The supervised regressor of specification 7.4 is not implemented.** Retrieval alone ships
  first, which the specification calls for. A regressor must beat the category median baseline on
  held out MAPE before it earns its place, and there is no catalogue to measure that against yet.
- **Channel fee percentages are unverified.** Check the four figures in `constants.py` against
  current published rate cards.
- **GST and shipping are out of scope.** `take_home` is before both.
