# Build openclaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22-bookworm AS openclaw-build

# Dependencies needed for openclaw build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (openclaw build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /openclaw

# Pin to a known ref (tag/branch). If it doesn't exist, fall back to main.
ARG OPENCLAW_GIT_REF=main
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Gmail webhook automation depends on gog CLI (`gog` binary).
# Download the latest gogcli release artifact for container architecture.
RUN set -eux; \
  ARCH="$(dpkg --print-architecture)"; \
  case "$ARCH" in \
    amd64) GOG_ARCH="amd64" ;; \
    arm64) GOG_ARCH="arm64" ;; \
    *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; \
  esac; \
  TAG="$(curl -fsSL https://api.github.com/repos/steipete/gogcli/releases/latest | grep '\"tag_name\"' | head -n1 | sed -E 's/.*\"([^\"]+)\".*/\1/')"; \
  VER="${TAG#v}"; \
  URL="https://github.com/steipete/gogcli/releases/download/${TAG}/gogcli_${VER}_linux_${GOG_ARCH}.tar.gz"; \
  curl -fsSL "$URL" | tar -xz -C /usr/local/bin; \
  chmod +x /usr/local/bin/gog

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built openclaw
COPY --from=openclaw-build /openclaw /openclaw

# Provide an openclaw executable.
# Also persist gog CLI state on /data so OAuth/watch survives redeploys.
RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'PERSIST_GOG_DIR="/data/.openclaw/gogcli"' \
  'GOG_CONFIG_DIR="/root/.config/gogcli"' \
  'mkdir -p "$PERSIST_GOG_DIR" /root/.config' \
  'if [ -d "$GOG_CONFIG_DIR" ] && [ ! -L "$GOG_CONFIG_DIR" ]; then' \
  '  cp -a "$GOG_CONFIG_DIR"/. "$PERSIST_GOG_DIR"/ 2>/dev/null || true' \
  '  rm -rf "$GOG_CONFIG_DIR"' \
  'fi' \
  'ln -sfn "$PERSIST_GOG_DIR" "$GOG_CONFIG_DIR"' \
  'if [ -f /data/.openclaw/gog-credentials.json ] && [ ! -f "$GOG_CONFIG_DIR/credentials.json" ]; then' \
  '  cp /data/.openclaw/gog-credentials.json "$GOG_CONFIG_DIR/credentials.json"' \
  'fi' \
  'exec node /openclaw/dist/entry.js "$@"' \
  > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src

# The wrapper listens on this port.
ENV PORT=8080
EXPOSE 8080

# Boot script: ensure gog config/token directory is persisted under /data.
RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'PERSIST_GOG_DIR="/data/.openclaw/gogcli"' \
  'GOG_CONFIG_DIR="/root/.config/gogcli"' \
  'mkdir -p "$PERSIST_GOG_DIR" /root/.config' \
  'if [ -d "$GOG_CONFIG_DIR" ] && [ ! -L "$GOG_CONFIG_DIR" ]; then' \
  '  cp -a "$GOG_CONFIG_DIR"/. "$PERSIST_GOG_DIR"/ 2>/dev/null || true' \
  '  rm -rf "$GOG_CONFIG_DIR"' \
  'fi' \
  'ln -sfn "$PERSIST_GOG_DIR" "$GOG_CONFIG_DIR"' \
  'if [ -f /data/.openclaw/gog-credentials.json ] && [ ! -f "$GOG_CONFIG_DIR/credentials.json" ]; then' \
  '  cp /data/.openclaw/gog-credentials.json "$GOG_CONFIG_DIR/credentials.json"' \
  'fi' \
  'exec node src/server.js' \
  > /usr/local/bin/container-start \
  && chmod +x /usr/local/bin/container-start

CMD ["/usr/local/bin/container-start"]
