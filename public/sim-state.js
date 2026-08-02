// The simulator's shared mutable state, in one place.
//
// simulator.js used to hold all of this as 64 closure variables, which is
// exactly why it could not be split: every feature area read and reassigned
// them, so moving any one of them out meant threading a getter for each. As a
// single object, a module that needs the current nodes just reads S.simNodes
// and always sees the live value.
//
// Deliberately a plain mutable object rather than an event-emitting store:
// this is a faithful lift of what the closure already did, and adding change
// notification at the same time would have made it a rewrite instead of a
// move.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimState = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {
    simNodes: [],
    simLinks: [],
    simMessageGenerators: [],
    lastReport: null,
    lastMessages: null,
    selectedPacketId: null,
    lastEpisode: null,
    lastEpisodeMessages: null,
    lastEpisodeTargetPid: -1,
    episodeBaseline: null,
    linksGeneration: 0,
    cachedGrid: null,
    simNodePrefsOverrides: {},
    lastTuneResult: null,
    lastAttrsList: null,
    lastStressResult: null,
    currentSetupId: null,
    predictWorker: null,
    predictGeneration: 0,
    nodeGrowthCounts: [],
    currentWaveLines: [],
    placementMode: "off",
    companionCounter: 0,
    placedRepeaterCounter: 0,
    editingGeneratorId: null,
    lastRunMaxTimeMs: 60000,
    currentPacketModalEvents: [],
    currentPacketModalShowOpts: { showAt: false },
    transmissionIndex: new Map(),
    relayCauseIndex: new Map(),
    packetModalHistory: [],
    packetModalCurrent: null,
    transportSource: null,
    transportWarp: null,
    transportPlayMs: 0,
    transportPlaying: false,
    transportRate: 1,
    transportRaf: null,
    transportLastFrameTs: 0,
    transportLastSrcMs: null,
    replayWaves: [],
    replayIndex: 0,
    lastPolicyResult: null,
    lastPolicyAltitudeAttrs: null,
    lastPolicyActions: [],
    lastPolicyProfiles: null,
    meshMethodsCache: null,
    optimizeCancelled: false,
    optimizeCancelTimeout: null,
    lastOptimizeDeviations: [],
    lastOptimizeSnapshot: [],
    nodeDirectoryCache: null,
    replayObservations: new Map(),
    replayWindowStartMs: 0,
    replayTargetHash: "",
    realTimelineEvents: [],
    realTimelineIndex: 0,
    realTimelineWindowStartMs: 0,
    lastRealTimelineWindowSecs: 30,
    lastRealReplayStatusText: "",
    bottleneckLegendControl: null,
    modalReturnFocusEl: null,
    simViewControl: null,
    simPlaybackControl: null,
  };
});
