# --- build the Go fetcher + share API ---
# glibc (not alpine/musl), and CGO enabled for the main build only: GPU
# coverage compute (internal/gpucompute, optional at runtime — see
# COVERAGE_GPU_MODE) links against wgpu-native's prebuilt static libs, which
# target glibc. The runtime stage below has to follow suit for the same
# reason.
FROM golang:1.23-bookworm AS build
# VERSION is passed by .github/workflows/release.yml as the git tag that
# triggered this build (e.g. v0.1.8) — "dev" (buildinfo's own default,
# unmistakable in the UI/analytics page) if built some other way, e.g.
# `docker compose up --build` locally with no --build-arg.
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=1 go build -ldflags "-X hopreach/internal/buildinfo.Version=${VERSION}" -o /app/hopreach ./cmd/hopreach \
  && CGO_ENABLED=0 go build -ldflags "-X hopreach/internal/buildinfo.Version=${VERSION}" -o /app/hopreach-shareapi ./cmd/hopreach-shareapi

# --- build the WASM module shared by the browser-side planning tools ---
# Compiles internal/propagation + internal/demgrid — the exact code the
# backend above trusts — to WebAssembly (see wasm/main.go), so the
# in-browser coverage preview/connect-repeaters/cover-an-area/LOS tools
# share one implementation instead of a hand-ported, independently
# drifting JS copy. wasm_exec.js (Go's own runtime shim) is copied from
# this same build stage so it's always paired with the Go version that
# actually compiled the module.
FROM golang:1.23-bookworm AS wasmbuild
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY wasm/ ./wasm/
COPY internal/ ./internal/
RUN GOOS=js GOARCH=wasm go build -o /out/hopreach.wasm ./wasm \
  && (cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js \
      || cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" /out/wasm_exec.js)

# --- runtime: nginx serves the static map, cron runs the daily fetch ---
# libvulkan1 + mesa-vulkan-drivers are only ever exercised if a Vulkan
# device is actually passed through (see docker-compose.yml's commented-out
# `devices:` block) — otherwise gpu.mode=auto's probe simply finds nothing
# and falls back to CPU, same as always. They're a modest image size cost
# either way, not a functional requirement.
FROM nginx:bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers cron curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/hopreach /app/hopreach
COPY --from=build /app/hopreach-shareapi /app/hopreach-shareapi
COPY public/ /usr/share/nginx/html/
COPY --from=wasmbuild /out/hopreach.wasm /usr/share/nginx/html/hopreach.wasm
COPY --from=wasmbuild /out/wasm_exec.js /usr/share/nginx/html/wasm_exec.js
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/default.conf.template /etc/nginx/conf.d/default.conf.template
COPY docker/config.docker.yaml /config/config.yaml
RUN chmod +x /entrypoint.sh /app/hopreach /app/hopreach-shareapi \
  && mkdir -p /data/dem-cache /data/shared-plans /var/cache/nginx/dem-tiles \
  && chown -R nginx:nginx /var/cache/nginx/dem-tiles

# The only environment variable HopReach's own binaries read — everything
# else lives in config.yaml (see /config/config.yaml, baked in above from
# docker/config.docker.yaml; mount your own file over the same path to
# override it — see docker-compose.yml).
ENV HOPREACH_CONFIG=/config/config.yaml

VOLUME ["/data/dem-cache", "/data/shared-plans"]
EXPOSE 80

# nginx starts immediately at container boot (see docker/entrypoint.sh) and
# is healthy as soon as it's serving, independent of whether the first
# coverage run — which can take well over an hour — has finished yet. Checks
# nginx itself, not the coverage data, deliberately.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1/ -o /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
