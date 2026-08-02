// The planner's shared mutable state, in one place.
//
// planner.js used to hold all of this as 26 closure variables, which is
// exactly why it could not be split: every feature area read and reassigned
// them, so moving any one of them out meant threading a getter for each. As a
// single object, a module that needs the current plan just reads S.plan and
// always sees the live value.
//
// Deliberately a plain mutable object rather than an event-emitting store:
// this is a faithful lift of what the closure already did, and adding change
// notification at the same time would have made it a rewrite instead of a
// move.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanState = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {
    plan: null,
    mode: "off",
    worker: null,
    debounceTimer: null,
    previewOverlay: null,
    previewGeneration: 0,
    connectGeneration: 0,
    connectPointA: null,
    connectPointB: null,
    connectOptions: [],
    connectSelectedIndex: null,
    areaGeneration: 0,
    areaPolygonPoints: [],
    areaPolygonShape: null,
    showAllNeighborsEnabled: false,
    showAllRealNeighborsEnabled: false,
    pinnedPubkey: null,
    companionPinMode: false,
    companionMarker: null,
    realRepeatersById: {},
    plannedNeighborsById: {},
    renderAllRealNeighborsGeneration: 0,
    reachWindowDays: 1,
    losChain: [],
    companionPinHeightM: 1,
  // Derived from HOPREACH_CONFIG, which this module deliberately does not
  // read — planner.js seeds it at startup (see resetCompanionPinPropagation)
  // so config stays owned by one place.
    companionPinPropagation: null,
  };
});
