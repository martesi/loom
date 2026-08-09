//go:build server

package service

// IsServerMode reports whether this binary is running as a headless web
// server rather than a native desktop app. See the !server build's
// counterpart in system_service_desktop.go for the frontend-facing
// rationale.
func (s *SystemService) IsServerMode() bool {
	return true
}
