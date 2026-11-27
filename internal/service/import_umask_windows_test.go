//go:build windows

package service

func currentProcessUmask() uint32 { return 0 }
