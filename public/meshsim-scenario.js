// The handful of meshsim model constants and scenario-shaping helpers that
// more than one part of the frontend needs: the Simulate panel builds whole
// scenarios from them, and the planner's connect-repeaters search uses them
// to check a proposed route with the same engine rather than a second,
// slightly-different idea of what "a link" is.
//
// These are the values that genuinely can't come from the WASM core — the
// physics itself is shared bit-for-bit with the server (see wasm/main.go
// and wasm/meshsim.go), but the *defaults a new node starts with* and the
// SNR thresholds used to turn a propagation margin into a link SNR are
// frontend-side scenario construction. They were previously written out
// once inside simulator.js; a second copy in the planner worker is exactly
// the kind of quiet divergence the shared WASM core exists to avoid, so
// there's one copy here and both callers reference it.
//
// Hangs off `self` so it works unchanged in the main thread and in a Web
// Worker — same reasoning as terrain.js's header comment.
(function () {
  // SF7..SF12 demodulation thresholds, mirrors internal/meshsim/score.go.
  const SF_THRESHOLDS_DB = [-7.5, -10, -12.5, -15, -17.5, -20];

  // Per-link channel noise. Modest, LoRa-appropriate values: comfortably
  // strong links stay ~100% reliable (see the Go test
  // TestChannelSigmoidLeavesStrongLinksReliable), while a marginal one
  // genuinely varies between Monte-Carlo trials instead of returning an
  // identical, over-confident answer every time. That variation is what
  // makes running several seeded trials meaningful rather than theatre.
  const CHANNEL_PER_WIDTH_DB = 2.0;
  const CHANNEL_FADING_SIGMA_DB = 2.0;

  self.HopReachMeshModel = {
    SF_THRESHOLDS_DB,
    CHANNEL_PER_WIDTH_DB,
    CHANNEL_FADING_SIGMA_DB,

    channel() {
      return { perWidthDb: CHANNEL_PER_WIDTH_DB, fadingSigmaDb: CHANNEL_FADING_SIGMA_DB };
    },

    // Mirrors internal/meshsim.DefaultNodePrefs — kept in sync manually
    // since this is plain JS, not generated from the Go struct. Radio
    // defaults to the EU/UK (Narrow) preset; preamble length isn't a field
    // at all, because real firmware derives it from SF alone (see
    // preambleSymbolsForSF in Go), so it's never independently configurable
    // here either.
    defaultPrefs() {
      return {
        txDelayFactor: 0.5,
        directTxDelayFactor: 0.3,
        rxDelayBase: 0,
        txPowerDbm: 22,
        radio: { freqMhz: 869.618, bwKhz: 62.5, sf: 8, cr: 8, explicitHeader: true, crcEnabled: true },
      };
    },

    // A propagation margin is dB above the receiver's own demodulation
    // threshold, so the corresponding SNR is that threshold plus the
    // margin. Approximate by construction (the propagation model reports a
    // link budget, not a measured SNR) and documented as such wherever
    // it's surfaced.
    approxSnrFromMargin(marginDb, sf) {
      const idx = Math.min(Math.max(sf - 7, 0), 5);
      return SF_THRESHOLDS_DB[idx] + marginDb;
    },

    // One reception counts as this node actually getting the packet.
    // Mirrored by isCanonicalDelivery in internal/meshsim/report.go, whose
    // comment points back at the frontend copy — with two consumers on
    // this side now (the Simulate panel's own results and the planner's
    // route check) there's one JS copy here rather than two.
    isCanonicalDelivery(r) {
      return !r.collided && r.dropReason !== "weak_signal" && r.dropReason !== "tx_busy" && r.dropReason !== "already_seen";
    },
  };
})();
