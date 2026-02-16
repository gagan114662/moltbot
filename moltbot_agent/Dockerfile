# syntax=docker/dockerfile:1.3
#
# RUNTIME REQUIREMENTS for bubblewrap sandboxing:
#   - When running in gVisor (GKE Sandbox / minikube with gVisor addon):
#       No special capabilities needed - gVisor handles syscall isolation
#   - When running in standard Docker/containerd:
#       docker run --cap-add=SYS_ADMIN ...
#
# bubblewrap is used instead of nsjail because nsjail requires prctl(PR_SET_SECUREBITS)
# which gVisor hasn't implemented. bubblewrap provides equivalent filesystem isolation.
#
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.6.4 /uv /uvx /bin/

# Install system dependencies (cached via BuildKit)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    curl \
    tar \
    netcat-openbsd \
    bubblewrap \
    nodejs \
    npm \
    # Chromium/Playwright system dependencies
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libglib2.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxext6 \
    libxi6 \
    libxtst6 \
    fonts-liberation \
    xdg-utils \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Playwright + Chromium browser
RUN npm install -g playwright && npx playwright install chromium

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --upgrade pip setuptools wheel

ENV UV_HTTP_TIMEOUT=1000

COPY moltbot_agent/pyproject.toml /app/moltbot_agent/pyproject.toml
RUN mkdir -p /app/moltbot_agent/src && touch /app/moltbot_agent/src/__init__.py

WORKDIR /app/moltbot_agent

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system .

COPY moltbot_agent/src /app/moltbot_agent/src
COPY moltbot_agent/config.yaml /app/moltbot_agent/config.yaml

ENV PYTHONPATH=/app
ENTRYPOINT ["uvicorn", "src.agent:server", "--host", "0.0.0.0"]