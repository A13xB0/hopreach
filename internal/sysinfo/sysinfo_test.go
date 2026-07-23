package sysinfo

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"testing"
)

// closeEnough reports whether a and b are within a small relative
// tolerance of each other — see its use below for why exact equality isn't
// appropriate when comparing two independent live /proc/meminfo reads.
func closeEnough(a, b float64) bool {
	if a == 0 || b == 0 {
		return a == b
	}
	const tolerance = 0.05 // 5%
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff/a < tolerance
}

// withCgroupPaths points the package's cgroup path vars at files under a
// fresh temp dir for the duration of the test, restoring the real paths
// afterward — lets these tests exercise the cgroup-preferring logic
// deterministically instead of depending on whatever cgroup state happens
// to be true of the machine actually running the test suite.
func withCgroupPaths(t *testing.T) (v2Max, v2Current, v1Limit, v1Usage string) {
	t.Helper()
	dir := t.TempDir()
	v2Max = filepath.Join(dir, "memory.max")
	v2Current = filepath.Join(dir, "memory.current")
	v1Limit = filepath.Join(dir, "memory.limit_in_bytes")
	v1Usage = filepath.Join(dir, "memory.usage_in_bytes")

	origV2Max, origV2Current, origV1Limit, origV1Usage := cgroupV2MemMaxPath, cgroupV2MemCurrentPath, cgroupV1MemLimitPath, cgroupV1MemUsagePath
	cgroupV2MemMaxPath, cgroupV2MemCurrentPath, cgroupV1MemLimitPath, cgroupV1MemUsagePath = v2Max, v2Current, v1Limit, v1Usage
	t.Cleanup(func() {
		cgroupV2MemMaxPath, cgroupV2MemCurrentPath, cgroupV1MemLimitPath, cgroupV1MemUsagePath = origV2Max, origV2Current, origV1Limit, origV1Usage
	})
	return
}

// TestAvailableMemoryBytesPrefersCgroupLimitOverProcMeminfo is the
// regression test for a real production incident: a Docker container with
// no explicit memory limit, run inside an LXC that itself only gets 2GB
// from its host, reported /proc/meminfo's MemAvailable as the underlying
// physical host's ~18GB — completely unrelated to what this process could
// actually still allocate before getting OOM-killed. Once a real cgroup
// limit exists, it must win over /proc/meminfo regardless of how different
// the two numbers are.
func TestAvailableMemoryBytesPrefersCgroupLimitOverProcMeminfo(t *testing.T) {
	v2Max, v2Current, _, _ := withCgroupPaths(t)
	if err := os.WriteFile(v2Max, []byte("2000000000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(v2Current, []byte("500000000\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := AvailableMemoryBytes()
	if err != nil {
		t.Fatalf("AvailableMemoryBytes() with a cgroup limit set: %v", err)
	}
	want := uint64(2000000000 - 500000000)
	if got != want {
		t.Errorf("AvailableMemoryBytes() = %d, want %d (cgroup limit minus usage, not whatever /proc/meminfo says)", got, want)
	}

	total, err := TotalMemoryBytes()
	if err != nil {
		t.Fatalf("TotalMemoryBytes() with a cgroup limit set: %v", err)
	}
	if total != 2000000000 {
		t.Errorf("TotalMemoryBytes() = %d, want the cgroup limit 2000000000", total)
	}
}

// TestAvailableMemoryBytesFallsBackWhenCgroupUnbounded covers both the
// literal cgroup v2 "max" (no limit configured) and the classic cgroup v1
// huge-sentinel-value case (memory.limit_in_bytes defaults to a number near
// int64 max when nothing was actually set) — both must be treated as "no
// real limit," falling back to /proc/meminfo exactly as if cgroup
// accounting weren't available at all.
func TestAvailableMemoryBytesFallsBackWhenCgroupUnbounded(t *testing.T) {
	cases := []struct {
		name    string
		v2Max   string
		v1Limit string
	}{
		{name: "cgroup v2 max", v2Max: "max"},
		{name: "cgroup v1 huge sentinel", v1Limit: "9223372036854771712"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v2Max, v2Current, v1Limit, v1Usage := withCgroupPaths(t)
			if tc.v2Max != "" {
				os.WriteFile(v2Max, []byte(tc.v2Max), 0o644)
				os.WriteFile(v2Current, []byte("100"), 0o644)
			}
			if tc.v1Limit != "" {
				os.WriteFile(v1Limit, []byte(tc.v1Limit), 0o644)
				os.WriteFile(v1Usage, []byte("100"), 0o644)
			}

			got, err := AvailableMemoryBytes()
			want, wantErr := meminfoField("MemAvailable:")
			if (err == nil) != (wantErr == nil) {
				t.Fatalf("AvailableMemoryBytes() error = %v, want error-ness to match plain /proc/meminfo read (%v)", err, wantErr)
			}
			// Tolerance, not exact equality: these are two independent live
			// /proc/meminfo reads a moment apart, which can legitimately
			// differ by a few KB under normal system load (the same class of
			// flakiness fixed in internal/compute's own chunk-budget test).
			if err == nil && !closeEnough(float64(got), float64(want)) {
				t.Errorf("AvailableMemoryBytes() = %d, want approximately the plain /proc/meminfo value %d (cgroup limit should be ignored as unbounded)", got, want)
			}
		})
	}
}

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

// TestApplyGoMemoryLimit is the regression test for the actual fix to a
// real production OOM: without a GOMEMLIMIT set, Go's GC has no awareness
// of a container's real memory ceiling at all, and only reacts to its own
// default heap-doubling schedule — confirmed in production, a real
// Precision-tier pass's buffers (already shrunk once) still drove the
// website box's container to an OOM kill whose cgroup memory.peak landed
// within 4KB of its exact memory.max. This checks that ApplyGoMemoryLimit
// actually sets a real, non-default limit at the expected fraction of
// total memory, not just that it runs without panicking.
func TestApplyGoMemoryLimit(t *testing.T) {
	total, err := TotalMemoryBytes()
	if err != nil {
		t.Skipf("no total memory available on this platform: %v", err)
	}
	orig := debug.SetMemoryLimit(-1) // -1 reads the current limit without changing it
	defer debug.SetMemoryLimit(orig) // restore whatever this test suite's process already had

	ApplyGoMemoryLimit()
	got := debug.SetMemoryLimit(-1)

	want := int64(float64(total) * goMemLimitFraction)
	if !closeEnough(float64(got), float64(want)) {
		t.Errorf("GOMEMLIMIT = %d, want approximately %d (%.0f%% of total memory %d)", got, want, goMemLimitFraction*100, total)
	}
}
