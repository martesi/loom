//go:build !linux && !darwin && !windows

package store

import "fmt"

func renameImportNoReplace(_, _ string) error {
	return fmt.Errorf("exclusive import-file quarantine is unsupported on this platform")
}
