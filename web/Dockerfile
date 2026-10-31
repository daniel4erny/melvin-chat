# syntax=docker/dockerfile:1.7
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# ---- 1. deps ----
FROM base AS deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- 2. build the React app ----
FROM deps AS build
COPY tsconfig.json tsconfig.app.json tsconfig.server.json vite.config.ts index.html vite-env.d.ts main.ts ./
COPY src/ src/
COPY public/ public/
RUN bun run build

# ---- 3. runtime: static server + API/WS proxy ----
FROM base AS release
ENV NODE_ENV=production
COPY --from=deps /usr/src/app/node_modules node_modules
COPY main.ts package.json ./
COPY --from=build /usr/src/app/dist dist/

USER bun
EXPOSE 8000/tcp
ENTRYPOINT ["bun", "run", "main.ts"]
