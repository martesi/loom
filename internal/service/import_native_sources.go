package service

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"loom/internal/store"
)

type nativeImportSource struct {
	path     string
	identity string
}

// importNativePaths consumes paths selected through a native picker or file
// clipboard, not strings provided by the renderer.
func importNativePaths(repoPath string, paths []string, mode string, place bool, x, y float64) ([]int64, error) {
	if len(paths) == 0 || len(paths) > maxClipboardItems {
		return nil, fmt.Errorf("import must contain 1 to %d files", maxClipboardItems)
	}
	repoPath, err := filepath.Abs(repoPath)
	if err != nil {
		return nil, err
	}
	repoPath, err = filepath.EvalSymlinks(repoPath)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var total int
	media := make([]ClipboardMedia, 0, len(paths))
	sources := make([]nativeImportSource, 0, len(paths))
	for _, input := range paths {
		path, err := prepareNativeSource(repoPath, input, mode == importMove)
		if err != nil {
			return nil, err
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		data, identity, err := readNativeImportSource(path, min(maxClipboardItemBytes, maxClipboardBatchSize-total))
		if err != nil {
			return nil, err
		}
		total += len(data)
		media = append(media, ClipboardMedia{Name: filepath.Base(path), Data: base64.StdEncoding.EncodeToString(data)})
		sources = append(sources, nativeImportSource{path, identity})
	}
	return importPreparedBatch(repoPath, media, sources, mode, place, x, y, os.Link)
}

func readNativeImportSource(path string, limit int) ([]byte, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil || !before.Mode().IsRegular() {
		return nil, "", errors.Join(err, fmt.Errorf("invalid native import file %q", filepath.Base(path)))
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 || len(data) > limit {
		return nil, "", fmt.Errorf("native import is empty or exceeds the remaining size limit")
	}
	now, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, now) || before.Size() != int64(len(data)) || !before.ModTime().Equal(now.ModTime()) {
		return nil, "", errors.Join(err, fmt.Errorf("native import source changed"))
	}
	return data, store.FileIdentityAt(path, now), nil
}
