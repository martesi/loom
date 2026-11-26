//go:build linux || darwin || freebsd || openbsd || netbsd || dragonfly || solaris

package service

import "syscall"

func currentProcessUmask() uint32 {
	mask := syscall.Umask(0)
	syscall.Umask(mask)
	return uint32(mask)
}
