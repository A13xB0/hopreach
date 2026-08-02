package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"strings"

	"hopreach/internal/meshsource"
)

// Beacon partitions the world by IATA and refuses to serve a node that
// belongs to none, so every migrated node needs one. These are the airports
// nearest the real ScotMesh coverage; a node is assigned to whichever it is
// closest to, and anything without a position falls back to EDI.
var iatas = []struct {
	code     string
	lat, lon float64
}{
	{"EDI", 55.9500, -3.3725},
	{"GLA", 55.8719, -4.4331},
	{"ABZ", 57.2019, -2.1978},
	{"INV", 57.5425, -4.0475},
}

const fallbackIATA = "EDI"

func nearestIATA(lat, lon *float64) string {
	if lat == nil || lon == nil {
		return fallbackIATA
	}
	best, bestD := fallbackIATA, math.Inf(1)
	for _, a := range iatas {
		dLat := a.lat - *lat
		dLon := (a.lon - *lon) * math.Cos(a.lat*math.Pi/180)
		if d := dLat*dLat + dLon*dLon; d < bestD {
			best, bestD = a.code, d
		}
	}
	return best
}

// nodeTypeFor maps a role onto Beacon's node_type enum
// (1=companion, 2=repeater, 3=room_server, 4=sensor).
func nodeTypeFor(role string) int {
	switch strings.ToLower(role) {
	case "repeater":
		return 2
	case "room_server", "roomserver":
		return 3
	case "sensor":
		return 4
	default:
		return 1
	}
}

// writeScopes seeds transport_scopes, deriving each region's key the same way
// the firmware does: sha256(name)[:16], public by construction.
func (m *migration) writeScopes(ctx context.Context) (map[string]int, error) {
	names, err := m.src.FetchScopes(ctx)
	if err != nil {
		return nil, err
	}
	ids := make(map[string]int, len(names))
	m.w.printf("-- transport scopes\n")
	for i, name := range names {
		if name == "" {
			continue
		}
		digest := sha256.Sum256([]byte(name))
		key := hex.EncodeToString(digest[:16])
		fp := hex.EncodeToString(digest[:4])
		id := i + 1
		ids[name] = id
		m.w.printf(
			"INSERT INTO transport_scopes (id, name, display_name, transport_key, key_fingerprint) "+
				"VALUES (%d, %s, %s, %s, %s) ON CONFLICT (name) DO NOTHING;\n",
			id, quote(name), quote(strings.TrimPrefix(name, "#")), hexLit(key), hexLit(fp))
		m.stats.scopes++
	}
	m.w.printf("SELECT setval(pg_get_serial_sequence('transport_scopes','id'), " +
		"GREATEST((SELECT COALESCE(MAX(id),0) FROM transport_scopes), 1));\n\n")
	return ids, nil
}

// nodeRef is what later phases need to reference a node they have written.
type nodeRef struct {
	pubkey string
	iata   string
}

// writeNodes emits nodes, their IATA membership and the short-id prefixes
// Beacon resolves relay paths with.
//
// The UUID is derived from the public key rather than generated, so re-running
// the migration produces the same rows instead of a second copy of the mesh.
func (m *migration) writeNodes(nodes []meshsource.Node, scopeIDs map[string]int) map[string]nodeRef {
	byKey := make(map[string]nodeRef, len(nodes))
	m.w.printf("-- nodes\n")
	for _, n := range nodes {
		if n.PublicKey == "" {
			continue
		}
		pk := strings.ToLower(n.PublicKey)
		iata := nearestIATA(n.Lat, n.Lon)
		byKey[pk] = nodeRef{pubkey: pk, iata: iata}

		scope := "NULL"
		if id, ok := scopeIDs[n.DefaultScope]; ok {
			scope = fmt.Sprint(id)
		}
		locSource := "NULL"
		if n.Lat != nil && n.Lon != nil {
			locSource = quote("advert")
		}

		m.w.printf(
			"INSERT INTO nodes (id, public_key, node_type, name, latitude, longitude, "+
				"location_source, last_advert_at, default_scope_id, first_seen, last_seen) "+
				"VALUES (%s, %s, %d, %s, %s, %s, %s, %s, %s, %s, %s) "+
				"ON CONFLICT (public_key) DO NOTHING;\n",
			uuidFor(pk), hexLit(pk), nodeTypeFor(n.Role), nullableText(n.Name),
			nullableFloat(n.Lat), nullableFloat(n.Lon), locSource,
			tsOrNull(n.LastHeard), scope,
			tsOrNow(n.FirstSeen), tsOrNow(n.LastHeard))

		m.w.printf(
			"INSERT INTO node_iatas (node_id, iata, first_heard, last_heard, observation_count) "+
				"VALUES (%s, %s, %s, %s, %d) ON CONFLICT DO NOTHING;\n",
			uuidFor(pk), quote(iata), tsOrNow(n.FirstSeen), tsOrNow(n.LastHeard),
			n.RelayCount24h)

		// Path hashes are a prefix of the public key; Beacon indexes the
		// first four bytes and derives the shorter prefixes from them.
		//
		// Registered under EVERY configured IATA, not just the node's own.
		// Beacon resolves a relay hash within the IATA the observation was
		// filed under, which suits a global service where the partitions are
		// separate networks. ScotMesh is one mesh that happens to span four
		// airports, so scoping resolution to one of them silently drops every
		// hop that crossed a boundary — the packet still shows the hop, but as
		// unresolvable, which reads as "unknown relay" rather than as a
		// modelling artifact.
		if len(pk) >= 8 {
			for _, a := range iatas {
				m.w.printf(
					"INSERT INTO node_short_ids (node_id, iata, prefix_4) VALUES (%s, %s, %s) "+
						"ON CONFLICT DO NOTHING;\n",
					uuidFor(pk), quote(a.code), hexLit(pk[:8]))
			}
		}
		m.stats.nodes++
	}
	m.w.printf("\n")
	return byKey
}

// uuidFor derives a stable UUID from a public key, so the migration is
// idempotent: the same mesh always produces the same node ids.
func uuidFor(pubkey string) string {
	sum := sha256.Sum256([]byte("hopreach-node:" + strings.ToLower(pubkey)))
	h := hex.EncodeToString(sum[:16])
	return quote(fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32]))
}

// writeNeighbours turns each node's observed reach into Beacon's neighbour
// edges — the data its /nodes/{id}/neighbors endpoint serves, and therefore
// what HopReach's Beacon client synthesises reach back out of.
func (m *migration) writeNeighbours(
	ctx context.Context, nodes []meshsource.Node, byKey map[string]nodeRef, o runOpts,
) error {
	repeaters := make([]meshsource.Node, 0, len(nodes))
	for _, n := range nodes {
		if nodeTypeFor(n.Role) == 2 {
			repeaters = append(repeaters, n)
		}
	}
	if o.maxReach > 0 && len(repeaters) > o.maxReach {
		log.Printf("reach: capping at %d of %d repeaters", o.maxReach, len(repeaters))
		repeaters = repeaters[:o.maxReach]
	}
	log.Printf("reach: fetching for %d repeaters", len(repeaters))

	reach := meshsource.FetchAllReach(ctx, m.src, repeaters, o.reachDays, nil)

	m.w.printf("-- observed neighbour edges\n")
	for pubkey, links := range reach {
		from, ok := byKey[strings.ToLower(pubkey)]
		if !ok {
			continue
		}
		for _, l := range links {
			to, ok := byKey[strings.ToLower(l.PublicKey)]
			if !ok {
				// A neighbour CoreScope knows but the node list didn't
				// include. Skipping keeps the foreign key honest rather than
				// inventing a node with no identity.
				continue
			}
			count := l.Bottleneck
			if count < 1 {
				count = 1
			}
			m.w.printf(
				"INSERT INTO node_neighbors (node_id, neighbor_id, iata, observation_count) "+
					"VALUES (%s, %s, %s, %d) ON CONFLICT (node_id, neighbor_id, iata) "+
					"DO UPDATE SET observation_count = EXCLUDED.observation_count;\n",
				uuidFor(from.pubkey), uuidFor(to.pubkey), quote(from.iata), count)
			m.stats.neighbours++
		}
	}
	m.w.printf("\n")
	return nil
}
