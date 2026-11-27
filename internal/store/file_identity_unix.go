//go:build linux || darwin || freebsd || openbsd || netbsd || dragonfly || solaris

package store

import (
	"fmt"
	"os"
	"syscall"
)

func fileIdentityAt(_ string, info os.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%x:%x", uint64(stat.Dev), uint64(stat.Ino))
}
