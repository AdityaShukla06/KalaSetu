import gc
import io
import os
from contextlib import asynccontextmanager

import numpy as np
import onnxruntime
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image

MODEL_PATH = os.environ.get("MODEL_PATH", "u2netp.onnx")
INPUT_SIZE = 320
MAX_DIMENSION = int(os.environ.get("MAX_DIMENSION", "1600"))
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

session: onnxruntime.InferenceSession | None = None


def build_session(model_path: str) -> onnxruntime.InferenceSession:
    options = onnxruntime.SessionOptions()
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    return onnxruntime.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    global session
    session = build_session(MODEL_PATH)
    yield


app = FastAPI(title="KalaSetu Background Removal Service", lifespan=lifespan)


@app.get("/")
def health() -> dict:
    return {"status": "online", "service": "kalasetu-bg-removal", "model": "u2netp"}


def fit_within(image: Image.Image, max_dimension: int) -> Image.Image:
    if max(image.size) <= max_dimension:
        return image
    ratio = max_dimension / max(image.size)
    target = (max(1, round(image.width * ratio)), max(1, round(image.height * ratio)))
    return image.resize(target, Image.LANCZOS)


def preprocess(image: Image.Image) -> np.ndarray:
    resized = image.resize((INPUT_SIZE, INPUT_SIZE), Image.LANCZOS)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - MEAN) / STD
    array = array.transpose(2, 0, 1)
    return np.expand_dims(array, axis=0).astype(np.float32)


def postprocess_mask(raw_output: np.ndarray, original_size: tuple[int, int]) -> Image.Image:
    mask = raw_output[0, 0]
    mask_min, mask_max = mask.min(), mask.max()
    if mask_max - mask_min > 1e-6:
        mask = (mask - mask_min) / (mask_max - mask_min)
    else:
        mask = np.zeros_like(mask)

    mask_image = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    return mask_image.resize(original_size, Image.LANCZOS)


@app.post("/remove-background")
async def remove_background(file: UploadFile = File(...)) -> Response:
    if session is None:
        raise HTTPException(status_code=503, detail="model_not_loaded")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty_file")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file_too_large")

    try:
        original = fit_within(Image.open(io.BytesIO(raw)).convert("RGB"), MAX_DIMENSION)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="unsupported_image") from exc

    try:
        input_tensor = preprocess(original)
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name
        result = session.run([output_name], {input_name: input_tensor})[0]

        alpha = postprocess_mask(result, original.size)

        cutout = Image.new("RGBA", original.size)
        cutout.paste(original, (0, 0))
        cutout.putalpha(alpha)

        buffer = io.BytesIO()
        cutout.save(buffer, format="PNG")
        payload = buffer.getvalue()
    finally:
        gc.collect()

    return Response(content=payload, media_type="image/png")
