package store

import (
	"errors"
	"golang.org/x/sys/unix"
)

// RenameNoReplace atomically moves a directory entry into an unused name.
func RenameNoReplace(source, target string) error {
	return unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE)
}

func renameCrossDevice(err error) bool { return errors.Is(err, unix.EXDEV) }
