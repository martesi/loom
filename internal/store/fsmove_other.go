//go:build !linux && !darwin && !windows

package store

import "errors"

func renameNoReplace(string, string) error { return errors.ErrUnsupported }
