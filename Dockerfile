# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=web-builder /src/internal/webui/dist/ ./internal/webui/dist/
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/celery-web-speak ./cmd/server

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata && addgroup -S celery && adduser -S -G celery celery
WORKDIR /app
COPY --from=go-builder --chown=celery:celery /out/celery-web-speak /app/celery-web-speak
RUN mkdir -p /data && chown celery:celery /data
USER celery
ENV ADDR=:8080 \
    DATABASE_PATH=/data/celery.db
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/app/celery-web-speak"]
