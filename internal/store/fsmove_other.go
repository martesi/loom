//go:build !linux && !darwin && !windows

package store

import "errors"

// RenameNoReplace atomically moves a directory entry into an unused name.
func RenameNoReplace(_, _ string) error {
	return errors.ErrUnsupported
}

func renameCrossDevice(err error) bool { return false }
