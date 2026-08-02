package sources

import (
	"context"

	"hopreach/internal/meshsource"
)

// withConfiguredScopes supplies the region catalogue from config instead of
// from the backend.
//
// The region features — per-region coverage rasters, the map's region filter,
// per-repeater region tagging — need the COMPLETE set of regions to be
// truthful, because they present themselves as exactly that. A region missing
// from the filter reads as a region with no repeaters in it.
//
// CoreScope keeps a global region list, so it can answer. Beacon's /scopes is
// scoped to observers in the configured IATAs, so it answers "regions somebody
// local was heard on" — a strict subset on most meshes, which is why the
// features are switched off there by default.
//
// But completeness is knowledge an operator usually has: they know which
// regions their network runs. Listing them in config supplies exactly what the
// backend cannot, and the features come back on.
//
// Note this changes only ENUMERATION. Which packets belong to which region is
// still decoded from real traffic — Beacon records a packet's scope at ingest
// from its transport code, and FetchRegionParticipation tallies relays per
// region from that. A configured region nobody has been heard on simply gets
// no participation, which is the honest answer rather than an invented one.
type withConfiguredScopes struct {
	meshsource.Source
	names []string
}

func (w withConfiguredScopes) FetchScopes(context.Context) ([]string, error) {
	return w.names, nil
}

func (w withConfiguredScopes) Capabilities() meshsource.Capabilities {
	caps := w.Source.Capabilities()
	// The operator asserted the list is complete. That is the one thing the
	// capability is about, so it is now satisfied whatever the backend says.
	caps.ScopeCatalog = true
	return caps
}
