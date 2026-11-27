package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMoveFilesWithoutReplaceCompensatesCompletedMoves(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first.png")
	firstTarget := filepath.Join(root, ".loom", "trash", "first.png")
	missing := filepath.Join(root, "missing.png")
	secondTarget := filepath.Join(root, ".loom", "trash", "missing.png")
	if err := os.WriteFile(first, []byte("original bytes"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := MoveFilesWithoutReplace([]FileMove{
		{Source: first, Destination: firstTarget},
		{Source: missing, Destination: secondTarget},
	})
	if err == nil {
		t.Fatal("batch move unexpectedly succeeded")
	}
	if got, readErr := os.ReadFile(first); readErr != nil || string(got) != "original bytes" {
		t.Fatalf("first source after compensation = %q err=%v", got, readErr)
	}
	if _, err := os.Lstat(firstTarget); !os.IsNotExist(err) {
		t.Fatalf("compensation left moved destination: %v", err)
	}
}

func TestMoveFilesWithoutReplaceNeverOverwritesDestination(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.png")
	destination := filepath.Join(root, "destination.png")
	if err := os.WriteFile(source, []byte("source bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("external bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := MoveFilesWithoutReplace([]FileMove{{Source: source, Destination: destination}})
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("destination conflict error = %v, want os.ErrExist", err)
	}
	for path, want := range map[string]string{source: "source bytes", destination: "external bytes"} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Errorf("%q = %q err=%v, want %q", path, got, err, want)
		}
	}
}

func TestRollbackLeavesExternalReplacementUntouched(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.png")
	destination := filepath.Join(root, "destination.png")
	heldOriginal := filepath.Join(root, "held-original.png")
	if err := os.WriteFile(source, []byte("batch bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	moves := []FileMove{{Source: source, Destination: destination}}
	if err := MoveFilesWithoutReplace(moves); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(destination, heldOriginal); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := RollbackFileMoves(moves)
	if err == nil || !strings.Contains(err.Error(), "file was replaced") {
		t.Fatalf("rollback error = %v, want replacement refusal", err)
	}
	for path, want := range map[string]string{
		destination:  "external replacement",
		heldOriginal: "batch bytes",
	} {
		got, readErr := os.ReadFile(path)
		if readErr != nil || string(got) != want {
			t.Errorf("%q = %q err=%v, want %q", path, got, readErr, want)
		}
	}
	if _, err := os.Lstat(source); !os.IsNotExist(err) {
		t.Fatalf("rollback moved replacement to source: %v", err)
	}
}
