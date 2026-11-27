//go:build !linux && !darwin && !windows

package service

import "errors"

func linkCapabilityError(err error) bool { return errors.Is(err, errors.ErrUnsupported) }
