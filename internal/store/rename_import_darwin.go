//go:build darwin

package store

import "golang.org/x/sys/unix"

func renameImportNoReplace(source, destination string) error {
	return unix.RenamexNp(source, destination, unix.RENAME_EXCL)
}
