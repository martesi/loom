package service

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
)

func renameImportEntry(source, target string) error {
	return unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE)
}

func linkCapabilityError(err error) bool {
	return errors.Is(err, errors.ErrUnsupported) || errors.Is(err, os.ErrPermission) || errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EXDEV)
}
