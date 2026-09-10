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

`data/catalogue.sample.json` still contains 16 invented listings, marked `"synthetic": true`, kept
only to exercise the retrieval path in tests. **They are not market data and must never price a
real item.**

`data/catalogue.json` is real: 4,223 genuine listings scraped from two sources, committed to the
repo (not gitignored, since it is real data that took real effort to build, not a local artifact).
Built by `scripts/build_catalogue.py`, which respects each source's own terms before touching it,
documented in the next section.

Row shape:

```json
{
  "id": "itokri-8256279904451",
  "image_url": "https://cdn.shopify.com/s/files/.../vase.jpg",
  "title": "Jaipur blue pottery vase",
  "description": "hand painted cobalt floral vase, 8 inch",
  "price": 2800,
  "category": "pottery",
  "subcategory": "vase",
  "has_gi_tag": false,
  "source": "itokri",
  "observed_date": "2026-09-11"
}
```

Required: `id`, `price`, `category`, `source`, `observed_date`, and at least one of `image_url` or
`description`. Rows missing those, priced at or below zero, or duplicating an `id` are dropped at
load with a count logged. All 4,223 rows currently pass validation.

### Sources, and why only two

The specification's original wishlist was ONDC, GeM, Amazon, Flipkart, iTokri and Gaatha. Each was
checked against its own `robots.txt` and Terms of Use before writing a line of scraper code:

| Source | Verdict | Why |
|---|---|---|
| iTokri | Used | `robots.txt` permits crawling; exposes a public `/products.json` API, no HTML parsing needed |
| Gaatha (`shop.gaatha.com`) | Used | `robots.txt` permissive; real priced listings, server-rendered HTML |
| Amazon | Not used | Own Conditions of Use explicitly prohibit "robot, spider, scraper, or other automated means" |
| Flipkart | Not used | Own Terms explicitly prohibit "deep-link, page-scrape, robot, spider..."; a bare `robots.txt` request was served an active reCAPTCHA challenge |
| GeM | Not used | Could not locate GeM's own Terms text to verify against (search results were third-party scraper-vendor marketing, not GeM's own words); its listings are B2G procurement prices anyway, a questionable fit for retail pricing |
| ONDC | Not applicable | Not a website. It is a network protocol; getting real listings means registering as a Seller or Buyer Network Participant, a business onboarding process, not a scraping target |

Amazon and Flipkart are not "not yet done", they are excluded on principle. If that data is wanted,
the legitimate path is their official affiliate programs (Amazon Associates → Product Advertising
API, Flipkart Affiliate Program), which needs a human to sign up and hand over the resulting API
keys, not a scraper.

To rebuild the catalogue from scratch:

```bash
pip install requests beautifulsoup4
python scripts/build_catalogue.py
python embed_catalogue.py data/catalogue.json
```

Paces requests at one per second and is polite about it; a full run against both sources takes a
few minutes. Re-running is safe and idempotent: it always starts from a fresh fetch rather than
appending to the existing file.

### Category balance took real correction, not just volume

The first pass hit volume easily (4,227 rows) but was badly imbalanced by material: category pages
on both sites group by room or use ("dining-kitchen", "home-decor"), not by material, so a "pottery"
seed page returned genuine ceramics alongside brass spice boxes, silk stoles, and framed paintings.
Trusting the seed page's label alone would have shipped a pottery category that was mostly not
pottery.

The fix: every row is reclassified by keywords actually present in its own title (`jewelry`,
`textiles` checked first, since a fabric-and-wood earring is jewelry, not woodwork; then
`pottery`/`woodwork`/`bamboo-cane` material words), with the few seed pages that are genuinely
named after one craft (`buy-handmade-khurja-pottery`, `buy-etikoppaka-traditional-natural-product`,
`Handmade-cane-Products`) trusted as a fallback only when nothing contradicts them. Two real bugs
this caught, as examples: a "Kurta & Dupatta with Earrings" combo listing was landing in jewelry
because of the bundled accessory mentioned in its own title, not because it was jewelry; a clay
lamp was landing in bamboo-cane because it came from a shared "home decor" page, not because
anything about it was bamboo or cane.

Genuine items in the material the seller states as Kansa (bell-metal), brass, copper, or soapstone
are deliberately left in `other`, since none of those are one of the six supported categories, and
guessing a nearer category for them would be exactly the kind of fabricated input this project
exists to avoid.

Current distribution:

| Category | Rows |
|---|---|
| textiles | 3,104 |
| other | 554 |
| jewelry | 314 |
| woodwork | 117 |
| pottery | 77 |
| bamboo-cane | 57 |

Pottery and bamboo-cane sit below the ~100-row target from section 7.1 of the specification, and
that is reported honestly rather than papered over: once contamination was removed, these two
sources genuinely do not carry deep inventory in those two materials. Closing that gap needs a
third source with real pottery or bamboo-cane stock, not a looser keyword match on the two sources
already in hand.

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
| `scripts/build_catalogue.py` | 7.1, builds `data/catalogue.json` from iTokri and Gaatha |
| `embed_catalogue.py` | 7.2, embeds a catalogue file for retrieval |

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

**Not yet verified enough for production.** It is wired in, tested, and now has a real 4,223-row
catalogue instead of the synthetic sample, but two things still gate an actual deploy:

- The service will not fit Render's free tier as it stands (`requirements-model.txt` pulls in
  torch), so it needs either a paid instance or the ONNX conversion described below.
- `SIM_FLOOR = 0.60` was chosen for the specification's hand-written worked examples, where query
  and catalogue wording were written to closely match. Real scraped listings use organic, marketing
  voice, and a genuinely relevant real match can score in the 0.5 to 0.6 range, sometimes landing
  the model on the wrong side of the floor for a query that should have found something. This is
  not a bug to patch by lowering the constant on a hunch; it needs the held out evaluation from
  specification section 7.5 before any threshold is retuned, so the number is chosen from evidence
  rather than from one convenient test query.

## Known gaps

- **The wage table is placeholder data.** `data/wage_standards.json` carries `"verified": false`
  and a null `notification_date`. Replace the figures with a cited state notification under the
  Minimum Wages Act 1948, or the Chief Labour Commissioner's half yearly revision, before this
  prices anything for a real artisan.
- **The supervised regressor of specification 7.4 is not implemented.** Retrieval alone ships
  first, which the specification calls for. A regressor must beat the category median baseline on
  held out MAPE before it earns its place; there is now a real catalogue to measure that against,
  but the held out evaluation itself (specification 7.5) has not been run.
- **Pottery (77 rows) and bamboo-cane (57 rows) sit below the ~100-row target.** See "The catalogue
  is the real work" above. Needs a third source with real inventory in those two materials.
- **Only text embeddings.** No product images were downloaded, so retrieval matches on title and
  description text alone (`embedding_mode: "text"`). Image similarity, half of section 7.2's design,
  is unused. `embed_catalogue.py --image-dir` supports it once images are downloaded locally.
- **`SIM_FLOOR` is unvalidated against real data.** See "Not yet verified enough for production"
  above.
- **Channel fee percentages are unverified.** Check the four figures in `constants.py` against
  current published rate cards.
- **GST and shipping are out of scope.** `take_home` is before both.
