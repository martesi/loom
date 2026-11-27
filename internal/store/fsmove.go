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
	identity    os.FileInfo
}

// MoveFilesWithoutReplace moves every file, or compensates completed moves if
// a later move fails. It never replaces an existing destination.
func MoveFilesWithoutReplace(moves []FileMove) error {
	completed := make([]FileMove, 0, len(moves))
	for i := range moves {
		move := &moves[i]
		if move.Source == move.Destination {
			continue
		}
		if err := moveFileWithoutReplace(move); err != nil {
			primary := fmt.Errorf("move %q to %q: %w", move.Source, move.Destination, err)
			return errors.Join(primary, RollbackFileMoves(completed))
		}
		completed = append(completed, *move)
	}
	return nil
}

// RollbackFileMoves compensates completed moves in reverse order. It uses the
// same no-replace rule so an external file is never overwritten during repair.
func RollbackFileMoves(moves []FileMove) error {
	var rollbackErr error
	for i := len(moves) - 1; i >= 0; i-- {
		move := moves[i]
		if move.identity == nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("compensate move %q to %q: source identity was not recorded", move.Destination, move.Source))
			continue
		}
		current, err := os.Lstat(move.Destination)
		if err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("verify compensation source %q: %w", move.Destination, err))
			continue
		}
		if !os.SameFile(move.identity, current) {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("verify compensation source %q: file was replaced; leaving it untouched", move.Destination))
			continue
		}
		reverse := FileMove{Source: move.Destination, Destination: move.Source, identity: move.identity}
		if err := moveFileWithoutReplace(&reverse); err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("compensate move %q to %q: %w", move.Destination, move.Source, err))
		}
	}
	return rollbackErr
}

func moveFileWithoutReplace(move *FileMove) error {
	if move.Source == move.Destination {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(move.Destination), 0o755); err != nil {
		return fmt.Errorf("create destination directory: %w", err)
	}
	sourceInfo, err := os.Lstat(move.Source)
	if err != nil {
		return err
	}
	if move.identity != nil && !os.SameFile(move.identity, sourceInfo) {
		return fmt.Errorf("source %q changed before move; leaving it untouched", move.Source)
	}
	if err := renameNoReplace(move.Source, move.Destination); err != nil {
		return err
	}
	move.identity = sourceInfo
	identity, err := os.Lstat(move.Destination)
	if err != nil {
		return errors.Join(fmt.Errorf("inspect moved file %q: %w", move.Destination, err), RollbackFileMoves([]FileMove{*move}))
	}
	if !os.SameFile(sourceInfo, identity) {
		return errors.Join(fmt.Errorf("source %q changed while moving", move.Source), RollbackFileMoves([]FileMove{*move}))
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
		_ = out.Close()
		return err
	}
	return out.Close()
}
