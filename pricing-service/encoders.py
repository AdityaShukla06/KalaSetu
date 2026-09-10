import os
import threading

import numpy as np

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

IMAGE_MODEL = os.environ.get("PRICING_IMAGE_MODEL", "clip-ViT-B-32")
TEXT_MODEL = os.environ.get("PRICING_TEXT_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")
FUSION_ALPHA = float(os.environ.get("PRICING_FUSION_ALPHA", "0.5"))

IMAGE_DIM = 512
TEXT_DIM = 384
FUSED_DIM = IMAGE_DIM + TEXT_DIM

_lock = threading.Lock()
_image_model = None
_text_model = None
_load_error: str | None = None


def _load_models() -> bool:
    global _image_model, _text_model, _load_error

    if _image_model is not None and _text_model is not None:
        return True
    if _load_error is not None:
        return False

    with _lock:
        if _image_model is not None and _text_model is not None:
            return True
        if _load_error is not None:
            return False
        try:
            from sentence_transformers import SentenceTransformer

            _image_model = SentenceTransformer(IMAGE_MODEL)
            _text_model = SentenceTransformer(TEXT_MODEL)
            return True
        except Exception as error:
            _load_error = str(error)
            return False


def available() -> bool:
    return _load_models()


def load_error() -> str | None:
    return _load_error


def _normalise(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    if norm == 0:
        return vector
    return vector / norm


def embed_image(image) -> np.ndarray:
    if image is None or not _load_models():
        return np.zeros(IMAGE_DIM, dtype=np.float32)
    vector = _image_model.encode(image, convert_to_numpy=True).astype(np.float32)
    return _normalise(vector)


def embed_text(text: str | None) -> np.ndarray:
    if not text or not text.strip() or not _load_models():
        return np.zeros(TEXT_DIM, dtype=np.float32)
    vector = _text_model.encode(text.strip(), convert_to_numpy=True).astype(np.float32)
    return _normalise(vector)


def fuse(image_vector: np.ndarray, text_vector: np.ndarray) -> np.ndarray:
    combined = np.concatenate(
        [FUSION_ALPHA * image_vector, (1 - FUSION_ALPHA) * text_vector]
    ).astype(np.float32)
    return _normalise(combined)


def embed_query(image, description: str | None, mode: str = "fused") -> np.ndarray:
    if mode == "text":
        parts = [part for part in [description] if part]
        return fuse(np.zeros(IMAGE_DIM, dtype=np.float32), embed_text(" ".join(parts)))
    return fuse(embed_image(image), embed_text(description))
