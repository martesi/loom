package store

import (
	"errors"
	"os"
	"path/filepath"
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
