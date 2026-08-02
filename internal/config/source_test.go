package config

import "testing"

// source.type decides which mesh HopReach draws. Getting it wrong silently —
// rendering one network's coverage while claiming another's — is the failure
// worth guarding against, so an unknown value is an error rather than a
// fallback.

func TestResolveDefaultsToCoreScope(t *testing.T) {
	// Every deployment predating source.type is running CoreScope with no
	// such key, and must keep working untouched.
	got, err := Config{}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if got != SourceCoreScope {
		t.Errorf("empty config resolved to %q, want %q", got, SourceCoreScope)
	}
}

func TestResolveHonoursExplicitType(t *testing.T) {
	for _, want := range []string{SourceCoreScope, SourceBeacon} {
		got, err := Config{Source: SourceConfig{Type: want}}.Resolve()
		if err != nil {
			t.Fatalf("%s: %v", want, err)
		}
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
}

func TestResolveAcceptsSurroundingWhitespaceAndCase(t *testing.T) {
	// A hand-edited YAML file is the normal way this gets set.
	got, err := Config{Source: SourceConfig{Type: "  Beacon "}}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if got != SourceBeacon {
		t.Errorf("got %q, want %q", got, SourceBeacon)
	}
}

func TestResolveRejectsUnknownType(t *testing.T) {
	// Not a fallback to the default: a typo would then quietly render the
	// wrong network's map, which looks entirely plausible.
	if _, err := (Config{Source: SourceConfig{Type: "beocon"}}).Resolve(); err == nil {
		t.Fatal("an unknown source.type must be an error, not a silent default")
	}
}

func TestDeprecatedBeaconEnabledStillWorks(t *testing.T) {
	// beacon.enabled predates source.type and lives in a deployed config.
	got, err := Config{Beacon: BeaconConfig{Enabled: true}}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if got != SourceBeacon {
		t.Errorf("beacon.enabled resolved to %q, want %q", got, SourceBeacon)
	}
}

func TestExplicitTypeBeatsTheDeprecatedFlag(t *testing.T) {
	// If someone sets source.type while an old beacon.enabled is still
	// lying around, the explicit key is the one they meant.
	got, err := Config{
		Source: SourceConfig{Type: SourceCoreScope},
		Beacon: BeaconConfig{Enabled: true},
	}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if got != SourceCoreScope {
		t.Errorf("got %q, want source.type to win", got)
	}
}
