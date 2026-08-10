FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY . .
RUN uv sync --frozen --no-dev

ENV OPTIONALITY_DB_PATH=/app/data/optionality.db

EXPOSE 8000

CMD ["uv", "run", "--no-dev", "uvicorn", "--factory", "optionality.service.app:create_app", "--host", "0.0.0.0", "--port", "8000"]
