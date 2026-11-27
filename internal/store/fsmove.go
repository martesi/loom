package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// clampRelPath resolves relPath against root, guaranteeing the result can
// never land outside root even if relPath tries to escape it via "..".
// filepath.Clean alone isn't enough — it normalizes but doesn't reject
// escapes on its own — so this additionally checks the joined result's
// relationship back to root via filepath.Rel. Returns both the absolute
// path and the clean path relative to root ("" for root itself).
func clampRelPath(root, relPath string) (absPath, cleanRel string, err error) {
	joined := filepath.Join(root, relPath)
	rel, err := filepath.Rel(root, joined)
	if err != nil {
		return "", "", fmt.Errorf("resolve path %q: %w", relPath, err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("path %q escapes repo root", relPath)
	}
	if rel == "." {
		rel = ""
	}
	return joined, rel, nil
}

// relUnder reports path's location relative to base, and whether path
// actually sits inside base (as opposed to escaping it via "..", or being
// base itself).
func relUnder(base, path string) (rel string, ok bool) {
	rel, err := filepath.Rel(base, path)
	if err != nil {
		return "", false
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

// uniquePath returns path if nothing exists there yet, otherwise the same
// path with a " (1)", " (2)", ... suffix inserted before the extension,
// stopping at the first name that isn't taken — the same collision scheme
// most desktop file managers use.
func uniquePath(path string) (string, error) {
	dir := filepath.Dir(path)
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(filepath.Base(path), ext)
	for i := 0; ; i++ {
		candidate := path
		if i > 0 {
			candidate = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		}
		if _, err := os.Lstat(candidate); os.IsNotExist(err) {
			return candidate, nil
		} else if err != nil {
			return "", err
		}
	}
}

// moveFileOnDisk moves src to dst, creating dst's parent directory first.
// os.Rename fails with EXDEV when src and dst sit on different
// filesystems/devices (plausible for a repo root and a trash folder that
// ends up on a different mount) — this falls back to copy-then-delete in
// that case. Both SetTrashed and MoveFile funnel through this one function.
func moveFileOnDisk(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create destination directory: %w", err)
	}
	err := RenameNoReplace(src, dst)
	if err == nil || !renameCrossDevice(err) {
		return err
	}
	return copyEntryAcrossDevice(src, dst)
}

func copyEntryAcrossDevice(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("cannot move a link or non-regular entry across volumes")
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	opened, err := in.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return errors.Join(err, fmt.Errorf("source changed before cross-volume copy"))
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	created, statErr := out.Stat()
	_, copyErr := io.Copy(out, in)
	if err := errors.Join(statErr, copyErr, out.Sync(), out.Close()); err != nil {
		// Never remove the destination if the open file could not be proven
		// to still occupy that path.
		if current, statErr := os.Lstat(dst); statErr == nil && created != nil && os.SameFile(created, current) {
			err = errors.Join(err, os.Remove(dst))
		}
		return err
	}
	installed, err := os.Lstat(dst)
	if err != nil || !os.SameFile(created, installed) || installed.Size() != info.Size() {
		return errors.Join(err, fmt.Errorf("destination changed during cross-volume copy; source preserved"))
	}
	unchanged, err := os.Lstat(src)
	if err != nil || !os.SameFile(info, unchanged) || info.Size() != unchanged.Size() || !info.ModTime().Equal(unchanged.ModTime()) {
		return errors.Join(err, fmt.Errorf("source changed during cross-volume copy; both paths were preserved"))
	}
	// Close before unlinking so Windows can complete the move.
	if err := in.Close(); err != nil {
		return err
	}
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("copied to %s but failed to remove source %s: %w", dst, src, err)
	}
	return nil
}
