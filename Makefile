.PHONY: lint format

lint:
	uv run ruff check .

format:
	uv run ruff format .
