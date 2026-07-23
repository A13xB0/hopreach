package meshsim

import "testing"

func TestPacketScore(t *testing.T) {
	cases := []struct {
		name           string
		snrDB          float64
		sf             int
		packetLenBytes int
		want           float64
	}{
		{"below minimum spreading factor", 0, 6, 10, 0},
		{"exactly at SF7 threshold, zero length", -7.5, 7, 0, 0}, // successRate = 0 exactly at threshold
		{"well above threshold, zero length", 2.5, 7, 0, 1.0},    // successRate = (2.5-(-7.5))/10 = 1.0, collisionPenalty = 1
		{"well above threshold, half-max length", 2.5, 7, 128, 0.5},
		{"far below threshold", -100, 7, 10, 0},
		{"success rate over 1.0 clamps to 1.0", 100, 7, 0, 1.0},
		{"max length (256 bytes) zeroes out the score", 2.5, 7, 256, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := PacketScore(c.snrDB, c.sf, c.packetLenBytes)
			if diff := got - c.want; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("PacketScore(%v, %d, %d) = %v, want %v", c.snrDB, c.sf, c.packetLenBytes, got, c.want)
			}
		})
	}
}

func TestPacketScoreNeverNegativeOrAboveOne(t *testing.T) {
	for _, snr := range []float64{-50, -20, -10, 0, 10, 50} {
		for sf := 5; sf <= 12; sf++ {
			for _, length := range []int{0, 50, 128, 256, 500} {
				got := PacketScore(snr, sf, length)
				if got < 0 || got > 1 {
					t.Errorf("PacketScore(%v, %d, %d) = %v, want a value in [0,1]", snr, sf, length, got)
				}
			}
		}
	}
}
