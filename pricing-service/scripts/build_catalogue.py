import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

DATA_DIR = Path(__file__).parent.parent / "data"
OUTPUT_PATH = DATA_DIR / "catalogue.json"
USER_AGENT = "Mozilla/5.0 (compatible; KalaSetuCatalogueBuilder/1.0)"
REQUEST_DELAY_SECONDS = 1.0
TODAY = date.today().isoformat()

ITOKRI_TYPE_TO_CATEGORY = {
    "fabrics": "textiles",
    "dress materials": "textiles",
    "sarees": "textiles",
    "dupattas": "textiles",
    "stoles": "textiles",
    "scarves": "textiles",
    "shawls": "textiles",
    "kurtas": "textiles",
    "kurta sets": "textiles",
    "blouse pieces": "textiles",
    "skirts": "textiles",
    "dresses": "textiles",
    "kids clothing": "textiles",
    "unstitched kurta material": "textiles",
    "curtains": "textiles",
    "bottoms": "textiles",
    "cushion covers": "textiles",
    "throws": "textiles",
    "aprons": "textiles",
    "earrings": "jewelry",
    "necklaces": "jewelry",
    "necklace sets": "jewelry",
    "rakhi": "jewelry",
}

GAATHA_SEEDS = [
    ("https://shop.gaatha.com/buy-handmade-khurja-pottery-and-ceramic-kitchenware", "pottery", True),
    ("https://shop.gaatha.com/dining-kitchen/mugs-cups-coasters", "pottery", False),
    ("https://shop.gaatha.com/buy-etikoppaka-traditional-natural-product", "woodwork", True),
    ("https://shop.gaatha.com/Handmade-cane-Products", "bamboo-cane", True),
    ("https://shop.gaatha.com/bamboo-home-decor-miniature-chakki", "bamboo-cane", True),
    ("https://shop.gaatha.com/Buy-Payal-Traditional-indian-Anklet", "jewelry", True),
    ("https://shop.gaatha.com/jewelry/traditional-indian-hair-jewellery", "jewelry", True),
    ("https://shop.gaatha.com/buy-tribal-dhokra-art", "other", True),
    ("https://shop.gaatha.com/antiquities-carving-on-brass-lota", "other", True),
    ("https://shop.gaatha.com/handmade-dining-kitchen/handmade-dinnerware", "pottery", False),
    ("https://shop.gaatha.com/handmade-dining-kitchen/handmade-serveware", "pottery", False),
    ("https://shop.gaatha.com/home-decor/home-decor-clocks-plates-mirrors", "pottery", False),
    ("https://shop.gaatha.com/dining-kitchen/bottles-jugs-flasks", "pottery", False),
    ("https://shop.gaatha.com/home-decor/designer-handcrafted-furniture", "woodwork", False),
    ("https://shop.gaatha.com/home-decor/buy-handmade-centerpieces-figurines", "woodwork", False),
    ("https://shop.gaatha.com/dining-kitchen/baskets-jars-containers", "bamboo-cane", False),
    ("https://shop.gaatha.com/handmade-dining-kitchen/baskets-jars-containers", "bamboo-cane", False),
    ("https://shop.gaatha.com/home-decor/handmade-lamps-and-lampshades", "bamboo-cane", False),
    ("https://shop.gaatha.com/home-decor/wall-hangings", "other", True),
    ("https://shop.gaatha.com/home-decor/handmade-tealight-holders-candle-stands", "other", True),
    ("https://shop.gaatha.com/dining-kitchen/quirky-decoratives", "other", True),
    ("https://shop.gaatha.com/handmade-dining-kitchen/kitchen-tools", "other", True),
    ("https://shop.gaatha.com/more-to-love/handmade-ritual-essentials", "other", True),
    ("https://shop.gaatha.com/more-to-love/diy-craft-kits", "other", True),
    ("https://shop.gaatha.com/handcrafted-accessories-collection/accessories", "other", True),
]

EXCLUDE_KEYWORDS = [
    "brass", "metal", "iron", "leather", "paper mache", "papier mache", "painting",
    "resham", "zari", "brocade", "steel", "copper", "white metal",
]

MATERIAL_KEYWORDS = [
    ("jewelry", [
        "necklace", "earring", "payal", "anklet", "bangle", "bangles", "nose pin",
        "jhumka", "pendant necklace", "hair jewellery", "hair jewelry", "choker",
        "anguthi", "ring -", "toe ring",
    ]),
    ("textiles", [
        "saree", "sari", "fabric", "dupatta", "stole", "kurta", "ajrakh", "bandhani",
        "silk", "cotton", "linen", "shawl", "dhurrie", "dhurry", "rug", "carpet",
        "scarf", "scarves", "blouse", "dress material", "cushion cover", "blanket",
        "dohar", "towel", "bedsheet", "curtain",
    ]),
    ("pottery", [
        "terracotta", "ceramic", "pottery", "khurja", "earthen", "maati", "matki",
        "surahi", "clay",
    ]),
    ("woodwork", [
        "wood", "wooden", "sandalwood", "rosewood", "walnut", "teakwood", "teak wood",
        "channapatna", "etikoppaka", "carved wood", "woodwork",
    ]),
    ("bamboo-cane", [
        "bamboo", "cane ", "wicker", "rattan", "banboo", "moonj",
    ]),
]


COMBO_LISTING_MARKERS = ["dress material", "unstitched"]


def reclassify_by_material(title: str, fallback: str, trusted: bool) -> str:
    lowered = title.lower()

    if any(marker in lowered for marker in COMBO_LISTING_MARKERS):
        return "textiles"

    for category, keywords in MATERIAL_KEYWORDS:
        if any(keyword in lowered for keyword in keywords):
            return category

    if trusted and fallback in ("pottery", "woodwork", "bamboo-cane"):
        if any(keyword in lowered for keyword in EXCLUDE_KEYWORDS):
            return "other"
        return fallback

    return fallback if fallback in ("textiles", "jewelry") else "other"


session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})


def log(message: str) -> None:
    print(message, file=sys.stderr)


def fetch(url: str) -> str | None:
    try:
        response = session.get(url, timeout=20)
        if response.status_code != 200:
            log(f"skip {url}: status {response.status_code}")
            return None
        return response.text
    except requests.RequestException as error:
        log(f"skip {url}: {error}")
        return None
    finally:
        time.sleep(REQUEST_DELAY_SECONDS)


def scrape_itokri(max_pages: int) -> list[dict]:
    rows = []
    for page in range(1, max_pages + 1):
        url = f"https://itokri.com/products.json?limit=250&page={page}"
        body = fetch(url)
        if not body:
            break
        try:
            products = json.loads(body).get("products", [])
        except json.JSONDecodeError:
            break
        if not products:
            log(f"itokri: page {page} empty, stopping")
            break

        for product in products:
            category = ITOKRI_TYPE_TO_CATEGORY.get(product.get("product_type", "").lower())
            if not category:
                continue
            variant = (product.get("variants") or [{}])[0]
            price = variant.get("price")
            image = (product.get("images") or [{}])[0].get("src")
            if not price or float(price) <= 0:
                continue

            rows.append(
                {
                    "id": f"itokri-{product['id']}",
                    "title": product.get("title", ""),
                    "description": re.sub(r"<[^>]+>", " ", product.get("body_html") or "").strip(),
                    "price": float(price),
                    "currency": "INR",
                    "category": category,
                    "subcategory": product.get("product_type", "").lower(),
                    "has_gi_tag": False,
                    "source": "itokri",
                    "observed_date": TODAY,
                    "image_url": image,
                    "seed_trusted": True,
                }
            )
        log(f"itokri: page {page}, {len(products)} products, {len(rows)} kept so far")
    return rows


def parse_gaatha_page(html: str, category: str, trusted: bool) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    rows = []

    for tile in soup.select(".product-thumb"):
        link = tile.select_one(".name a")
        price_el = tile.select_one(".price .price-normal, .price span")
        image_el = tile.select_one("img")
        description_el = tile.select_one(".description")

        if not link or not price_el:
            continue

        price_match = re.search(r"(\d[\d,]*(?:\.\d+)?)", price_el.get_text())
        if not price_match:
            continue
        price = float(price_match.group(1).replace(",", ""))
        if price <= 0:
            continue

        href = link.get("href", "")
        product_id = href.rstrip("/").rsplit("/", 1)[-1]
        image_url = image_el.get("data-src") if image_el else None

        rows.append(
            {
                "id": f"gaatha-{product_id}",
                "title": link.get_text().strip(),
                "description": description_el.get_text().strip() if description_el else "",
                "price": price,
                "currency": "INR",
                "category": category,
                "subcategory": None,
                "has_gi_tag": False,
                "source": "gaatha",
                "observed_date": TODAY,
                "image_url": image_url,
                "seed_trusted": trusted,
            }
        )

    return rows


def scrape_gaatha(max_pages_per_seed: int) -> list[dict]:
    rows = []
    seen_ids = set()

    for seed_url, category, trusted in GAATHA_SEEDS:
        for page in range(1, max_pages_per_seed + 1):
            url = seed_url if page == 1 else f"{seed_url}?page={page}"
            html = fetch(url)
            if not html:
                break

            page_rows = parse_gaatha_page(html, category, trusted)
            if not page_rows:
                log(f"gaatha: {seed_url} page {page} had no products, stopping this seed")
                break

            new_rows = [row for row in page_rows if row["id"] not in seen_ids]
            for row in new_rows:
                seen_ids.add(row["id"])
            rows.extend(new_rows)
            log(f"gaatha: {seed_url} page {page}, {len(page_rows)} tiles, {len(new_rows)} new")

            if len(new_rows) == 0:
                break

    return rows


def main() -> int:
    itokri_rows = scrape_itokri(max_pages=20)
    gaatha_rows = scrape_gaatha(max_pages_per_seed=8)

    all_rows = itokri_rows + gaatha_rows
    reclassified = 0
    for row in all_rows:
        corrected = reclassify_by_material(row["title"], row["category"], row.pop("seed_trusted"))
        if corrected != row["category"]:
            reclassified += 1
            row["category"] = corrected

    log(f"reclassified {reclassified} of {len(all_rows)} rows by title material keywords")

    by_category: dict[str, int] = {}
    for row in all_rows:
        by_category[row["category"]] = by_category.get(row["category"], 0) + 1

    log(f"total rows: {len(all_rows)}")
    log(f"by category: {json.dumps(by_category, indent=2)}")

    payload = {
        "version": TODAY,
        "generated_by": "scripts/build_catalogue.py",
        "sources": ["itokri", "gaatha"],
        "listings": all_rows,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    log(f"wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
