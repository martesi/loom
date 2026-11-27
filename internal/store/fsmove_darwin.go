package store

import (
	"errors"
	"golang.org/x/sys/unix"
)

// RenameNoReplace atomically moves a directory entry into an unused name.
func RenameNoReplace(source, target string) error {
	return unix.RenamexNp(source, target, unix.RENAME_EXCL)
}

func renameCrossDevice(err error) bool { return errors.Is(err, unix.EXDEV) }
