package corescope

import "encoding/hex"

// MeshCore on-air frame layout — a direct port of Packet::readFrom
// (src/Packet.cpp), see docs/packet_format.md.
//
// This used to be reimplemented in the browser (public/simulator.js's
// parseMeshFrame, alongside a hand-rolled SHA-256 because SubtleCrypto is
// unavailable off a secure context). Doing it here instead means the wire
// format is parsed once, in the same package that already decodes a
// packet's region from it, and the browser is handed the answers.

// RegionOfPacket reports which region a packet was sent on, decoded from its
// own transport code against the candidate names. Empty means genuinely
// unscoped or undecodable — never a best guess, since attributing a packet to
// the wrong region is worse than admitting it is unknown.
func RegionOfPacket(rawHex string, candidateNames []string) string {
	if rawHex == "" || len(candidateNames) == 0 {
		return ""
	}
	keys := make(map[string][16]byte, len(candidateNames))
	for _, name := range candidateNames {
		if name != "" {
			keys[name] = regionKey(name)
		}
	}
	region, ok := decodePacketRegion(rawHex, keys)
	if !ok {
		return ""
	}
	return region
}

// Frame is one parsed on-air frame's structure. Byte counts, not content:
// enough to know how long a transmission was and where its payload starts.
type Frame struct {
	RouteType   int
	PayloadType byte

	// HasTransport is true for TRANSPORT_FLOOD (0) / TRANSPORT_DIRECT (3),
	// the only route types carrying the 4-byte transport code that
	// decodePacketRegion reverses. A plain flood is genuinely unscoped.
	HasTransport bool

	// HopCount and HashSize come from the single path_len byte: the low 6
	// bits are the hop count, the high 2 bits plus one are the bytes each
	// hop contributes to the accumulated path.
	HopCount int
	HashSize int

	// PayloadOffset is the index of the first application-payload byte,
	// i.e. past the header, transport code, path_len byte and the
	// accumulated path.
	PayloadOffset int
	PayloadLen    int

	// TotalBytes is the whole frame as transmitted — what airtime is
	// actually computed from.
	TotalBytes int
}

// ParseFrame decodes a frame's structure from its raw hex. Reports false for
// anything too short or internally inconsistent to be a real frame — a
// truncated capture claiming a longer path than it carries is malformed, not
// a packet with a negative-length payload.
func ParseFrame(rawHex string) (Frame, bool) {
	raw, err := hex.DecodeString(rawHex)
	if err != nil || len(raw) < 2 {
		return Frame{}, false
	}
	header := raw[0]
	f := Frame{
		RouteType:   int(header & 0x03),
		PayloadType: (header >> 2) & 0x0F,
		TotalBytes:  len(raw),
	}
	f.HasTransport = f.RouteType == routeTypeTransportFlood ||
		f.RouteType == routeTypeTransportDirect

	i := 1
	if f.HasTransport {
		i += 4
	}
	if i >= len(raw) {
		return Frame{}, false
	}
	pathLen := raw[i]
	i++
	f.HopCount = int(pathLen & 0x3F)
	f.HashSize = int(pathLen>>6) + 1

	f.PayloadOffset = i + f.HopCount*f.HashSize
	if f.PayloadOffset > len(raw) {
		return Frame{}, false
	}
	f.PayloadLen = len(raw) - f.PayloadOffset
	return f, true
}
