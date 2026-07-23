package gpucompute

import "testing"

// TestDispatchPixelBudgetScalesDownForDenseSites is the regression test
// for a real production incident: a Precision-tier tile with 48 sites in
// a dense cluster reliably blew the 5s dispatch watchdog and fell back to
// CPU (turning a sub-minute tile into roughly an hour), while a same-size
// tile with 45 sites dispatched normally. The fix scales the per-dispatch
// pixel budget down for site counts above baselineSitesPerDispatch — this
// locks in that scaling behaviour without needing real GPU hardware to
// exercise ComputeMargins itself.
func TestDispatchPixelBudgetScalesDownForDenseSites(t *testing.T) {
	sparse := dispatchPixelBudget(5)
	if sparse != targetPixelsPerDispatch {
		t.Errorf("dispatchPixelBudget(5) = %d, want unchanged targetPixelsPerDispatch (%d)", sparse, targetPixelsPerDispatch)
	}

	atBaseline := dispatchPixelBudget(baselineSitesPerDispatch)
	if atBaseline != targetPixelsPerDispatch {
		t.Errorf("dispatchPixelBudget(%d) = %d, want unchanged targetPixelsPerDispatch (%d)", baselineSitesPerDispatch, atBaseline, targetPixelsPerDispatch)
	}

	dense48 := dispatchPixelBudget(48)
	if dense48 >= targetPixelsPerDispatch {
		t.Errorf("dispatchPixelBudget(48) = %d, want less than targetPixelsPerDispatch (%d)", dense48, targetPixelsPerDispatch)
	}
	// The real failure was 45 sites working and 48 not — a thin margin.
	// dispatchSafetyFactor exists so the fix doesn't just barely clear
	// that specific case; require real headroom at this site count.
	if got, want := float64(targetPixelsPerDispatch)/float64(dense48), 3.0; got < want {
		t.Errorf("dispatchPixelBudget(48) shrank the budget by only %.2fx, want at least %.1fx", got, want)
	}

	// Monotonically non-increasing as site count grows.
	prev := dispatchPixelBudget(1)
	for _, n := range []int{2, 5, 10, 20, 30, 48, 68, 100} {
		got := dispatchPixelBudget(n)
		if got > prev {
			t.Errorf("dispatchPixelBudget(%d) = %d is larger than dispatchPixelBudget of a smaller site count (%d) — should be non-increasing", n, got, prev)
		}
		if got < 1 {
			t.Errorf("dispatchPixelBudget(%d) = %d, want at least 1", n, got)
		}
		prev = got
	}
}
