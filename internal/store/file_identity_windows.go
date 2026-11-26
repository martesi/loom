//go:build windows

package store

import (
	"os"
	"syscall"
)

func platformFileIdentityAt(path string, info os.FileInfo) string {
	if path == "" {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()

	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) {
		return ""
	}
	var fileInfo syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &fileInfo); err != nil {
		return ""
	}
	return windowsFileIdentityParts(fileInfo.VolumeSerialNumber, fileInfo.FileIndexHigh, fileInfo.FileIndexLow)
}
