FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN curl -fL -o u2netp.onnx \
    https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx

COPY main.py .

ENV MODEL_PATH=/app/u2netp.onnx
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
