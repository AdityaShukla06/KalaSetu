FROM python:3.12-slim

WORKDIR /app

ENV HF_HOME=/app/.cache/huggingface
ENV PRICING_CATALOGUE=/app/data/catalogue.json

COPY requirements.txt requirements-model.txt ./

RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install --no-cache-dir sentence-transformers

COPY . .

RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('clip-ViT-B-32'); \
    SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')"

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
