// The map page's shared mutable state, in one place.
//
// app.js used to hold all of this as 14 closure variables, which is
// exactly why it could not be split: every feature area read and reassigned
// them, so moving any one of them out meant threading a getter for each. As a
// single object, a module that needs the current coverage layer just reads
// S.coverageLayer and always sees the live value.
//
// Deliberately a plain mutable object rather than an event-emitting store:
// this is a faithful lift of what the closure already did, and adding change
// notification at the same time would have made it a rewrite instead of a
// move.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MapState = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {
    mapDeclutterSnapshot: null,
    resizeRaf: null,
    clusters: null,
    clusteringDisabled: false,
    coverageLayer: null,
    coverageTileOverlays: [],
    legendControl: null,
    lastGeneratedAt: null,
    currentGeojson: null,
    currentMeta: null,
    positionMode: undefined,
    positionModeControl: null,
    lastProgressStage: null,
    simDeclutterSnapshot: null,
  };
});
