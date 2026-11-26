package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalRepoOperationRootMatchesOperationLockIdentity(t *testing.T) {
	root := t.TempDir()
	alias := filepath.Join(t.TempDir(), "repo-alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	for _, spelling := range []string{root, alias} {
		strict, err := CanonicalRepoOperationRoot(spelling)
		if err != nil {
			t.Fatal(err)
		}
		if strict != canonicalRepoPath(spelling) {
			t.Fatalf("strict identity %q differs from operation lock identity %q for %q", strict, canonicalRepoPath(spelling), spelling)
		}
	}
	rootIdentity, _ := CanonicalRepoOperationRoot(root)
	aliasIdentity, _ := CanonicalRepoOperationRoot(alias)
	if rootIdentity != aliasIdentity {
		t.Fatalf("alias identities differ: %q != %q", rootIdentity, aliasIdentity)
	}
	if _, err := CanonicalRepoOperationRoot(filepath.Join(root, "not-created")); err == nil {
		t.Fatal("strict identity accepted an unresolved repository path")
	}
	file := filepath.Join(root, "not-a-root")
	if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := CanonicalRepoOperationRoot(file); err == nil {
		t.Fatal("strict identity accepted a regular file as a repository root")
	}
}
