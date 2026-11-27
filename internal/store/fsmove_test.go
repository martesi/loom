package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRenameNoReplacePreservesDanglingDirectoryEntry(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.png")
	slot := filepath.Join(root, "slot.png")
	missing := filepath.Join(root, "not-there.png")
	if err := os.WriteFile(source, []byte("source bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(missing, slot); err != nil {
		t.Skipf("requires symlink support: %v", err)
	}
	selected, err := uniquePath(slot)
	if err != nil || selected != filepath.Join(root, "slot (1).png") {
		t.Fatalf("unique path treated dangling link as vacant: %q, %v", selected, err)
	}
	// The same helper is used for rollback. A race occupying the exact
	// destination must fail rather than replace the newly created link.
	if err := moveFileOnDisk(source, slot); err == nil {
		t.Fatal("move clobbered an existing link")
	}
	if got, err := os.Readlink(slot); err != nil || got != missing {
		t.Fatalf("dangling link changed: %q, %v", got, err)
	}
	if got, err := os.ReadFile(source); err != nil || string(got) != "source bytes" {
		t.Fatalf("source changed: %q, %v", got, err)
	}
}

func TestCrossVolumeCopyRefusesToDereferenceSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "outside.png")
	source := filepath.Join(root, "link.png")
	dest := filepath.Join(root, "next.png")
	if err := os.WriteFile(target, []byte("external source"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, source); err != nil {
		t.Skipf("requires symlink support: %v", err)
	}
	if err := copyEntryAcrossDevice(source, dest); err == nil {
		t.Fatal("cross-volume fallback dereferenced a symlink")
	}
	if _, err := os.Lstat(dest); !os.IsNotExist(err) {
		t.Fatalf("unexpected destination entry: %v", err)
	}
	if got, err := os.Readlink(source); err != nil || got != target {
		t.Fatalf("source symlink changed: %q, %v", got, err)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "external source" {
		t.Fatalf("source bytes changed: %q, %v", got, err)
	}
}
