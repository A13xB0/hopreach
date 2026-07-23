# Remote GPU worker — runs on a machine that actually has a GPU (this
# project's own dev/test box, for instance), not the VPS. Connects out to
# the VPS's broker (cmd/hopreach-shareapi's gpubroker routes) over WebSocket; see
# cmd/hopreach-gpuworker/main.go and README.md's "Remote GPU worker" section.
#
# Same glibc + CGO story as the main Dockerfile: gpucompute links against
# wgpu-native's prebuilt static libs, which target glibc, so both build and
# runtime stages have to follow suit.
FROM golang:1.23-bookworm AS build
# VERSION is passed by .github/workflows/release.yml as the git tag that
# triggered this build — see the main Dockerfile's own ARG VERSION comment.
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal/ ./internal/
COPY cmd/hopreach-gpuworker/ ./cmd/hopreach-gpuworker/
RUN CGO_ENABLED=1 go build -ldflags "-X hopreach/internal/buildinfo.Version=${VERSION}" -o /app/hopreach-gpuworker ./cmd/hopreach-gpuworker

# --- runtime: just the worker binary, needs real GPU/Vulkan access ---
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libvulkan1 mesa-vulkan-drivers \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/hopreach-gpuworker /app/hopreach-gpuworker
RUN chmod +x /app/hopreach-gpuworker && mkdir -p /data/dem-cache

ENV GPU_BROKER_WS_URL= \
    GPU_WORKER_TOKEN= \
    DEM_TILE_URL_BASE=https://s3.amazonaws.com/elevation-tiles-prod/terrarium \
    DEM_CACHE_DIR=/data/dem-cache \
    GPU_WORKER_RECONNECT_SECONDS=10

VOLUME ["/data/dem-cache"]
ENTRYPOINT ["/app/hopreach-gpuworker"]
