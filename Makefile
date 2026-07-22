.PHONY: wasm

# Builds the browser-side WASM module (see wasm/main.go) and copies the Go
# toolchain's own wasm_exec.js runtime shim alongside it — both are
# generated artifacts (not committed; see .gitignore) needed for local
# development without Docker. The Docker image builds these itself as part
# of its normal build stage instead of using this target.
wasm:
	GOOS=js GOARCH=wasm go build -o public/hopreach.wasm ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" public/wasm_exec.js
