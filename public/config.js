// Runtime configuration. In the Docker image this file is regenerated from
// config.yaml at container startup (see cmd/hopreach's -prepare mode,
// invoked by docker/entrypoint.sh). This checked-in copy is just the
// default used for local development.
window.HOPREACH_CONFIG = {
  siteName: "ScotMesh Repeater Coverage",
  siteSubtitle: "MeshCore repeater map, refreshed daily",
  mapCenter: [56.8, -4.2],
  mapZoom: 6,
  dataUrl: "data/repeaters.geojson",
  metaUrl: "data/meta.json",

  mapScopeFilters: ["sco", "ioi", "unscoped"],

  demZoom: 11,
  // No nginx proxy in local dev (python -m http.server) — go straight to
  // the upstream tile host. In the container this is always "/dem-tiles".
  demTileURLBase: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium",
  propagation: {
    frequencyMhz: 868,
    txPowerDbm: 22,
    txAntennaGainDbi: 3,
    rxAntennaGainDbi: 0,
    rxSensitivityDbm: -124,
    fadeMarginDb: 20,
    antennaHeightM: 1.6,
    rxHeightM: 2,
    maxRangeKm: 100,
    marginGreenDb: 15,
  },
};
