package service

import "testing"

// TestSettingsServiceGetSetRoundTrip exercises the thin Get/Set wrapper over
// the repo-scoped settings table: a round-trip through Set/Get, an unset key
// coming back as "" with no error (matching the store package's existing
// UndoCursor convention — see internal/store/oplog.go), and Set overwriting
// a previously-set value.
func TestSettingsServiceGetSetRoundTrip(t *testing.T) {
	repoPath := t.TempDir()
	settings := &SettingsService{}

	// Unset key: "" and no error, not a lookup failure.
	v, err := settings.Get(repoPath, "panel.visible")
	if err != nil {
		t.Fatalf("Get (unset): unexpected error: %v", err)
	}
	if v != "" {
		t.Fatalf("Get (unset): expected empty string, got %q", v)
	}

	// Set then Get round-trip.
	if err := settings.Set(repoPath, "panel.visible", "true"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	v, err = settings.Get(repoPath, "panel.visible")
	if err != nil {
		t.Fatalf("Get (after Set): %v", err)
	}
	if v != "true" {
		t.Fatalf("Get (after Set): expected %q, got %q", "true", v)
	}

	// Set again overwrites rather than erroring/duplicating.
	if err := settings.Set(repoPath, "panel.visible", "false"); err != nil {
		t.Fatalf("Set (overwrite): %v", err)
	}
	v, err = settings.Get(repoPath, "panel.visible")
	if err != nil {
		t.Fatalf("Get (after overwrite): %v", err)
	}
	if v != "false" {
		t.Fatalf("Get (after overwrite): expected %q, got %q", "false", v)
	}

	// A different key on the same repo stays independent.
	v, err = settings.Get(repoPath, "panel.dock_side")
	if err != nil {
		t.Fatalf("Get (other key): %v", err)
	}
	if v != "" {
		t.Fatalf("Get (other key): expected empty string, got %q", v)
	}
}
