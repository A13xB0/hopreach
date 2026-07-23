// Package buildinfo holds the version string every hopreach binary reports
// (meta.json, the analytics page, worker logs) — one shared var rather than
// a separate copy per binary, so cmd/hopreach, cmd/hopreach-shareapi, and
// cmd/hopreach-gpuworker always agree on how to report it even though
// they're built as separate Docker images from separate release artifacts.
package buildinfo

// Version is set at build time via -ldflags "-X
// hopreach/internal/buildinfo.Version=vX.Y.Z" (see Dockerfile/
// docker/gpuworker.Dockerfile and .github/workflows/release.yml, which
// passes the git tag that triggered the build). "dev" is the
// unmistakable-in-the-UI default for a local `go build`/`go run` with no
// such flag, e.g. during development — never a real release's own value,
// so it can't be silently confused for one.
var Version = "dev"
