package sources

import (
	"context"
	"testing"

	"hopreach/internal/config"
	"hopreach/internal/meshsource"
)

// A configured region list is how a backend that cannot enumerate regions
// still gets the region features. The risk to guard is the opposite of the
// usual one: claiming a complete catalogue when nobody supplied one.

type stubSource struct {
	meshsource.Source
	scopes []string
}

func (s stubSource) Name() string { return "stub" }
func (s stubSource) Capabilities() meshsource.Capabilities {
	return meshsource.Capabilities{ScopeCatalog: false}
}
func (s stubSource) FetchScopes(context.Context) ([]string, error) { return s.scopes, nil }

func TestConfiguredScopesReplaceThePartialBackendList(t *testing.T) {
	// The backend can only see the regions it has local observers for; the
	// operator knows the rest.
	src := withConfiguredScopes{
		Source: stubSource{scopes: []string{"#sco"}},
		names:  []string{"#sco", "#fif", "#tay"},
	}
	got, err := src.FetchScopes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Errorf("scopes = %v, want the configured list", got)
	}
	if !src.Capabilities().ScopeCatalog {
		t.Error("a configured list IS a complete catalogue — the region " +
			"features should switch back on")
	}
}

func TestNoConfiguredScopesLeavesTheBackendsAnswerAlone(t *testing.T) {
	// Silence must not be read as an assertion of completeness.
	src, err := FromConfig(config.Config{
		Source:    config.SourceConfig{Type: config.SourceCoreScope},
		CoreScope: config.CoreScopeConfig{APIURL: "http://example.invalid"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, wrapped := src.(withConfiguredScopes); wrapped {
		t.Error("no scopes configured, so nothing should be overriding the backend")
	}
}

func TestBlankEntriesDoNotCountAsAList(t *testing.T) {
	// A yaml key left as `scopes: [""]` or with stray whitespace is not an
	// operator asserting anything, and must not flip the capability on.
	src, err := FromConfig(config.Config{
		Source: config.SourceConfig{
			Type:   config.SourceCoreScope,
			Scopes: []string{"", "   "},
		},
		CoreScope: config.CoreScopeConfig{APIURL: "http://example.invalid"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, wrapped := src.(withConfiguredScopes); wrapped {
		t.Error("blank entries are not a region list")
	}
}

func TestConfiguredScopesWorkForAnyBackend(t *testing.T) {
	// Deliberately not Beacon-specific: a CoreScope instance whose region
	// list is incomplete benefits from the same override.
	src, err := FromConfig(config.Config{
		Source: config.SourceConfig{
			Type:   config.SourceCoreScope,
			Scopes: []string{"#sco"},
		},
		CoreScope: config.CoreScopeConfig{APIURL: "http://example.invalid"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !src.Capabilities().ScopeCatalog {
		t.Error("configured scopes should satisfy the catalogue capability")
	}
	if src.Name() != "corescope" {
		t.Errorf("Name() = %q — the wrapper must delegate everything else", src.Name())
	}
}
