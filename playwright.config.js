// @ts-check
const { defineConfig, devices } = require("@playwright/test");

// End-to-end coverage for the frontend's interactive tools (planning,
// simulator) against a real running container — not mocks, since the whole
// point is exercising the real WASM module, the real nginx/proxy routes,
// and the real CoreScope fetch, the same way a user actually hits them.
// Deliberately does NOT wait for a full coverage compute pass to finish
// (that's minutes-to-hours depending on GPU/CPU and region size, covered
// instead by internal/compute and internal/coverage's own Go tests, plus
// the WASM/backend parity guarantee of compiling the exact same
// internal/propagation code twice) — only page load, repeater data being
// present, and the client-side WASM tools.
module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Assumes the image is already built (`docker compose build` — CI does
    // this as its own prior step so build failures show up distinctly from
    // test failures; local runs can rely on Compose building it on first
    // `up` if `hopreach:latest` doesn't exist yet).
    command: "docker compose up",
    url: "http://127.0.0.1:8080",
    // Local dev: reuse whatever's already running (matches this project's
    // usual local-testing flow — see README's "Local development"). CI:
    // always start fresh.
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
