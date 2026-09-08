import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def make_sample_image() -> bytes:
    array = np.zeros((200, 300, 3), dtype=np.uint8)
    array[:, :150] = [200, 120, 60]
    array[:, 150:] = [30, 30, 30]
    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_health(client: TestClient):
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "online"


def test_remove_background_returns_rgba_png_with_real_alpha(client: TestClient):
    response = client.post(
        "/remove-background",
        files={"file": ("sample.jpg", make_sample_image(), "image/jpeg")},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"

    result = Image.open(io.BytesIO(response.content))
    assert result.mode == "RGBA"
    assert result.size == (300, 200)

    alpha_values = np.array(result.getchannel("A"))
    assert alpha_values.min() < 255, "expected some transparency in the cutout"
    assert alpha_values.max() > 0, "expected some opacity in the cutout"


def test_remove_background_rejects_empty_file(client: TestClient):
    response = client.post(
        "/remove-background",
        files={"file": ("empty.jpg", b"", "image/jpeg")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "empty_file"


def test_remove_background_rejects_garbage_data(client: TestClient):
    response = client.post(
        "/remove-background",
        files={"file": ("garbage.jpg", b"not an image", "image/jpeg")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "unsupported_image"
