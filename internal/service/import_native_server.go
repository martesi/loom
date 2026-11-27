//go:build server

package service

import "fmt"

func (s *ImageService) ImportNativePicker(_ string) ([]int64, error) {
	return nil, fmt.Errorf("native import picker is unavailable in browser mode")
}

func (s *ImageService) PasteNativeFiles(_ string, _ bool, _, _ float64) ([]int64, error) {
	return nil, fmt.Errorf("native file paste is unavailable in browser mode")
}
