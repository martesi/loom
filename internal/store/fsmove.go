package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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
func uniquePath(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}
	dir := filepath.Dir(path)
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(filepath.Base(path), ext)
	for i := 1; ; i++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
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
	err := os.Rename(src, dst)
	if err == nil {
		return nil
	}
	if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	if cpErr := copyFileContents(src, dst); cpErr != nil {
		os.Remove(dst)
		return cpErr
	}
	if rmErr := os.Remove(src); rmErr != nil {
		// The copy succeeded but we couldn't remove the original — leave
		// both copies in place rather than lose data; surface the error so
		// the caller knows the move didn't fully complete.
		return fmt.Errorf("copied to %s but failed to remove source %s: %w", dst, src, rmErr)
	}
	return nil
}

// FileMove describes one exact no-replace move. Batch lifecycle operations use
// these recorded paths for both initial execution and history replay.
type FileMove struct {
	Source      string
	Destination string
}

// MoveFilesWithoutReplace moves every file, or compensates completed moves if
// a later move fails. It never replaces an existing destination.
func MoveFilesWithoutReplace(moves []FileMove) error {
	completed := make([]FileMove, 0, len(moves))
	for _, move := range moves {
		if move.Source == move.Destination {
			continue
		}
		if err := moveFileWithoutReplace(move.Source, move.Destination); err != nil {
			primary := fmt.Errorf("move %q to %q: %w", move.Source, move.Destination, err)
			return errors.Join(primary, RollbackFileMoves(completed))
		}
		completed = append(completed, move)
	}
	return nil
}

// RollbackFileMoves compensates completed moves in reverse order. It uses the
// same no-replace rule so an external file is never overwritten during repair.
func RollbackFileMoves(moves []FileMove) error {
	var rollbackErr error
	for i := len(moves) - 1; i >= 0; i-- {
		move := moves[i]
		if err := moveFileWithoutReplace(move.Destination, move.Source); err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("compensate move %q to %q: %w", move.Destination, move.Source, err))
		}
	}
	return rollbackErr
}

func moveFileWithoutReplace(src, dst string) error {
	if src == dst {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create destination directory: %w", err)
	}
	if err := os.Link(src, dst); err == nil {
		destinationInfo, statErr := os.Lstat(dst)
		if statErr != nil {
			return errors.Join(fmt.Errorf("inspect linked destination %q: %w", dst, statErr), removeCreatedFile(dst, destinationInfo))
		}
		sourceInfo, statErr := os.Lstat(src)
		if statErr != nil || !os.SameFile(sourceInfo, destinationInfo) {
			return errors.Join(fmt.Errorf("source %q changed while linking", src), statErr, removeCreatedFile(dst, destinationInfo))
		}
		if err := os.Remove(src); err != nil {
			return errors.Join(fmt.Errorf("remove moved source %q: %w", src, err), removeCreatedFile(dst, destinationInfo))
		}
		return nil
	} else if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	return copyFileWithoutReplace(src, dst)
}
func copyFileWithoutReplace(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	sourceInfo, err := in.Stat()
	if err != nil {
		return err
	}
	if !sourceInfo.Mode().IsRegular() {
		return fmt.Errorf("source %q is not a regular file", src)
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, sourceInfo.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	if copyErr == nil {
		copyErr = out.Chmod(sourceInfo.Mode().Perm())
	}
	if copyErr == nil {
		copyErr = out.Sync()
	}
	createdInfo, statErr := out.Stat()
	closeErr := out.Close()
	if err := errors.Join(copyErr, statErr, closeErr); err != nil {
		return errors.Join(err, removeCreatedFile(dst, createdInfo))
	}
	currentSource, err := os.Stat(src)
	if err != nil || !os.SameFile(sourceInfo, currentSource) {
		return errors.Join(fmt.Errorf("source %q changed before move completed", src), err, removeCreatedFile(dst, createdInfo))
	}
	if err := os.Remove(src); err != nil {
		return errors.Join(fmt.Errorf("remove moved source %q: %w", src, err), removeCreatedFile(dst, createdInfo))
	}
	return nil
}

func removeCreatedFile(path string, createdInfo os.FileInfo) error {
	if createdInfo == nil {
		return nil
	}
	current, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect created destination %q: %w", path, err)
	}
	if !os.SameFile(createdInfo, current) {
		return fmt.Errorf("created destination %q was replaced; leaving it untouched", path)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove created destination %q: %w", path, err)
	}
	return nil
}

func copyFileContents(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
