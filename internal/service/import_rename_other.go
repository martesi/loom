//go:build !linux && !darwin && !windows

package service

import "errors"

func renameImportEntry(_, _ string) error {
	return errors.ErrUnsupported
}

func linkCapabilityError(err error) bool { return errors.Is(err, errors.ErrUnsupported) }
