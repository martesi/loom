//go:build !windows

package store

import "os"

func platformFileIdentityAt(_ string, _ os.FileInfo) string { return "" }
