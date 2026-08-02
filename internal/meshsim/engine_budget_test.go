package meshsim

import "testing"

// Item 9: the airtime duty-cycle budget — a node's own rolling allowance
// and what happens to a sender that exhausts it.

// --- item 9: airtime duty-cycle budget -----------------------------------
//
// txBudget's own formulas are cheap and precise to test directly, rather
// than only proving the behavior indirectly through a Run() that needs to
// drain a full simulated hour's worth of airtime — see
// TestRunDutyCycleBudgetThrottlesHeavySender below for that integration
// check.

func TestTxBudgetInitialValueIsHalfTheWindow(t *testing.T) {
	b := newTxBudget()
	want := dutyCycleWindowMs * dutyCycleFactor
	if b.remainingMs != want {
		t.Errorf("newTxBudget().remainingMs = %v, want %v (real firmware boots with a full 50%% duty-cycle budget)", b.remainingMs, want)
	}
}

func TestTxBudgetRefillCapsAtMax(t *testing.T) {
	b := newTxBudget()
	b.remainingMs = 0
	b.refill(dutyCycleWindowMs * 10) // absurdly long elapsed time
	want := dutyCycleWindowMs * dutyCycleFactor
	if b.remainingMs != want {
		t.Errorf("refill after a huge elapsed time = %v, want capped at %v", b.remainingMs, want)
	}
}

func TestTxBudgetRefillAccruesAtDutyCycleFactor(t *testing.T) {
	b := txBudget{remainingMs: 0, lastUpdateMs: 0}
	b.refill(1000)
	want := 1000.0 * dutyCycleFactor
	if b.remainingMs != want {
		t.Errorf("refill(1000ms) = %v, want %v (dutyCycleFactor %v)", b.remainingMs, want, dutyCycleFactor)
	}
}

func TestTxBudgetDeferralMsZeroWhenBudgetSufficient(t *testing.T) {
	b := newTxBudget()
	if got := b.deferralMs(1000); got != 0 {
		t.Errorf("deferralMs with a full budget = %d, want 0", got)
	}
}

func TestTxBudgetDeferralMsWaitsForHalfTheEstAirtime(t *testing.T) {
	// Needs 300/2=150ms of budget but only has 100 — a 50ms deficit at a
	// 0.5 refill rate takes 100ms of elapsed time to make up.
	b := txBudget{remainingMs: 100}
	got := b.deferralMs(300)
	want := uint32(100)
	if got != want {
		t.Errorf("deferralMs(300) with 100ms budget = %d, want %d", got, want)
	}
}

func TestTxBudgetSpendFloorsAtZero(t *testing.T) {
	b := txBudget{remainingMs: 50}
	b.spend(200)
	if b.remainingMs != 0 {
		t.Errorf("spend(200) with 50ms budget = %v, want floored at 0", b.remainingMs)
	}
}

// TestRunDutyCycleBudgetThrottlesHeavySender is the Run()-level integration
// check: a node sending far more near-max-size traffic than a 50% duty
// cycle allows must eventually get throttled — a real listener sees at
// least one reception whose sender was deferred by its own budget, a
// distinct cause from every other gate this package already models (CAD,
// hop limits, loop.detect).
func TestRunDutyCycleBudgetThrottlesHeavySender(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 20}},
	}

	// With firmware-accurate TX serialization a single radio airs these
	// back-to-back, so the budget drains at (spend − refill) per frame.
	// Max-size frames sit EXACTLY on the gate's knife edge (refill per
	// frame = airtime·factor = est/minTxBudgetAirtimeDiv = the threshold,
	// for factor 0.5 and div 2) and never defer — matching firmware's own
	// arithmetic for gapless max-size sends. Half-size frames refill less
	// than the max-size-est threshold and throttle properly; the old
	// fixture only "worked" via the physically impossible
	// everything-at-once burst.
	payload := maxTransUnitBytes / 2
	frameAirtime := AirtimeMs(DefaultNodePrefs().Radio, payload)
	n := int(dutyCycleWindowMs*dutyCycleFactor/((1-dutyCycleFactor)*float64(frameAirtime))) + 400
	messages := make([]Message, n)
	for i := range messages {
		messages[i] = Message{Origin: 0, SendAtMs: uint32(i), PayloadLen: payload}
	}

	report := Run(scenario, messages, zeroRNG{}, dutyCycleWindowMs*2)

	sawDeferred := false
	for _, r := range report.Receptions {
		if r.SenderWasBudgetDeferred {
			sawDeferred = true
			break
		}
	}
	if !sawDeferred {
		t.Error("expected at least one reception whose sender was deferred by its own duty-cycle budget after far exceeding a 50% duty cycle")
	}
}
