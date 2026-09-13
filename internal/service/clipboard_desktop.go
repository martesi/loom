//go:build !server

package service

import (
	"encoding/base64"
	"fmt"
	"loom/internal/nativeclipboard"
	"loom/internal/store"
	"os"
	"path/filepath"
)

func (s *ImageService) CopyNative(repoPath string, ids []int64, converted bool) error {
	media, err := s.CopyMedia(repoPath, ids, converted)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "loom-clipboard-")
	if err != nil {
		return err
	}
	paths := make([]string, 0, len(media))
	for i, item := range media {
		data, err := base64.StdEncoding.DecodeString(item.Data)
		if err != nil {
			os.RemoveAll(dir)
			return err
		}
		path := filepath.Join(dir, fmt.Sprintf("%d-%s", i, filepath.Base(item.Name)))
		if err := os.WriteFile(path, data, 0o600); err != nil {
			os.RemoveAll(dir)
			return err
		}
		paths = append(paths, path)
	}
	if err := nativeclipboard.Write(paths); err != nil {
		os.RemoveAll(dir)
		return err
	}
	// Native file clipboards refer to paths; files must outlive this RPC.
	return nil
}
func (s *ImageService) ReadNative() ([]ClipboardMedia, error) {
	paths, err := nativeclipboard.Read()
	if err != nil {
		return nil, err
	}
	media := make([]ClipboardMedia, 0, len(paths))
	for _, path := range paths {
		if !store.IsMediaFile(path) {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		media = append(media, ClipboardMedia{Name: filepath.Base(path), Data: base64.StdEncoding.EncodeToString(data)})
	}
	if len(media) == 0 {
		return nil, fmt.Errorf("clipboard contains no media files")
	}
	return media, nil
}
