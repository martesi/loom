//go:build windows

package store

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func fileIdentityAt(path string, infoAtPath os.FileInfo) string {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	flags := uint32(windows.FILE_FLAG_BACKUP_SEMANTICS)
	if infoAtPath.Mode()&os.ModeSymlink != 0 {
		flags |= windows.FILE_FLAG_OPEN_REPARSE_POINT
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return ""
	}
	return fmt.Sprintf("%08x:%08x%08x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
}
