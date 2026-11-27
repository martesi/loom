//go:build !server

package service

import (
	"loom/internal/nativeclipboard"
	"loom/internal/store"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func (s *ImageService) ImportNativePicker(repoPath string) ([]int64, error) {
	app := application.Get()
	dialog := app.Dialog.OpenFile().SetTitle("Import media").CanChooseFiles(true)
	if window := app.Window.Current(); window != nil {
		dialog = dialog.AttachToWindow(window)
	}
	paths, err := dialog.PromptForMultipleSelection()
	if err != nil || len(paths) == 0 {
		return nil, err
	}
	value, err := (&SettingsService{}).Get(repoPath, importModeSetting)
	if err != nil {
		return nil, err
	}
	mode, err := parseImportMode(value)
	if err != nil {
		return nil, err
	}
	return importNativePaths(repoPath, paths, mode, false, 0, 0)
}

func (s *ImageService) PasteNativeFiles(repoPath string, place bool, x, y float64) ([]int64, error) {
	paths, move, err := nativeclipboard.ReadIntent()
	if err != nil {
		return nil, err
	}
	var selected []string
	for _, path := range paths {
		if store.IsMediaFile(filepath.Base(path)) {
			selected = append(selected, path)
		}
	}
	mode := importCopy
	if move {
		mode = importMove
	}
	return importNativePaths(repoPath, selected, mode, place, x, y)
}
