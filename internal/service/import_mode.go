package service

import "fmt"

const (
	importModeSetting = "import_mode"
	importCopy        = "copy"
	importMove        = "move"
	importLink        = "link"
)

func parseImportMode(value string) (string, error) {
	switch value {
	case "", importCopy:
		return importCopy, nil
	case importMove, importLink:
		return value, nil
	default:
		return "", fmt.Errorf("invalid import mode %q", value)
	}
}
