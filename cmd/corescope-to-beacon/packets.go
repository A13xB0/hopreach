package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"hopreach/internal/meshsource"
)

// Packets and their observations — what the replay feature reads.

// sourceBroker labels where an observation came from. Real ingest records the
// MQTT broker; a migrated row records the migration, so the provenance of
// anything in this database is visible from the row itself.
const sourceBroker = "corescope-to-beacon"

func (m *migration) writePackets(
	ctx context.Context, byKey map[string]nodeRef, scopeIDs map[string]int, o runOpts,
) error {
	packets, err := m.src.FetchPacketsBetween(ctx, o.packetSince, time.Now(), o.packetLimit)
	if err != nil {
		return err
	}
	log.Printf("packets: %d in window", len(packets))

	// Beacon parses raw_payload with the real MeshCore decoders, so these
	// have to be the genuine bytes — see rawhex.go.
	frames, err := m.fetchRawFrames(ctx, o.apiURL, len(packets)*2)
	if err != nil {
		return err
	}
	log.Printf("packets: %d raw frames available", len(frames))

	// Two passes. Beacon's packet_observations carries a foreign key to
	// observers, and PostgreSQL checks it on insert, not at COMMIT — so every
	// observer has to exist before the first observation that names it.
	type pending struct {
		packet          meshsource.Packet
		detail          meshsource.Packet
		header, payload string
	}
	skippedFrames := 0
	rows := make([]pending, 0, len(packets))
	observers := map[string]string{} // observer key -> iata
	// observer -> scope ids it was heard carrying. Beacon derives which
	// regions exist in an IATA by joining observers to scopes through this
	// table (GetScopesByIATAs), so without it /scopes?iatas=… answers empty
	// and every region-aware feature goes quiet.
	observerScopes := map[string]map[int]bool{}

	for _, p := range packets {
		if p.Hash == "" {
			continue
		}
		detail, err := m.src.FetchPacketDetail(ctx, p.Hash)
		if err != nil {
			// One packet's detail failing costs that packet's observations,
			// not the migration.
			log.Printf("packets: detail for %s failed: %v", p.Hash, err)
			detail = p
		}

		header, payload, ok := splitFrame(frames[strings.ToLower(p.Hash)])
		if !ok {
			// Without real bytes Beacon's detail endpoint fails outright, so a
			// packet we cannot carry faithfully is skipped rather than stored
			// as a row that 500s on read.
			skippedFrames++
			continue
		}
		rows = append(rows, pending{packet: p, detail: detail, header: header, payload: payload})
		for _, ob := range observationsOf(p, detail) {
			key := strings.ToLower(ob.ObserverKey)
			if key == "" {
				continue
			}
			iata := fallbackIATA
			if ref, ok := byKey[key]; ok {
				iata = ref.iata
			}
			observers[key] = iata
			if id, ok := scopeIDs[p.Scope]; ok {
				if observerScopes[key] == nil {
					observerScopes[key] = map[int]bool{}
				}
				observerScopes[key][id] = true
			}
		}
	}

	m.writeObservers(observers, observerScopes)

	m.w.printf("-- packets\n")
	for _, row := range rows {
		p, detail := row.packet, row.detail

		scope := "NULL"
		if id, ok := scopeIDs[p.Scope]; ok {
			scope = fmt.Sprint(id)
		}
		origin := "NULL"
		if p.OriginKey != "" {
			origin = hexLit(p.OriginKey)
		}
		transport := p.RouteType == 0 || p.RouteType == 3

		m.w.printf(
			"INSERT INTO packets (packet_hash, payload_type, payload_version, route_type, "+
				"transport_codes_present, scope_id, origin_pubkey, raw_payload, raw_header, "+
				"first_heard_at, last_heard_at) VALUES (%s, %d, 0, %d, %t, %s, %s, %s, %s, %s, %s) "+
				"ON CONFLICT (packet_hash) DO NOTHING;\n",
			hexLit(p.Hash), p.PayloadType, p.RouteType, transport, scope, origin,
			hexLit(row.payload), hexLit(row.header),
			tsOrNow(p.HeardAt), tsOrNow(p.HeardAt))
		m.stats.packets++

		for _, ob := range observationsOf(p, detail) {
			key := strings.ToLower(ob.ObserverKey)
			if key == "" {
				continue
			}
			iata := fallbackIATA
			if ref, ok := byKey[key]; ok {
				iata = ref.iata
			}

			heard := ob.HeardAt
			if heard.IsZero() {
				heard = p.HeardAt
			}
			hashSize, hopCount := p.HashSize, len(ob.Path)
			if hashSize == 0 {
				hashSize = 1
			}
			pathBytes := pathPrefixBytes(ob.Path, hashSize)
			snr := "NULL"
			if ob.SNR != nil {
				snr = fmt.Sprintf("%v", *ob.SNR)
			}
			m.w.printf(
				"INSERT INTO packet_observations (packet_hash, observer_id, iata, heard_at, "+
					"path_length_byte, hash_size, hop_count, path_bytes, snr, payload_type, "+
					"source_broker) "+
					"VALUES (%s, %s, %s, %s, %d, %d, %d, %s, %s, %d, %s) "+
					"ON CONFLICT DO NOTHING;\n",
				hexLit(p.Hash), uuidFor(key), quote(iata), tsOrNow(heard),
				pathLenByte(hopCount, hashSize), hashSize, hopCount,
				hexLit(pathBytes), snr, p.PayloadType,
				// NOT NULL in practice though the column allows NULL: Beacon's
				// packet-detail handler dereferences it without a guard, so a
				// NULL here panics the endpoint rather than rendering blank.
				quote(sourceBroker))
			m.stats.observations++
		}
	}

	if skippedFrames > 0 {
		log.Printf("packets: skipped %d without a usable raw frame", skippedFrames)
	}
	return nil
}

// observationsOf returns every hearing of a packet, falling back to the
// representative one. A backend that reports only the latest observer still
// gives us one real hearing, and using it beats dropping the packet's only
// evidence.
func observationsOf(p, detail meshsource.Packet) []meshsource.Observation {
	if len(detail.Observations) > 0 {
		return detail.Observations
	}
	key := detail.ObserverKey
	if key == "" {
		key = p.ObserverKey
	}
	if key == "" {
		return nil
	}
	return []meshsource.Observation{{
		ObserverKey: key,
		HeardAt:     detail.HeardAt,
		Path:        detail.Path,
		SNR:         detail.SNR,
	}}
}

// writeObservers registers every node that reported hearing something. Must
// run before any packet_observations row names them — see the two-pass note
// in writePackets.
func (m *migration) writeObservers(
	observers map[string]string, observerScopes map[string]map[int]bool,
) {
	m.w.printf("\n-- observers\n")
	for key := range observers {
		m.w.printf(
			"INSERT INTO observers (id, public_key, display_name, observer_type) "+
				"VALUES (%s, %s, NULL, %s) ON CONFLICT (public_key) DO NOTHING;\n",
			uuidFor(key), hexLit(key), quote("migrated"))
		for id := range observerScopes[key] {
			m.w.printf(
				"INSERT INTO observer_scopes (observer_id, scope_id) VALUES (%s, %d) "+
					"ON CONFLICT DO NOTHING;\n",
				uuidFor(key), id)
		}
	}
	m.w.printf("\n")
}

// pathLenByte packs hop count and hash size back into MeshCore's single
// path_len byte: low six bits the hop count, high two bits hashSize-1.
func pathLenByte(hopCount, hashSize int) int {
	if hopCount > 0x3F {
		hopCount = 0x3F
	}
	if hashSize < 1 {
		hashSize = 1
	}
	if hashSize > 4 {
		hashSize = 4
	}
	return hopCount&0x3F | ((hashSize - 1) << 6)
}

// pathPrefixBytes rebuilds the accumulated relay path as Beacon stores it:
// each hop contributes the first hashSize bytes of its public key.
//
// An unresolved hop contributes zeroes. That is a real loss of fidelity and it
// is the honest representation available — CoreScope told us a relay happened
// but not which node it was, and inventing a plausible key would turn "we
// don't know" into a specific, wrong claim.
func pathPrefixBytes(path []meshsource.Hop, hashSize int) string {
	var b strings.Builder
	for _, h := range path {
		if h.Confidence != meshsource.HopResolved || len(h.PublicKey) < hashSize*2 {
			b.WriteString(strings.Repeat("00", hashSize))
			continue
		}
		b.WriteString(strings.ToLower(h.PublicKey[:hashSize*2]))
	}
	return b.String()
}
