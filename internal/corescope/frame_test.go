package corescope

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// The browser used to parse this wire format itself. These pin the Go
// version against the same cases the JS one was checked on, plus the real
// captured packet scope_test.go already carries.

func TestParseFrameTransportFloodCarriesATransportCode(t *testing.T) {
	// Route type lives in the low 2 bits; 0 = TRANSPORT_FLOOD, so the next
	// four bytes are the transport code and path_len is at index 5.
	f, ok := ParseFrame("00" + "11223344" + "00" + "aabbcc")
	if !ok {
		t.Fatal("a well-formed flood must parse")
	}
	if f.RouteType != 0 || !f.HasTransport {
		t.Errorf("routeType=%d hasTransport=%v", f.RouteType, f.HasTransport)
	}
	if f.PayloadOffset != 6 || f.PayloadLen != 3 {
		t.Errorf("payload at %d len %d, want 6/3", f.PayloadOffset, f.PayloadLen)
	}
	if f.TotalBytes != 9 {
		t.Errorf("totalBytes=%d, want 9 — airtime is computed from this", f.TotalBytes)
	}
}

func TestParseFrameHopOneHasNoTransportCode(t *testing.T) {
	// Route type 1 is a plain flood: no transport code, so the same trailing
	// bytes are payload rather than being skipped.
	f, ok := ParseFrame("01" + "00" + "aabbcc")
	if !ok {
		t.Fatal("a plain flood must parse")
	}
	if f.HasTransport {
		t.Error("route type 1 must not claim a transport code")
	}
	if f.PayloadLen != 3 {
		t.Errorf("payloadLen=%d, want 3", f.PayloadLen)
	}
}

func TestParseFrameSplitsPathLenIntoCountAndSize(t *testing.T) {
	// 0x82 = 0b10_000010: low 6 bits are the hop count, high 2 bits plus one
	// are the bytes per hop. 2 hops * 3 bytes = 6 path bytes.
	f, ok := ParseFrame("01" + "82" + "aabbccddeeff" + "1234")
	if !ok {
		t.Fatal("must parse")
	}
	if f.HopCount != 2 || f.HashSize != 3 {
		t.Errorf("hopCount=%d hashSize=%d, want 2/3", f.HopCount, f.HashSize)
	}
	if f.PayloadLen != 2 {
		t.Errorf("payloadLen=%d, want 2", f.PayloadLen)
	}
}

func TestParseFrameRejectsMalformedFrames(t *testing.T) {
	for name, raw := range map[string]string{
		"empty":                  "",
		"header only":            "00",
		"truncated transport":    "00112233",
		"path longer than frame": "01" + "05" + "aa",
		"not hex":                "zzzz",
	} {
		if _, ok := ParseFrame(raw); ok {
			t.Errorf("%s: parsed, want rejected", name)
		}
	}
}

func TestParseFrameAgreesWithTheRealCapturedPacket(t *testing.T) {
	f, ok := ParseFrame(realTransportFloodPacketRawHex)
	if !ok {
		t.Fatal("the real captured packet must parse")
	}
	if !f.HasTransport {
		t.Error("a real transport flood must carry a transport code")
	}
	raw, _ := hex.DecodeString(realTransportFloodPacketRawHex)
	if f.TotalBytes != len(raw) {
		t.Errorf("totalBytes=%d, want %d", f.TotalBytes, len(raw))
	}
	if f.PayloadOffset > f.TotalBytes {
		t.Error("payload cannot start past the end of the frame")
	}
}

func TestRegionOfPacketNamesTheRegionOrNothing(t *testing.T) {
	// Build a frame whose transport code genuinely matches "#fife", the same
	// way TransportKeyStore::calcTransportCode does.
	region := "#fife"
	key := regionKey(region)
	payloadType := byte(3)
	payload := []byte{0xde, 0xad, 0xbe, 0xef}
	mac := hmac.New(sha256.New, key[:])
	mac.Write(append([]byte{payloadType}, payload...))
	sum := mac.Sum(nil)
	frame := append([]byte{payloadType << 2, sum[0], sum[1], 0, 0, 0}, payload...)
	raw := hex.EncodeToString(frame)

	if got := RegionOfPacket(raw, []string{"#scotland", region, "#tayside"}); got != region {
		t.Errorf("region = %q, want %q", got, region)
	}
	// A region this deployment doesn't know must not be attributed to the
	// nearest candidate — that would be inventing a data point.
	if got := RegionOfPacket(raw, []string{"#scotland", "#tayside"}); got != "" {
		t.Errorf("unknown region decoded as %q, want unscoped", got)
	}
	if got := RegionOfPacket(raw, nil); got != "" {
		t.Errorf("no candidates decoded as %q, want unscoped", got)
	}
	if got := RegionOfPacket("", []string{region}); got != "" {
		t.Errorf("empty frame decoded as %q", got)
	}
	// Route type 1 carries no transport code at all: genuinely unscoped.
	if got := RegionOfPacket("01"+"00"+"aabbcc", []string{region}); got != "" {
		t.Errorf("plain flood decoded as %q, want unscoped", got)
	}
}
