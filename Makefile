.PHONY: lint format test serve

lint:
	uv run ruff check .

format:
	uv run ruff format .

test:
	uv run pytest

serve:
	uv run uvicorn --factory optionality.service.app:create_app --host 0.0.0.0 --port 8000
