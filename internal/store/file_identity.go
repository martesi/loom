package store

import "os"

// FileIdentityAt returns a stable identity for a regular file at path. It
// returns an empty string when the current platform cannot prove identity.
func FileIdentityAt(path string, info os.FileInfo) string {
	if info == nil || !info.Mode().IsRegular() {
		return ""
	}
	return fileIdentityAt(path, info)
}
