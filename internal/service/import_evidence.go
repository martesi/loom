package service

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"loom/internal/store"
)

type ImportResolutionStatus string

const (
	ImportStatusVerified  ImportResolutionStatus = "verified"
	ImportStatusMissing   ImportResolutionStatus = "missing"
	ImportStatusChanged   ImportResolutionStatus = "changed"
	ImportStatusAmbiguous ImportResolutionStatus = "ambiguous"
	ImportStatusUntrusted ImportResolutionStatus = "untrusted"
)

type ImportEvidence struct {
	Status              ImportResolutionStatus `json:"status"`
	RecordedFingerprint string                 `json:"recordedFingerprint,omitempty"`
	CurrentFingerprint  string                 `json:"currentFingerprint,omitempty"`
	FilePresent         bool                   `json:"filePresent"`
	Verified            bool                   `json:"verified"`
	Error               string                 `json:"error,omitempty"`
}

// inspectImportEvidence classifies a current file without treating access or
// path-safety failures as absence. It rejects symlinks in every path component.
func inspectImportEvidence(repoPath, filePath, recordedFingerprint string, trusted bool) (ImportEvidence, os.FileInfo) {
	evidence := ImportEvidence{
		Status:              ImportStatusAmbiguous,
		RecordedFingerprint: recordedFingerprint,
	}
	root, err := filepath.EvalSymlinks(repoPath)
	if err != nil {
		evidence.Error = "cannot resolve repository root: " + err.Error()
		return evidence, nil
	}
	root, err = filepath.Abs(root)
	if err != nil {
		evidence.Error = "cannot resolve repository root: " + err.Error()
		return evidence, nil
	}
	path, err := filepath.Abs(filePath)
	if err != nil {
		evidence.Error = "cannot resolve recorded path: " + err.Error()
		return evidence, nil
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		evidence.Error = "recorded path is outside the repository"
		return evidence, nil
	}

	current := root
	parts := strings.Split(rel, string(filepath.Separator))
	var info os.FileInfo
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err = os.Lstat(current)
		if os.IsNotExist(err) {
			evidence.Status = ImportStatusMissing
			return evidence, nil
		}
		if err != nil {
			evidence.Error = "cannot inspect recorded path: " + err.Error()
			return evidence, nil
		}
		if info.Mode()&os.ModeSymlink != 0 {
			evidence.Error = "recorded path contains a symbolic link"
			return evidence, nil
		}
		if index < len(parts)-1 && !info.IsDir() {
			evidence.Error = "recorded path parent is not a directory"
			return evidence, nil
		}
	}
	if !info.Mode().IsRegular() {
		evidence.Error = "recorded path is not a regular file"
		return evidence, nil
	}
	evidence.FilePresent = true
	fingerprint, stableInfo, err := store.FingerprintFile(context.Background(), path)
	if err != nil {
		evidence.Error = "cannot verify current file: " + err.Error()
		return evidence, nil
	}
	current = root
	var afterInfo os.FileInfo
	for index, part := range parts {
		current = filepath.Join(current, part)
		afterInfo, err = os.Lstat(current)
		if err != nil || afterInfo.Mode()&os.ModeSymlink != 0 || (index < len(parts)-1 && !afterInfo.IsDir()) {
			evidence.Error = "recorded path changed while verifying"
			return evidence, nil
		}
	}
	if !afterInfo.Mode().IsRegular() || !os.SameFile(info, afterInfo) || !os.SameFile(stableInfo, afterInfo) {
		evidence.Error = "recorded file changed while verifying"
		return evidence, nil
	}
	evidence.CurrentFingerprint = fingerprint
	if !trusted {
		evidence.Status = ImportStatusUntrusted
		return evidence, stableInfo
	}
	if recordedFingerprint != "" && fingerprint == recordedFingerprint {
		evidence.Status = ImportStatusVerified
		evidence.Verified = true
		return evidence, stableInfo
	}
	evidence.Status = ImportStatusChanged
	return evidence, stableInfo
}
