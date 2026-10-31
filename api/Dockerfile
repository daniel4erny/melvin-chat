# syntax=docker/dockerfile:1.7
FROM golang:alpine AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /server .

# only the compiled binary, no go toolchain
FROM alpine

RUN apk add --no-cache ca-certificates wget \
    && addgroup -g 10001 -S melvin \
    && adduser -u 10001 -S -G melvin -H melvin \
    && mkdir -p /data/uploads \
    && chown -R melvin:melvin /data

COPY --from=build /server /server

USER melvin
ENV DB_PATH=/data/melvin.db \
    UPLOAD_DIR=/data/uploads \
    MAX_UPLOAD_MB=500

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:8000/healthz || exit 1

CMD ["/server"]
