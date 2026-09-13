//go:build server

package service

import "fmt"

func (s *ImageService) CopyNative(repoPath string, ids []int64, converted bool) error {
	return fmt.Errorf("native clipboard is unavailable in browser mode")
}
func (s *ImageService) ReadNative() ([]ClipboardMedia, error) {
	return nil, fmt.Errorf("native clipboard is unavailable in browser mode")
}
