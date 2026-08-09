//go:build !server

package service

// IsServerMode reports whether this binary is running as a headless web
// server rather than a native desktop app. The frontend uses it to decide
// between native-only affordances (folder-picker dialogs, spawning new OS
// windows, revealing files in the local file explorer) and their
// browser-appropriate substitutes.
func (s *SystemService) IsServerMode() bool {
	return false
}
