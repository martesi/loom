//go:build windows

package store

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestWindowsFileIdentityAtUsesVolumeAndFileIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.bin")
	if err := os.WriteFile(path, []byte("stable file identity"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	identity := FileIdentityAt(path, info)
	if identity == "" {
		t.Fatal("Windows file identity is empty")
	}

	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var byHandle syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &byHandle); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%x:%x", byHandle.VolumeSerialNumber, uint64(byHandle.FileIndexHigh)<<32|uint64(byHandle.FileIndexLow))
	if identity != want {
		t.Fatalf("identity = %q, want volume/file-index %q", identity, want)
	}
}
