package service

import (
	"encoding/base64"
	"fmt"
	"loom/internal/store"
	"os"
	"path/filepath"
	"strings"
)

type ClipboardMedia struct {
	Name string `json:"name"`
	Data string `json:"data"`
}

// CopyMedia transports original bytes rather than preview thumbnails or paths.
func (s *ImageService) CopyMedia(repoPath string, ids []int64, converted bool) ([]ClipboardMedia, error) {
	r, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	images, err := r.ListImagesByIDs(uniqueImageIDs(ids))
	if err != nil {
		return nil, err
	}
	if converted && s.Converter == nil {
		return nil, fmt.Errorf("converted copy is unavailable: no converter is installed")
	}
	out := make([]ClipboardMedia, 0, len(images))
	for _, img := range images {
		path := img.FilePath
		name := filepath.Base(path)
		if converted {
			dir, err := os.MkdirTemp("", "loom-convert-")
			if err != nil {
				return nil, err
			}
			defer os.RemoveAll(dir)
			name = strings.TrimSuffix(name, filepath.Ext(name)) + s.Converter.TargetExt()
			path = filepath.Join(dir, filepath.Base(name))
			if err := s.Converter.Convert(img.FilePath, path); err != nil {
				return nil, err
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		out = append(out, ClipboardMedia{Name: name, Data: base64.StdEncoding.EncodeToString(data)})
	}
	return out, nil
}

// ImportMedia always creates fresh files and identities, with no copied metadata.
func (s *ImageService) ImportMedia(repoPath string, media []ClipboardMedia, place bool, x, y float64) ([]int64, error) {
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer r.Close()
	tx, err := r.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	paths := []string{}
	committed := false
	defer func() {
		if !committed {
			for _, path := range paths {
				os.Remove(path)
			}
		}
	}()
	ids := make([]int64, 0, len(media))
	for i, item := range media {
		name := filepath.Base(strings.ReplaceAll(item.Name, "\\", "/"))
		if !store.IsMediaFile(name) {
			return nil, fmt.Errorf("unsupported media name %q", name)
		}
		data, err := base64.StdEncoding.DecodeString(item.Data)
		if err != nil {
			return nil, fmt.Errorf("decode media: %w", err)
		}
		var file *os.File
		var dest string
		for n := 0; ; n++ {
			candidate := name
			if n > 0 {
				ext := filepath.Ext(name)
				candidate = fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, ext), n, ext)
			}
			dest = filepath.Join(r.Path, candidate)
			file, err = os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
			if os.IsExist(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			break
		}
		paths = append(paths, dest)
		_, writeErr := file.Write(data)
		closeErr := file.Close()
		if writeErr != nil {
			return nil, writeErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		var cx, cy any
		if place {
			cx = x + float64(i%6)*190
			cy = y + float64(i/6)*160
		}
		result, err := tx.Exec("INSERT INTO images(file_path,canvas_x,canvas_y) VALUES (?,?,?)", dest, cx, cy)
		if err != nil {
			return nil, err
		}
		id, err := result.LastInsertId()
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	return ids, nil
}

func (s *ImageService) PurgeImages(repoPath string, ids []int64) error {
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer r.Close()
	images, err := r.ListImagesByIDs(uniqueImageIDs(ids))
	if err != nil {
		return err
	}
	for _, img := range images {
		rel, err := filepath.Rel(r.Path, img.FilePath)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("asset is outside repository")
		}
	}
	for _, img := range images {
		if err := os.Remove(img.FilePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("purge %s: %w", filepath.Base(img.FilePath), err)
		}
		if _, err := r.DB.Exec("DELETE FROM images WHERE id = ?", img.ID); err != nil {
			return err
		}
		if img.ThumbPath != "" {
			if err := os.Remove(img.ThumbPath); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	_, err = r.DB.Exec("DELETE FROM groups WHERE NOT EXISTS (SELECT 1 FROM images WHERE group_id = groups.id)")
	return err
}
