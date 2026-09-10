import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np

import encoders
from catalogue import _validate


def load_local_images(rows: list[dict], image_dir: Path) -> dict:
    from PIL import Image, UnidentifiedImageError

    images: dict[str, object] = {}
    missing = 0

    for row in rows:
        found = None
        for suffix in (".jpg", ".jpeg", ".png", ".webp"):
            candidate = image_dir / f"{row['id']}{suffix}"
            if candidate.exists():
                found = candidate
                break
        if found is None:
            missing += 1
            continue
        try:
            with open(found, "rb") as handle:
                image = Image.open(io.BytesIO(handle.read()))
                image.load()
                images[row["id"]] = image.convert("RGB")
        except (UnidentifiedImageError, OSError):
            missing += 1

    if missing:
        print(f"warning: {missing} of {len(rows)} rows had no readable local image", file=sys.stderr)

    return images


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Embed a pricing catalogue so the service can retrieve comparables."
    )
    parser.add_argument("catalogue", type=Path, help="path to catalogue.json")
    parser.add_argument(
        "--image-dir",
        type=Path,
        default=None,
        help="directory of listing images named <id>.jpg, enables fused image and text embeddings",
    )
    args = parser.parse_args()

    if not args.catalogue.exists():
        print(f"error: {args.catalogue} does not exist", file=sys.stderr)
        return 1

    with open(args.catalogue, encoding="utf-8") as handle:
        payload = json.load(handle)

    rows, rejected = _validate(payload.get("listings", []))
    if not rows:
        print("error: no usable rows in the catalogue", file=sys.stderr)
        return 1

    print(f"kept {len(rows)} rows, dropped {rejected}")

    if not encoders.available():
        print(f"error: encoders unavailable: {encoders.load_error()}", file=sys.stderr)
        print("install them with: pip install -r requirements-model.txt", file=sys.stderr)
        return 1

    images = None
    mode = "text"
    if args.image_dir:
        images = load_local_images(rows, args.image_dir)
        if images:
            mode = "fused"

    from catalogue import build_embeddings

    vectors = build_embeddings(rows, images)

    embeddings_path = args.catalogue.with_suffix(".embeddings.npy")
    mode_path = args.catalogue.with_suffix(".embeddings.mode")
    np.save(embeddings_path, vectors)
    mode_path.write_text(mode, encoding="utf-8")

    print(f"wrote {embeddings_path} in {mode} mode")
    if mode == "text":
        print(
            "note: no images were embedded, so queries will be matched on text alone. "
            "Pass --image-dir with downloaded listing images to use both signals."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
