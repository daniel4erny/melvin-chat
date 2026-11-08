# syntax=docker/dockerfile:1.7
#
# Bun's default x86_64 binary needs AVX2. On older CPUs (or VMs that do not
# pass AVX2 through) it dies with SIGILL / exit code 132, which makes
# `bun run build` fail inside the container. We try to replace the bundled
# bun with the baseline build on amd64 (and standard on arm64). If the
# download fails (e.g. transient GitHub error/rate limit), fall back to the
# bun shipped in the image — fine on AVX2 hosts.
ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION} AS base
ARG BUN_VERSION
WORKDIR /usr/src/app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    rm -rf /var/lib/apt/lists/*; \
    case "$(uname -m)" in \
      x86_64) asset="bun-linux-x64-baseline.zip" ;; \
      aarch64) asset="bun-linux-aarch64.zip" ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}"; \
    if curl -fsSL --retry 3 --retry-delay 2 -o /tmp/bun.zip "$url"; then \
      unzip -q /tmp/bun.zip -d /tmp; \
      install -m 0755 /tmp/bun-linux-*/bun /usr/local/bin/bun; \
      rm -rf /tmp/bun*; \
      echo "installed $asset"; \
    else \
      echo "warning: failed to download $url; using bun from base image"; \
      rm -f /tmp/bun.zip; \
    fi; \
    bun --version

# ---- 1. deps ----
FROM base AS deps
WORKDIR /usr/src/app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- 2. build the React app ----
FROM deps AS build
WORKDIR /usr/src/app
COPY tsconfig.json tsconfig.app.json tsconfig.server.json vite.config.ts index.html vite-env.d.ts main.ts ./
COPY src/ src/
COPY public/ public/
RUN bun run build

# ---- 3. runtime: static server + API/WS proxy ----
FROM base AS release
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY --from=deps /usr/src/app/node_modules node_modules
COPY main.ts package.json ./
COPY --from=build /usr/src/app/dist dist/

USER bun
EXPOSE 8000/tcp
ENTRYPOINT ["bun", "run", "main.ts"]
