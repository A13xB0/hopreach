package sysinfo

import "testing"

func TestAvailableMemoryBytes(t *testing.T) {
	got, err := AvailableMemoryBytes()
	if err != nil {
		t.Skipf("no /proc/meminfo on this platform (expected outside Linux): %v", err)
	}
	// Any real Linux box should report at least a few tens of MB available
	// (and this project's own boxes have GBs) — mostly a sanity check that
	// parsing didn't silently return a garbage value like 0 or a huge
	// overflowed number.
	const oneMB = 1 << 20
	const oneTB = 1 << 40
	if got < 10*oneMB || got > oneTB {
		t.Errorf("AvailableMemoryBytes() = %d, want a plausible value between 10MB and 1TB", got)
	}
}

func TestTotalMemoryBytes(t *testing.T) {
	avail, availErr := AvailableMemoryBytes()
	total, err := TotalMemoryBytes()
	if err != nil {
		t.Skipf("no /proc/meminfo on this platform (expected outside Linux): %v", err)
	}
	const oneMB = 1 << 20
	const oneTB = 1 << 40
	if total < 10*oneMB || total > oneTB {
		t.Errorf("TotalMemoryBytes() = %d, want a plausible value between 10MB and 1TB", total)
	}
	if availErr == nil && avail > total {
		t.Errorf("AvailableMemoryBytes() = %d exceeds TotalMemoryBytes() = %d", avail, total)
	}
}

func TestCPUModel(t *testing.T) {
	got, err := CPUModel()
	if err != nil {
		t.Skipf("no /proc/cpuinfo model name field on this platform: %v", err)
	}
	if got == "" {
		t.Errorf("CPUModel() = %q, want a non-empty string", got)
	}
}
