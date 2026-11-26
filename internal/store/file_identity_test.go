package store

import "testing"

func TestWindowsFileIdentityPartsUseVolumeAndFullFileIndex(t *testing.T) {
	got := windowsFileIdentityParts(0x1234, 0x89abcdef, 0x01234567)
	if got != "1234:89abcdef01234567" {
		t.Fatalf("Windows volume/file-index identity = %q", got)
	}
	if windowsFileIdentityParts(0x1235, 0x89abcdef, 0x01234567) == got {
		t.Fatal("different Windows volume produced the same identity")
	}
	if windowsFileIdentityParts(0x1234, 0x89abcdee, 0x01234567) == got {
		t.Fatal("different Windows file index produced the same identity")
	}
}
