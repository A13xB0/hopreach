// Constants shared across the simulator's modules.
//
// These used to sit wherever they were first needed, so one feature module
// ended up handing another a value through init(). That is a load-order trap:
// `const { RADIO_PRESETS } = window.SimRun.init(...)` is a temporal dead zone
// for any module wired up before SimRun, and it fails as a page-wide crash
// rather than as one broken feature.
//
// A constant two modules need belongs to neither of them.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimConstants = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SIM_MAX_RANGE_KM = 35; // same rationale as planner.js's PREVIEW_MAX_RANGE_KM
  const SIM_ZOOM_CAP = 11;
  const CORESCOPE_REACH_DAYS = 7; // fixed window — simulator.js has no window-selector UI of its own (see planner.js's for the map's own hover tooltips)

  // Mirrors internal/meshsim's own defaultMessageHashSize (engine.go) — a
  // sender with no explicit hash size falls back to this. 3 bytes,
  // deliberately diverging from real firmware (which has no built-in
  // default; every real sendFlood caller passes one explicitly) to
  // minimise hash collisions between unrelated repeaters by default.
  const DEFAULT_MESSAGE_HASH_SIZE = 3;

  const SOURCE_BADGE = { planned: "sim-badge-planned", real: "sim-badge-real", companion: "sim-badge-companion" };

  const SIM_TIER_STORAGE_KEY = "hopreach.simTier";

  // Deliberate divergence from real firmware, which defaults loop.detect
  // to off (docs.meshcore.io/cli_commands) — a simulator run with loop
  // detect entirely disabled by default doesn't surface the
  // loop-suppression behaviour most real deployments actually want to
  // reason about. Explicitly selecting "off" in the settings table still
  // means off; this only governs a node with no explicit choice made yet.
  // internal/meshsim's own
  // loopDetectThreshold is NOT changed to match — an empty LoopDetect
  // there must keep meaning "never triggers" so an explicit "off" set
  // from here is honoured, not silently upgraded.
  const DEFAULT_LOOP_DETECT = "minimal";

  // Baked in from https://api.meshcore.nz/api/v1/config
  // (config.suggested_radio_settings.entries) — the live list the official
  // MeshCore app itself offers, also mirrored at
  // https://forum.letsmesh.net/t/meshcore-radio-setting-presets/67. Baked in
  // rather than fetched at runtime so the tool works offline and doesn't
  // depend on a CORS proxy; re-run the same fetch to refresh this list if
  // upstream adds/changes entries. "EU/UK (Narrow)" (index 6) is the
  // simulator's own default — see defaultPrefs().
  const RADIO_PRESETS = [
    { label: 'Australia', freqMhz: 915.8, bwKhz: 250.0, sf: 10, cr: 5 },
    { label: 'Australia (Narrow)', freqMhz: 916.575, bwKhz: 62.5, sf: 7, cr: 8 },
    { label: 'Australia (Mid)', freqMhz: 915.075, bwKhz: 125.0, sf: 9, cr: 5 },
    { label: 'Australia: SA, WA', freqMhz: 923.125, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'Australia: QLD', freqMhz: 923.125, bwKhz: 62.5, sf: 8, cr: 5 },
    { label: 'Brazil', freqMhz: 923.125, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'EU/UK (Narrow)', freqMhz: 869.618, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'EU/UK (Deprecated)', freqMhz: 869.525, bwKhz: 250.0, sf: 11, cr: 5 },
    { label: 'Czech Republic (Narrow)', freqMhz: 869.432, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'EU 433MHz (Long Range)', freqMhz: 433.65, bwKhz: 250.0, sf: 11, cr: 5 },
    { label: 'EU 433MHz (Narrow)', freqMhz: 433.65, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'Netherlands', freqMhz: 869.618, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'New Zealand', freqMhz: 917.375, bwKhz: 250.0, sf: 11, cr: 5 },
    { label: 'New Zealand (Narrow)', freqMhz: 917.375, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'Portugal 433', freqMhz: 433.375, bwKhz: 62.5, sf: 9, cr: 6 },
    { label: 'Portugal 868', freqMhz: 869.618, bwKhz: 62.5, sf: 7, cr: 6 },
    { label: 'Switzerland', freqMhz: 869.618, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'USA/Canada (Recommended)', freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'Vietnam (Narrow)', freqMhz: 920.25, bwKhz: 62.5, sf: 8, cr: 5 },
    { label: 'Vietnam (Deprecated)', freqMhz: 920.25, bwKhz: 250.0, sf: 11, cr: 5 },
  ];

  // A run can produce thousands of receptions (5,256 measured on a dense
  // 73-node scenario) — rendering every row up front is what made the
  // reception log and the packet inspector's activity list slow to scroll
  // and hard to scan. Both cap their initial render to this many rows and
  // offer a "Show all N" control instead (item 10E).
  const LONG_LIST_ROW_CAP = 200;

  return {
    SIM_MAX_RANGE_KM,
    SIM_ZOOM_CAP,
    CORESCOPE_REACH_DAYS,
    DEFAULT_MESSAGE_HASH_SIZE,
    SOURCE_BADGE,
    SIM_TIER_STORAGE_KEY,
    DEFAULT_LOOP_DETECT,
    RADIO_PRESETS,
    LONG_LIST_ROW_CAP,
  };
});
