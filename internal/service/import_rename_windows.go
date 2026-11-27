package service

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
)

func renameImportEntry(source, target string) error {
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

func linkCapabilityError(err error) bool {
	return errors.Is(err, errors.ErrUnsupported) || errors.Is(err, os.ErrPermission) || errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) || errors.Is(err, windows.ERROR_NOT_SUPPORTED) || errors.Is(err, windows.ERROR_INVALID_FUNCTION) || errors.Is(err, windows.ERROR_NOT_SAME_DEVICE)
}
