package progress

import "testing"

func TestLastBackendReflectsMostRecentSetBackend(t *testing.T) {
	w := New(t.TempDir())

	if got := w.LastBackend(); got != "" {
		t.Errorf("LastBackend() on a fresh Writer = %q, want empty", got)
	}

	w.SetBackend("remote_gpu")
	if got := w.LastBackend(); got != "remote_gpu" {
		t.Errorf("LastBackend() = %q, want %q", got, "remote_gpu")
	}

	w.SetBackend("cpu")
	if got := w.LastBackend(); got != "cpu" {
		t.Errorf("LastBackend() = %q, want %q (should reflect the most recent call)", got, "cpu")
	}

	// A new stage clears the backend label (see Update) — it hasn't picked
	// one yet, and carrying over the previous stage's label would be
	// misleading for a stage that ends up using a different backend.
	w.Update("computing_coverage_precision", 0, 1, "starting")
	if got := w.LastBackend(); got != "" {
		t.Errorf("LastBackend() after a new stage = %q, want cleared to empty", got)
	}
}
