// Package sysinfo reads basic host memory info from /proc/meminfo — Linux
// only, which matches every box this project actually runs on (Docker/LXC
// on Linux). Used to auto-size how much elevation grid memory a single
// geographic tile's demgrid.Load call is allowed to need (see
// compute.Engine's chunk-budget auto-sizing and cmd/hopreach-gpuworker's
// own memory report to the broker), rather than requiring a hand-tuned
// config value that has to be re-picked by hand whenever a box's RAM
// changes — which is exactly what happened repeatedly in production while
// chasing a real OOM: the same "how much RAM does this box actually have
// free right now" question, answered by hand each time.
package sysinfo

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// AvailableMemoryBytes returns Linux's own "MemAvailable" estimate from
// /proc/meminfo: an estimate of memory available for starting new
// applications, without swapping, that already accounts for reclaimable
// page cache and buffers — unlike MemFree, which undercounts by treating
// all cached memory as unavailable (present since Linux 3.14). Returns an
// error if /proc/meminfo doesn't exist (non-Linux, including this
// project's own test runs on other platforms) or doesn't have the expected
// field (pre-3.14 kernels) — callers should fall back to a fixed default
// in that case, not fail outright.
func AvailableMemoryBytes() (uint64, error) {
	return meminfoField("MemAvailable:")
}

// TotalMemoryBytes returns /proc/meminfo's "MemTotal" — the box's whole
// installed RAM, not accounting for what's currently in use. Used only for
// reporting (the analytics page's hardware panel), never for the chunk-
// budget auto-sizing, which needs AvailableMemoryBytes instead.
func TotalMemoryBytes() (uint64, error) {
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
