//go:build !linux && !darwin && !freebsd && !openbsd && !netbsd && !dragonfly && !solaris && !windows

package store

import "os"

func fileIdentityAt(string, os.FileInfo) string { return "" }
