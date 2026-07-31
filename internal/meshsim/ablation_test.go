package meshsim

import "testing"

// TestRunWithAblationZeroValueMatchesRun is the mandatory equivalence
// check: Run must be byte-for-byte identical to RunWithAblation with a zero-value
// AblationFlags, for every fixed seed — Run's own existing 39 test call
// sites and 4 non-test callers depend on Run's behaviour being completely
// unaffected by this file's own addition.
func TestRunWithAblationZeroValueMatchesRun(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	viaRun := Run(scenario, messages, NewSeededRNG(1), 60_000)
	viaAblation := RunWithAblation(scenario, messages, NewSeededRNG(1), 60_000, AblationFlags{})
	assertReportsEqual(t, "lockstepCollisionScenario", viaRun, viaAblation)

	scenario2 := Scenario{
		Nodes: []SimNode{testNode(false), testNode(true), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 10}, {From: 1, To: 2, SNRdB: 10}},
	}
	messages2 := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, HashSize: 2}}
	viaRun2 := Run(scenario2, messages2, NewSeededRNG(7), 60_000)
	viaAblation2 := RunWithAblation(scenario2, messages2, NewSeededRNG(7), 60_000, AblationFlags{})
	assertReportsEqual(t, "two-hop relay", viaRun2, viaAblation2)
}

// assertReportsEqual compares two Reports field-by-field rather than with
// == or reflect.DeepEqual on the whole struct — Reception has slice
// fields (CollidedWith, Path), which make plain == a compile error, and a
// manual comparison says WHICH part diverged instead of just "not equal".
func assertReportsEqual(t *testing.T, label string, a, b Report) {
	t.Helper()
	if len(a.Receptions) != len(b.Receptions) {
		t.Fatalf("%s: Receptions length differs: %d vs %d", label, len(a.Receptions), len(b.Receptions))
	}
	for i := range a.Receptions {
		ra, rb := a.Receptions[i], b.Receptions[i]
		if ra.PacketID != rb.PacketID || ra.Node != rb.Node || ra.AtMs != rb.AtMs || ra.FromNode != rb.FromNode ||
			ra.Collided != rb.Collided || ra.HopCount != rb.HopCount || ra.WasRelayed != rb.WasRelayed ||
			ra.DropReason != rb.DropReason || ra.CollisionKind != rb.CollisionKind ||
			ra.SenderWasCADDeferred != rb.SenderWasCADDeferred || ra.SenderWasBudgetDeferred != rb.SenderWasBudgetDeferred ||
			ra.SurvivedCapture != rb.SurvivedCapture ||
			!intSlicesEqual(ra.CollidedWith, rb.CollidedWith) || !intSlicesEqual(ra.Path, rb.Path) {
			t.Fatalf("%s: Reception %d differs: %+v vs %+v", label, i, ra, rb)
		}
	}
	if len(a.Transmissions) != len(b.Transmissions) {
		t.Fatalf("%s: Transmissions length differs: %d vs %d", label, len(a.Transmissions), len(b.Transmissions))
	}
	for i := range a.Transmissions {
		if a.Transmissions[i] != b.Transmissions[i] {
			t.Fatalf("%s: Transmission %d differs: %+v vs %+v", label, i, a.Transmissions[i], b.Transmissions[i])
		}
	}
}

func intSlicesEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestAblationDisableTxBusyRemovesTheTxBusyMiss(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 1, To: 0, SNRdB: 0}},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 0, PayloadLen: 20},
	}

	normal := Run(scenario, messages, zeroRNG{}, 60_000)
	ablated := RunWithAblation(scenario, messages, zeroRNG{}, 60_000, AblationFlags{DisableTxBusy: true})

	findReception := func(r Report) *Reception {
		for i := range r.Receptions {
			if r.Receptions[i].PacketID == 1 && r.Receptions[i].Node == 0 {
				return &r.Receptions[i]
			}
		}
		return nil
	}
	normalRec := findReception(normal)
	ablatedRec := findReception(ablated)
	if normalRec == nil || ablatedRec == nil {
		t.Fatal("expected a reception for packet 1 at node 0 in both runs")
	}
	if normalRec.DropReason != "tx_busy" {
		t.Fatalf("test setup: expected the normal run to show tx_busy, got %q", normalRec.DropReason)
	}
	if ablatedRec.DropReason == "tx_busy" {
		t.Error("expected DisableTxBusy to remove the tx_busy miss, but it's still reported")
	}
}

func TestAblationDisableCADRemovesTheDeferral(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0}, {From: 1, To: 0, SNRdB: 0},
			{From: 0, To: 2, SNRdB: 0}, {From: 1, To: 2, SNRdB: 0},
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 50, PayloadLen: 20},
	}

	ablated := RunWithAblation(scenario, messages, zeroRNG{}, 60_000, AblationFlags{DisableCAD: true})

	// With CAD disabled, node 1 transmits at exactly its scheduled 50ms
	// regardless of node 0's own ongoing transmission — colliding with it
	// at the shared listener, node 2, instead of being deferred until the
	// channel clears (see TestRunCADDefersSendWhenSenderCanHearOngoingTransmission,
	// the non-ablated counterpart, which asserts the opposite).
	var tx1 *Transmission
	for i := range ablated.Transmissions {
		if ablated.Transmissions[i].PacketID == 1 && ablated.Transmissions[i].Node == 1 {
			tx1 = &ablated.Transmissions[i]
		}
	}
	if tx1 == nil {
		t.Fatal("expected node 1's own transmission of packet 1")
	}
	if tx1.AtMs != 50 {
		t.Errorf("expected DisableCAD to let node 1 transmit at exactly its scheduled 50ms, got %dms", tx1.AtMs)
	}
	if tx1.CADDeferred {
		t.Error("expected CADDeferred false with CAD disabled")
	}
}

func TestAblationDisableDutyCycleRemovesBudgetDeferral(t *testing.T) {
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

	normal := Run(scenario, messages, zeroRNG{}, dutyCycleWindowMs*2)
	ablated := RunWithAblation(scenario, messages, zeroRNG{}, dutyCycleWindowMs*2, AblationFlags{DisableDutyCycle: true})

	normalDeferred := false
	for _, r := range normal.Receptions {
		if r.SenderWasBudgetDeferred {
			normalDeferred = true
			break
		}
	}
	if !normalDeferred {
		t.Fatal("test setup: expected the normal run to show at least one budget-deferred reception")
	}
	for _, r := range ablated.Receptions {
		if r.SenderWasBudgetDeferred {
			t.Error("expected DisableDutyCycle to remove every budget deferral, but at least one reception still shows SenderWasBudgetDeferred")
			break
		}
	}
}

func TestAblationDisableCaptureCorruptsTheSurvivor(t *testing.T) {
	// Exact fixture as TestRunCaptureEffectSurvivesWeakLateInterferer,
	// which asserts the OPPOSITE (SurvivedCapture=true, Collided=false).
	const strong, weak, listener = 0, 1, 2
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: strong, To: listener, SNRdB: 15},
			{From: weak, To: listener, SNRdB: 0},
		},
	}
	preambleMs := uint32(preambleDurationMs(DefaultLoRaParams()))
	messages := []Message{
		{Origin: strong, SendAtMs: 0, PayloadLen: 20},
		{Origin: weak, SendAtMs: preambleMs + 20, PayloadLen: 20},
	}

	ablated := RunWithAblation(scenario, messages, zeroRNG{}, 60_000, AblationFlags{DisableCapture: true})

	var atListenerFromStrong *Reception
	for i := range ablated.Receptions {
		r := &ablated.Receptions[i]
		if r.Node == listener && r.FromNode == strong {
			atListenerFromStrong = r
		}
	}
	if atListenerFromStrong == nil {
		t.Fatal("expected a reception at the listener from the strong sender")
	}
	if !atListenerFromStrong.Collided {
		t.Errorf("expected DisableCapture to make even a 15dB-dominant signal collide with any overlapping interferer, got Collided=false: %+v", atListenerFromStrong)
	}
	if atListenerFromStrong.SurvivedCapture {
		t.Error("expected SurvivedCapture=false with capture disabled — nothing can survive an interferer anymore")
	}
	if atListenerFromStrong.CollisionKind != "corrupted" {
		t.Errorf("expected CollisionKind %q (lock was achieved — the interferer starts after the preamble window — but capture can't save it anymore), got %q", "corrupted", atListenerFromStrong.CollisionKind)
	}
}

// TestAblationDisablePathByteAirtimeMatchesPayloadOnlyFormula proves a
// relay's own airtime, with path bytes disabled, equals AirtimeMs computed
// from the raw payload length alone — no growth with hop count, unlike
// the enabled (default) behaviour TestRunAirtimeGrowsWithHopCount asserts.
func TestAblationDisablePathByteAirtimeMatchesPayloadOnlyFormula(t *testing.T) {
	const chainLen = 4
	nodes := make([]SimNode, chainLen)
	var links []Link
	for i := 0; i < chainLen; i++ {
		nodes[i] = testNode(true)
		if i > 0 {
			links = append(links, Link{From: i - 1, To: i, SNRdB: 20})
		}
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}

	ablated := RunWithAblation(scenario, messages, zeroRNG{}, 60_000, AblationFlags{DisablePathByteAirtime: true})

	want := AirtimeMs(DefaultLoRaParams(), 20) // payload-only, every hop
	for _, tx := range ablated.Transmissions {
		if tx.PacketID != 0 {
			continue
		}
		if tx.AirtimeMs != want {
			t.Errorf("hop %d: AirtimeMs = %d, want %d (payload-only, path bytes disabled)", tx.HopCount, tx.AirtimeMs, want)
		}
		if tx.OnAirLen != tx.PayloadLen {
			t.Errorf("hop %d: OnAirLen = %d, want %d (== PayloadLen, path bytes disabled)", tx.HopCount, tx.OnAirLen, tx.PayloadLen)
		}
	}
}
