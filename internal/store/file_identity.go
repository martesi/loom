package store

import "os"

// FileIdentityAt returns a stable identity for a regular file or symlink at path. It
// returns an empty string when the current platform cannot prove identity.
func FileIdentityAt(path string, info os.FileInfo) string {
	if info == nil || (!info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0) {
		return ""
	}
	return fileIdentityAt(path, info)
}
