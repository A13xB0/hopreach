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
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, fmt.Errorf("sysinfo: opening /proc/meminfo: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "MemAvailable:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, fmt.Errorf("sysinfo: malformed MemAvailable line %q", line)
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("sysinfo: parsing MemAvailable %q: %w", fields[1], err)
		}
		return kb * 1024, nil
	}
	return 0, fmt.Errorf("sysinfo: no MemAvailable field in /proc/meminfo")
}
