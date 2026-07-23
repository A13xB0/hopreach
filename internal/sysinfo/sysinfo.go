// Package sysinfo reads how much memory this process can actually use —
// Linux only, which matches every box this project actually runs on
// (Docker/LXC on Linux). Used to auto-size how much elevation grid memory a
// single geographic tile's demgrid.Load call is allowed to need (see
// compute.Engine's chunk-budget auto-sizing and cmd/hopreach-gpuworker's
// own memory report to the broker), rather than requiring a hand-tuned
// config value that has to be re-picked by hand whenever a box's RAM
// changes — which is exactly what happened repeatedly in production while
// chasing a real OOM: the same "how much RAM does this box actually have
// free right now" question, answered by hand each time.
//
// Prefers this container's own cgroup memory limit/usage over
// /proc/meminfo when one is actually configured — confirmed in production
// that plain /proc/meminfo can be badly wrong inside a container: a Docker
// container with no explicit --memory limit, run inside an LXC that itself
// only gets 2GB from its host, reported /proc/meminfo's MemTotal as the
// underlying physical host's full ~65GB and MemAvailable as ~18GB — neither
// figure bore any relation to the ~2GB this process could actually use
// before getting OOM-killed. A cgroup memory limit, once one is actually
// set on the container, doesn't have that problem: it's the number Docker
// itself enforces, so reading it back is authoritative by construction.
package sysinfo

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// cgroupUnboundedThreshold: a "limit" at or above this is treated as no
// real limit at all. cgroup v1's memory.limit_in_bytes defaults to a huge
// sentinel (often near int64 max) when nothing was actually configured;
// cgroup v2 uses the literal string "max" instead, handled separately in
// readCgroupUint. No real deployment of this project needs anywhere close
// to 1PiB, so this is a safe cutoff either way.
const cgroupUnboundedThreshold = 1 << 50

// Paths for cgroup v2 (preferred — the default on any current Docker/Linux
// host) and v1 (older kernels/Docker configs) memory accounting. Package
// vars, not consts, so tests can point them at a temp file instead of
// depending on whatever cgroup state happens to be true of the machine
// actually running the test.
var (
	cgroupV2MemMaxPath     = "/sys/fs/cgroup/memory.max"
	cgroupV2MemCurrentPath = "/sys/fs/cgroup/memory.current"
	cgroupV1MemLimitPath   = "/sys/fs/cgroup/memory/memory.limit_in_bytes"
	cgroupV1MemUsagePath   = "/sys/fs/cgroup/memory/memory.usage_in_bytes"
)

// cgroupMemoryLimit returns this container's own memory ceiling, if one is
// actually configured (cgroup v2 checked first, v1 as fallback) — ok=false
// if no real, finite limit is set (no --memory/mem_limit was ever passed to
// docker run/compose, this isn't running in a container at all, or the
// cgroup filesystem isn't mounted the way this expects), in which case the
// caller should fall back to /proc/meminfo.
func cgroupMemoryLimit() (limit uint64, ok bool) {
	if v, err := readCgroupUint(cgroupV2MemMaxPath); err == nil && v > 0 && v < cgroupUnboundedThreshold {
		return v, true
	}
	if v, err := readCgroupUint(cgroupV1MemLimitPath); err == nil && v > 0 && v < cgroupUnboundedThreshold {
		return v, true
	}
	return 0, false
}

// cgroupMemoryUsage returns this container's current memory usage, paired
// with cgroupMemoryLimit to derive real available memory as limit-usage.
func cgroupMemoryUsage() (usage uint64, ok bool) {
	if v, err := readCgroupUint(cgroupV2MemCurrentPath); err == nil {
		return v, true
	}
	if v, err := readCgroupUint(cgroupV1MemUsagePath); err == nil {
		return v, true
	}
	return 0, false
}

// readCgroupUint reads a whole-file single-integer cgroup accounting file.
// cgroup v2's memory.max is either a plain integer or the literal string
// "max" (no limit set) — the latter is reported as an error so callers'
// existing err != nil handling covers it without a separate check.
func readCgroupUint(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	s := strings.TrimSpace(string(data))
	if s == "max" {
		return 0, fmt.Errorf("sysinfo: %s is unbounded (%q)", path, s)
	}
	return strconv.ParseUint(s, 10, 64)
}

// AvailableMemoryBytes returns how much memory this process can actually
// still allocate: this container's own cgroup limit minus its current
// usage, when a real limit is configured, since that's authoritative by
// construction (Docker enforces exactly that number); otherwise Linux's own
// "MemAvailable" estimate from /proc/meminfo, an estimate of memory
// available for starting new applications, without swapping, that already
// accounts for reclaimable page cache and buffers — unlike MemFree, which
// undercounts by treating all cached memory as unavailable (present since
// Linux 3.14). Returns an error only if neither source works (non-Linux,
// including this project's own test runs on other platforms, or a
// pre-3.14 kernel without cgroups) — callers should fall back to a fixed
// default in that case, not fail outright.
func AvailableMemoryBytes() (uint64, error) {
	if limit, ok := cgroupMemoryLimit(); ok {
		usage, _ := cgroupMemoryUsage() // best-effort; 0 usage is a safe (if pessimistic in the wrong direction — it would overstate availability) fallback if unreadable
		if usage >= limit {
			return 0, nil
		}
		return limit - usage, nil
	}
	return meminfoField("MemAvailable:")
}

// TotalMemoryBytes returns this container's own cgroup memory limit if one
// is configured, otherwise /proc/meminfo's "MemTotal" — the box's whole
// installed RAM, not accounting for what's currently in use. Used only for
// reporting (the analytics page's hardware panel), never for the chunk-
// budget auto-sizing, which needs AvailableMemoryBytes instead.
func TotalMemoryBytes() (uint64, error) {
	if limit, ok := cgroupMemoryLimit(); ok {
		return limit, nil
	}
	return meminfoField("MemTotal:")
}

func meminfoField(prefix string) (uint64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, fmt.Errorf("sysinfo: opening /proc/meminfo: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, fmt.Errorf("sysinfo: malformed %s line %q", prefix, line)
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("sysinfo: parsing %s %q: %w", prefix, fields[1], err)
		}
		return kb * 1024, nil
	}
	return 0, fmt.Errorf("sysinfo: no %s field in /proc/meminfo", prefix)
}

// CPUModel returns /proc/cpuinfo's first "model name" field — a
// human-readable CPU description (e.g. "Intel(R) Xeon(R) ..."), used only
// for the analytics page's hardware panel. Returns an error on non-Linux
// or if the field is missing (some ARM kernels omit it — callers should
// treat that as "unknown", not fatal).
func CPUModel() (string, error) {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "", fmt.Errorf("sysinfo: opening /proc/cpuinfo: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "model name") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		return strings.TrimSpace(parts[1]), nil
	}
	return "", fmt.Errorf("sysinfo: no model name field in /proc/cpuinfo")
}
