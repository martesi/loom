package service

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
)

// SystemService wraps small OS-native affordances that don't belong to any
// one repo/image concept — currently just "reveal in file explorer".
// Wails v3's application package has no built-in helper for this (checked
// pkg/application — only dialogs/clipboard/browser-open), so this shells
// out per-OS the way the spec anticipated.
type SystemService struct{}

// RevealInFileExplorer opens the OS file browser with path selected (where
// the platform tool supports selection) or, failing that, its containing
// folder open.
func (s *SystemService) RevealInFileExplorer(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", "/select,", path)
	case "darwin":
		cmd = exec.Command("open", "-R", path)
	default:
		// xdg-open has no "select this file" concept on Linux — the
		// closest cross-desktop-environment behavior is opening the
		// containing folder.
		cmd = exec.Command("xdg-open", filepath.Dir(path))
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("reveal in file explorer: %w", err)
	}
	return nil
}
