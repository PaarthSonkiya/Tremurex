FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

COPY proxy_addon ./proxy_addon
COPY addon.py ./

# mitmproxy's proxy listener; the generated CA lives in /certs (a volume) so
# the user can install it on the machine whose traffic is being captured.
EXPOSE 8080
CMD ["uv", "run", "--frozen", "--no-dev", "mitmdump", \
     "--set", "confdir=/certs", \
     "--listen-host", "0.0.0.0", "--listen-port", "8080", \
     "-s", "addon.py"]
