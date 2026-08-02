// The shared replay transport: one play/seek/scrub bar driving both the simulated flood and the real-packet replay, plus the wave animation and the growing success markers it drives.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimTransport = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let growthMarkers, redrawResultLines, setReplayStatus, simResultsLayer, simViewMode, updateMapLiveStats;

  // --- animated flood replay ---------------------------------------------
  //
  // Receptions sharing the same (fromNode, packetId, atMs) are exactly the
  // set of listeners a single over-the-air transmission reached — the
  // engine schedules every listener's eventRxComplete at the identical
  // instant (send time + airtime), see engine.go's eventSend handling — so
  // grouping on that triple recovers each individual transmission
  // ("wave") without needing the backend to expose send times or airtime
  // directly. Waves are played back in order with a expanding/fading
  // pulse at the sender and lines drawn to each listener as it arrives,
  // instead of dumping the whole result on the map at once — this is what
  // actually answers "watch the flood happen," not just "here's the
  // final tally."

  // --- shared replay transport -------------------------------------------
  //
  // One play/pause/seek bar drives BOTH replays (the simulated flood and the
  // real-packet window), because they're the same interaction: step a clock
  // through a sorted list of timestamped events and draw the world as it was
  // at that instant. They used to be two separate fire-and-forget setTimeout
  // chains with no way to pause, rewind, or scrub — you got one pass at
  // whatever speed the code chose, and if you blinked you re-ran it.
  //
  // Time is warped, not linear. Real mesh traffic is mostly dead air (a ±60s
  // CoreScope window can hold three packets), and a simulated flood is the
  // opposite — bursts of near-simultaneous waves separated by relay delays.
  // Playing either at 1:1 wall-clock is unwatchable in different directions.
  // buildTimeWarp maps *source* time (real ms, what the readout shows, what
  // renderers get) onto *play* time (what the scrubber moves through, gaps
  // clamped into a watchable range). Seeking stays correct in both
  // directions because the mapping is a proper invertible piecewise-linear
  // function rather than an ad-hoc per-step delay.
  const TRANSPORT_GAP_CAP_MS = 1500; // longest stretch of dead air we'll actually sit through
  const TRANSPORT_MIN_STEP_MS = 120; // shortest, so a burst doesn't flash past unwatchably

  function buildTimeWarp(times) {
    const uniq = [];
    for (const t of times) {
      if (!Number.isFinite(t)) continue;
      if (!uniq.length || t !== uniq[uniq.length - 1]) uniq.push(t);
    }
    // A lead-in instant one millisecond before the first event, so play
    // position 0 means "nothing has happened yet" and the replay starts from
    // an empty map. Without it the scrubber's zero sat exactly ON the first
    // event, and since CoreScope timestamps a whole observation to the
    // second, that could be a dozen hops already drawn before you'd pressed
    // play — which reads as the replay being broken rather than as a
    // simultaneous burst.
    if (uniq.length > 0) uniq.unshift(uniq[0] - 1);
    const segs = [];
    let play = 0;
    for (let i = 1; i < uniq.length; i++) {
      const gap = uniq[i] - uniq[i - 1];
      const played = Math.min(TRANSPORT_GAP_CAP_MS, Math.max(TRANSPORT_MIN_STEP_MS, gap));
      segs.push({ srcStart: uniq[i - 1], srcEnd: uniq[i], playStart: play, playEnd: play + played });
      play += played;
    }
    return {
      segs,
      durationPlayMs: play,
      srcFirst: uniq.length ? uniq[0] : 0,
      srcLast: uniq.length ? uniq[uniq.length - 1] : 0,
    };
  }

  // Play time -> source time. Binary search rather than a scan: a dense run
  // produces thousands of segments and this runs every animation frame.
  function playToSrc(warp, playMs) {
    if (!warp || warp.segs.length === 0) return warp ? warp.srcFirst : 0;
    if (playMs <= 0) return warp.srcFirst;
    if (playMs >= warp.durationPlayMs) return warp.srcLast;
    let lo = 0;
    let hi = warp.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (warp.segs[mid].playEnd < playMs) lo = mid + 1;
      else hi = mid;
    }
    const s = warp.segs[lo];
    const span = s.playEnd - s.playStart;
    const f = span > 0 ? (playMs - s.playStart) / span : 0;
    return s.srcStart + f * (s.srcEnd - s.srcStart);
  }

  // A transport source is whatever is being scrubbed. `times` seeds the warp;
  // `render(srcMs, prevSrcMs)` draws the world at srcMs (prevSrcMs null means
  // "rebuild from scratch" — a seek or a backwards jump); `format(srcMs)`
  // renders the readout; `label` names it in the bar.
                
  function transportEl(id) {
    return document.getElementById(id);
  }

  // app.js owns the bottom-of-map stacking (it measures every docked
  // element into CSS variables); showing/hiding the transport bar changes
  // that stack, so nudge it. Guarded because the observer in app.js already
  // covers the normal case — this is just belt and braces for the frame the
  // class flips on.
  function syncBottomClearances() {
    if (typeof window.HopReachSyncBottomClearances === "function") window.HopReachSyncBottomClearances();
  }

  function setTransportSource(source) {
    transportPause();
    S.transportSource = source;
    S.transportWarp = source ? buildTimeWarp(source.times) : null;
    S.transportPlayMs = 0;
    S.transportLastSrcMs = null;
    const bar = transportEl("sim-transport");
    const hasTimeline = !!(source && S.transportWarp && source.times.length > 0);
    bar.classList.toggle("hidden", !hasTimeline);
    if (!hasTimeline) {
      syncBottomClearances();
      return;
    }
    const seek = transportEl("sim-transport-seek");
    seek.min = "0";
    // A single-instant timeline (every event at the same ms) has zero play
    // duration; give the scrubber a nonzero range so it isn't a dead control.
    seek.max = String(Math.max(1, Math.round(S.transportWarp.durationPlayMs)));
    seek.value = "0";
    transportEl("sim-transport-label").textContent = source.label || "";
    transportRender(false);
    syncBottomClearances();
  }

  function clearTransportSource() {
    transportPause();
    S.transportSource = null;
    S.transportWarp = null;
    S.transportLastSrcMs = null;
    transportEl("sim-transport").classList.add("hidden");
    syncBottomClearances();
  }

  // Draws the world at the current play position. `animate` is passed to the
  // source so it can pulse newly-crossed events while playing but stay silent
  // while scrubbing — dragging the bar across a hundred hops shouldn't fire a
  // hundred overlapping pulse animations.
  function transportRender(animate) {
    if (!S.transportSource || !S.transportWarp) return;
    const srcMs = playToSrc(S.transportWarp, S.transportPlayMs);
    const prev = animate && S.transportLastSrcMs != null && srcMs >= S.transportLastSrcMs ? S.transportLastSrcMs : null;
    S.transportSource.render(srcMs, prev);
    S.transportLastSrcMs = srcMs;
    const seek = transportEl("sim-transport-seek");
    if (document.activeElement !== seek) seek.value = String(Math.round(S.transportPlayMs));
    transportEl("sim-transport-time").textContent = S.transportSource.format(srcMs);
  }

  function transportFrame(ts) {
    if (!S.transportPlaying) return;
    const dt = S.transportLastFrameTs ? ts - S.transportLastFrameTs : 0;
    S.transportLastFrameTs = ts;
    // Clamp the frame delta so a backgrounded tab (which stops firing rAF)
    // doesn't resume by jumping the whole elapsed wall-clock at once.
    S.transportPlayMs += Math.min(250, dt) * S.transportRate;
    if (S.transportPlayMs >= S.transportWarp.durationPlayMs) {
      S.transportPlayMs = S.transportWarp.durationPlayMs;
      transportRender(true);
      transportPause();
      return;
    }
    transportRender(true);
    S.transportRaf = requestAnimationFrame(transportFrame);
  }

  function transportPlay() {
    if (!S.transportSource || !S.transportWarp) return;
    // Playing from the very end restarts, rather than sitting there doing
    // nothing — the common case after watching one through.
    if (S.transportPlayMs >= S.transportWarp.durationPlayMs) {
      S.transportPlayMs = 0;
      S.transportLastSrcMs = null;
      transportRender(false);
    }
    S.transportPlaying = true;
    S.transportLastFrameTs = 0;
    transportEl("sim-transport-play").textContent = "⏸";
    transportEl("sim-transport-play").setAttribute("aria-label", "Pause");
    S.transportRaf = requestAnimationFrame(transportFrame);
  }

  function transportPause() {
    S.transportPlaying = false;
    if (S.transportRaf) cancelAnimationFrame(S.transportRaf);
    S.transportRaf = null;
    const btn = transportEl("sim-transport-play");
    if (btn) {
      btn.textContent = "▶";
      btn.setAttribute("aria-label", "Play");
    }
  }

  function transportSeekTo(playMs) {
    if (!S.transportWarp) return;
    S.transportPlayMs = Math.max(0, Math.min(S.transportWarp.durationPlayMs, playMs));
    S.transportLastSrcMs = null; // a seek can go backwards, so always rebuild
    transportRender(false);
  }

  function transportToEnd() {
    if (!S.transportWarp) return;
    transportPause();
    transportSeekTo(S.transportWarp.durationPlayMs);
  }

  function transportRestart() {
    if (!S.transportWarp) return;
    transportSeekTo(0);
    transportPlay();
  }

    
  function buildWaves(report) {
    const groups = new Map();
    for (const r of report.receptions) {
      const key = `${r.fromNode}:${r.packetId}:${r.atMs}`;
      let g = groups.get(key);
      if (!g) {
        g = { fromNode: r.fromNode, atMs: r.atMs, receptions: [] };
        groups.set(key, g);
      }
      g.receptions.push(r);
    }
    return Array.from(groups.values()).sort((a, b) => a.atMs - b.atMs);
  }

  // pulseAt draws an expanding, fading ring at latlng — a fixed-pixel
  // radius (circleMarker, not circle) so the effect reads the same at any
  // zoom level, like a radar sweep rather than a geographically-scaled
  // wavefront.
  function pulseAt(latlng, color) {
    const circle = L.circleMarker(latlng, {
      radius: 6,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.45,
      opacity: 0.9,
    }).addTo(simResultsLayer);
    const durationMs = 700;
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / durationMs);
      circle.setRadius(6 + t * 34);
      circle.setStyle({ opacity: 0.9 * (1 - t), fillOpacity: 0.45 * (1 - t) });
      if (t < 1) requestAnimationFrame(tick);
      else simResultsLayer.removeLayer(circle);
    }
    requestAnimationFrame(tick);
  }

  // --- growing/greening success markers -----------------------------
  //
  // A repeater that's actually cleanly receiving traffic should read as
  // "doing well" at a glance without opening the results log — each clean
  // (non-collided) reception at a node grows a ring around it and shifts
  // its colour further toward green, so the map itself ends up showing
  // which repeaters are pulling their weight in this scenario and which
  // barely got anything through.
  const GROWTH_BASE_RADIUS = 5;
  const GROWTH_MAX_RADIUS = 22;
  const GROWTH_SATURATES_AT = 12; // successes at which the ring reaches both its max size and full green

  function growthColorAndRadius(count) {
    const t = Math.min(1, count / GROWTH_SATURATES_AT);
    // Dim slate (barely-there) toward a bright green, matching the
    // collision/clean colour convention used elsewhere in this file.
    const from = [100, 116, 139];
    const to = [74, 222, 128];
    const rgb = from.map((c, i) => Math.round(c + (to[i] - c) * t));
    return { color: `rgb(${rgb.join(",")})`, radius: GROWTH_BASE_RADIUS + t * (GROWTH_MAX_RADIUS - GROWTH_BASE_RADIUS) };
  }

  function ensureGrowthMarker(nodeIndex) {
    let marker = growthMarkers.get(nodeIndex);
    if (!marker) {
      const n = S.simNodes[nodeIndex];
      if (!n) return null;
      marker = L.circleMarker([n.lat, n.lon], { radius: GROWTH_BASE_RADIUS, color: "rgb(100,116,139)", weight: 2, fillOpacity: 0.15, interactive: false }).addTo(simResultsLayer);
      growthMarkers.set(nodeIndex, marker);
    }
    return marker;
  }

  function growNode(nodeIndex) {
    S.nodeGrowthCounts[nodeIndex] = (S.nodeGrowthCounts[nodeIndex] || 0) + 1;
    const marker = ensureGrowthMarker(nodeIndex);
    if (!marker) return;
    const { color, radius } = growthColorAndRadius(S.nodeGrowthCounts[nodeIndex]);
    marker.setStyle({ color, fillColor: color });
    marker.setRadius(radius);
  }

  // A reception "counts" for growth purposes according to
  // simViewMode.growBy — success-mode counts clean receptions,
  // collision-mode counts collided ones (see growNode's own doc comment).
  function matchesGrowBy(r) {
    return simViewMode.growBy === "collision" ? r.collided : !r.collided;
  }

  // A reception is drawn/counted at all according to simViewMode.filter —
  // "all" never excludes anything, "collisions"/"successes" show only
  // that half of what actually happened. Shared by the live replay, the
  // final skip-to-end state, and a selected sent message's own path, so
  // all three stay consistent with whichever view the user picked.
  function matchesViewFilter(r) {
    if (simViewMode.filter === "collisions") return r.collided;
    if (simViewMode.filter === "successes") return !r.collided;
    return true;
  }

  // Draws every growth marker straight at its final size — used by
  // skipToEnd, which (unlike the step-by-step replay) never calls
  // growNode per-wave.
  function applyFinalGrowth(report) {
    S.nodeGrowthCounts = [];
    for (const r of report.receptions) {
      if (!matchesGrowBy(r)) continue;
      S.nodeGrowthCounts[r.node] = (S.nodeGrowthCounts[r.node] || 0) + 1;
    }
    S.nodeGrowthCounts.forEach((count, nodeIndex) => {
      if (!count) return;
      const marker = ensureGrowthMarker(nodeIndex);
      if (!marker) return;
      const { color, radius } = growthColorAndRadius(count);
      marker.setStyle({ color, fillColor: color });
      marker.setRadius(radius);
    });
  }

  function playWave(wave) {
    if (!simViewMode.keepAllPaths) {
      S.currentWaveLines.forEach((line) => simResultsLayer.removeLayer(line));
      S.currentWaveLines = [];
    }
    const from = S.simNodes[wave.fromNode];
    if (from) pulseAt([from.lat, from.lon], "#a855f7");
    for (const r of wave.receptions) {
      if (!matchesViewFilter(r)) continue;
      const to = S.simNodes[r.node];
      if (!from || !to) continue;
      const line = L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.85 }
      ).addTo(simResultsLayer);
      S.currentWaveLines.push(line);
      if (r.collided) pulseAt([to.lat, to.lon], "#f87171");
      if (matchesGrowBy(r)) growNode(r.node);
    }
  }

  // Re-renders whatever's currently on screen for the CURRENT
  // simViewMode.keepAllPaths setting, so the toggle is a live analysis
  // lens rather than something that only takes effect on the next run.
  // playWave alone can't do this: it only ever acts on the next wave
  // tick, which means toggling in a finished/static view (the common
  // case — you've just watched a replay and want to look again) did
  // nothing visible at all.
  //
  // "Which lines belong on screen" depends on how far through the replay
  // we are, hence the two branches. Growth markers have to be rebuilt
  // either way, since simResultsLayer.clearLayers() drops them alongside
  // the lines (see skipToEnd's own note on this).
  function redrawPathsForKeepAllPaths() {
    if (!S.lastReport) return;
    // No waves built yet (a report exists but Replay was never started —
    // startReplay is what populates replayWaves) means there's no "most
    // recent wave" to narrow down to, so the accumulated view is the only
    // meaningful one regardless of the toggle. Without this, unticking
    // Keep all paths in that state would blank the map entirely.
    if (S.replayWaves.length === 0) {
      redrawResultLines(S.lastReport);
      S.currentWaveLines = [];
      growthMarkers.clear();
      applyFinalGrowth(S.lastReport);
      return;
    }
    const finished = S.replayIndex >= S.replayWaves.length;

    if (simViewMode.keepAllPaths) {
      if (finished) {
        redrawResultLines(S.lastReport);
        S.currentWaveLines = [];
        growthMarkers.clear();
        applyFinalGrowth(S.lastReport);
        return;
      }
      // Mid-replay: accumulate everything played SO FAR (waves
      // 0..replayIndex-1), not the whole report — the run hasn't got to
      // the rest yet, and showing it would be a different view than the
      // one being watched.
      renderWaveRange(0, S.replayIndex);
      return;
    }

    // !keepAllPaths — only the most recently played wave stays on screen.
    // Nothing has played yet (replayIndex 0, replay not started) means
    // there's no "most recent wave"; a finished replay's most recent one
    // is the last.
    const lastPlayed = finished ? S.replayWaves.length - 1 : S.replayIndex - 1;
    if (lastPlayed < 0) {
      simResultsLayer.clearLayers();
      S.currentWaveLines = [];
      growthMarkers.clear();
      S.nodeGrowthCounts = [];
      return;
    }
    renderWaveRange(lastPlayed, lastPlayed + 1);
  }

  // Draws waves [startIndex, endIndex) fresh, replacing whatever's on the
  // results layer, and rebuilds growth markers to match exactly those
  // waves — so growth always reflects the same subset of the run the
  // lines do, rather than drifting out of step with it.
  function renderWaveRange(startIndex, endIndex) {
    simResultsLayer.clearLayers();
    S.currentWaveLines = [];
    growthMarkers.clear();
    S.nodeGrowthCounts = [];
    for (let i = startIndex; i < endIndex; i++) {
      const wave = S.replayWaves[i];
      if (!wave) continue;
      const from = S.simNodes[wave.fromNode];
      if (!from) continue;
      for (const r of wave.receptions) {
        if (!matchesViewFilter(r)) continue;
        const to = S.simNodes[r.node];
        if (!to) continue;
        const line = L.polyline(
          [
            [from.lat, from.lon],
            [to.lat, to.lon],
          ],
          { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.85 }
        ).addTo(simResultsLayer);
        S.currentWaveLines.push(line);
        if (matchesGrowBy(r)) growNode(r.node);
      }
    }
  }

  // How many waves have happened by srcMs. replayWaves is sorted by atMs,
  // so this is a binary search — it runs on every animation frame.
  function countWavesUpTo(srcMs) {
    let lo = 0;
    let hi = S.replayWaves.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (S.replayWaves[mid].atMs <= srcMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // The simulated flood as a transport source. Rendering is incremental
  // while playing forward (append only the waves just crossed, pulses and
  // all) and a full rebuild on any seek — with an early-out when the play
  // head hasn't crossed a wave boundary at all, which is most frames.
  function simTransportSource() {
    return {
      kind: "sim",
      label: "Simulated flood",
      times: S.replayWaves.map((w) => w.atMs),
      format: (srcMs) => {
        const k = countWavesUpTo(srcMs);
        return `t=${Math.max(0, Math.round(srcMs))}ms · ${k}/${S.replayWaves.length}`;
      },
      render: (srcMs, prevSrcMs) => {
        const k = countWavesUpTo(srcMs);
        if (prevSrcMs != null) {
          const prevK = countWavesUpTo(prevSrcMs);
          if (k === prevK) return; // nothing new happened this frame
          // playWave already honours keepAllPaths (clearing the previous
          // wave's lines when it's off), so this one path covers both views.
          for (let i = prevK; i < k; i++) playWave(S.replayWaves[i]);
          S.replayIndex = k;
          setReplayStatus(k >= S.replayWaves.length ? "Replay finished — showing final state." : `Playing… t=${S.replayWaves[k - 1].atMs}ms (${k}/${S.replayWaves.length})`);
          updateMapLiveStats(k);
          return;
        }
        // Seek (or first render): rebuild from scratch. redrawPathsForKeep-
        // AllPaths reads replayIndex to decide what "now" means, so set it
        // first — it's the same function the Keep-all-paths toggle uses, which
        // keeps scrubbing and toggling in perfect agreement about what should
        // be on screen.
        S.replayIndex = k;
        if (S.lastReport) redrawPathsForKeepAllPaths();
        else {
          simResultsLayer.clearLayers();
          growthMarkers.clear();
          S.currentWaveLines = [];
          S.nodeGrowthCounts = [];
        }
        setReplayStatus(
          S.replayWaves.length === 0 ? "" : k >= S.replayWaves.length ? "Showing final state." : `t=${Math.round(srcMs)}ms (${k}/${S.replayWaves.length})`
        );
        updateMapLiveStats(k);
      },
    };
  }

  function stopReplay() {
    transportPause();
  }

  function startReplay() {
    S.replayWaves = S.lastReport ? buildWaves(S.lastReport) : [];
    S.replayIndex = 0;
    simResultsLayer.clearLayers();
    growthMarkers.clear();
    S.nodeGrowthCounts = [];
    S.currentWaveLines = [];
    if (S.replayWaves.length === 0) {
      clearTransportSource();
      setReplayStatus("");
      return;
    }
    setTransportSource(simTransportSource());
    transportPlay();
  }

  function skipToEnd() {
    // Skipping to the end before ever pressing play still needs the waves
    // built and the transport pointed at them.
    if (S.replayWaves.length === 0 && S.lastReport) {
      S.replayWaves = buildWaves(S.lastReport);
      if (S.replayWaves.length > 0) setTransportSource(simTransportSource());
    }
    if (!S.transportSource || S.transportSource.kind !== "sim") {
      if (S.replayWaves.length > 0) setTransportSource(simTransportSource());
    }
    if (S.replayWaves.length === 0) {
      simResultsLayer.clearLayers();
      growthMarkers.clear();
      S.currentWaveLines = [];
      S.nodeGrowthCounts = [];
      setReplayStatus("");
      return;
    }
    transportToEnd();
    setReplayStatus("Showing final state.");
  }


  function init(context) {
    ({ growthMarkers, redrawResultLines, setReplayStatus, simResultsLayer, simViewMode, updateMapLiveStats } = context);
    return api;
  }

  const api = {
    init,
    applyFinalGrowth,
    clearTransportSource,
    matchesViewFilter,
    pulseAt,
    redrawPathsForKeepAllPaths,
    setTransportSource,
    skipToEnd,
    startReplay,
    stopReplay,
    transportPause,
    transportPlay,
    transportSeekTo,
    transportToEnd,
  };
  return api;
});
