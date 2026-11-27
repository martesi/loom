package store

import (
	"errors"
	"golang.org/x/sys/windows"
)

// RenameNoReplace atomically moves a directory entry into an unused name.
func RenameNoReplace(source, target string) error {
	src, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	dst, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(src, dst, windows.MOVEFILE_WRITE_THROUGH)
}

func renameCrossDevice(err error) bool { return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE) }
