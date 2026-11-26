package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

type failingExclusiveFile struct {
	file           *os.File
	statErr        error
	statAlwaysFail bool
	writeSize      int
	writeErr       error
	onStat         func()
	statCalls      int
}

func (f *failingExclusiveFile) Stat() (os.FileInfo, error) {
	f.statCalls++
	if f.statCalls == 1 && f.onStat != nil {
		f.onStat()
	}
	if f.statErr != nil && (f.statAlwaysFail || f.statCalls == 1) {
		return nil, f.statErr
	}
	return f.file.Stat()
}

func (f *failingExclusiveFile) Write(data []byte) (int, error) {
	if f.writeSize >= 0 && f.writeSize < len(data) {
		n, err := f.file.Write(data[:f.writeSize])
		if err != nil {
			return n, err
		}
		return n, f.writeErr
	}
	return f.file.Write(data)
}

func (f *failingExclusiveFile) Close() error { return f.file.Close() }

func TestWriteExclusiveModeDoesNotPublishPartialWritesOrStatFailures(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		statErr               error
		writeSize             int
		replace               bool
		persistentStatFailure bool
	}{
		{name: "partial write", writeSize: 3},
		{name: "stat failure original file", statErr: errors.New("stat failed"), writeSize: 0},
		{name: "stat failure replacement", statErr: errors.New("stat failed"), writeSize: 0, replace: true},
		{name: "persistent stat failure", statErr: errors.New("stat failed"), writeSize: 0, persistentStatFailure: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			destination := filepath.Join(t.TempDir(), "exclusive.bin")
			data := []byte("payload")
			_, err := writeExclusiveModeUsing(destination, data, 0o600, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
				file, err := os.OpenFile(path, flags, mode)
				if err != nil {
					return nil, err
				}
				return &failingExclusiveFile{
					file: file, statErr: tc.statErr, statAlwaysFail: tc.persistentStatFailure,
					writeSize: tc.writeSize, writeErr: errors.New("short write"),
					onStat: func() {
						if tc.replace {
							if err := os.WriteFile(destination, nil, 0o600); err != nil {
								t.Fatal(err)
							}
						}
					},
				}, nil
			})
			if err == nil {
				t.Fatal("writeExclusiveModeUsing unexpectedly succeeded")
			}
			if tc.replace {
				if got, err := os.ReadFile(destination); err != nil || len(got) != 0 {
					t.Fatalf("file did not survive when ownership was unavailable: bytes=%q err=%v", got, err)
				}
			} else if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatalf("failed exclusive write left path behind, stat err=%v", err)
			}
		})
	}
}

func TestWriteExclusiveCollisionRaceRemovesPrivateStageAnchor(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "collision.png")
	external := []byte("external collision")
	_, err := writeExclusiveModeUsing(destination, []byte("captured bytes"), 0o600, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
		file, err := os.OpenFile(path, flags, mode)
		if err != nil {
			return nil, err
		}
		return &failingExclusiveFile{
			file: file, writeSize: -1,
			onStat: func() {
				if err := os.WriteFile(destination, external, 0o600); err != nil {
					t.Errorf("publish racing destination: %v", err)
				}
			},
		}, nil
	})
	if !os.IsExist(err) {
		t.Fatalf("write with racing destination error = %v, want destination collision", err)
	}
	if got, err := os.ReadFile(destination); err != nil || !bytes.Equal(got, external) {
		t.Fatalf("racing external destination = %q, err=%v", got, err)
	}
	staged, err := filepath.Glob(filepath.Join(dir, ".loom-import-stage-*"))
	if err != nil || len(staged) != 0 {
		t.Fatalf("private stage anchors after collision = %v, err=%v", staged, err)
	}
}

func TestPersistentImportStatFailureDoesNotClaimUnverifiedOwnership(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{writeImportFile: func(path string, data []byte, mode os.FileMode) (os.FileInfo, error) {
		return writeExclusiveModeUsing(path, data, mode, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
			file, err := os.OpenFile(path, flags, mode)
			if err != nil {
				return nil, err
			}
			return &failingExclusiveFile{
				file: file, statErr: errors.New("persistent stat failure"), statAlwaysFail: true,
				writeSize: 0, writeErr: errors.New("write must not run"),
			}, nil
		})
	}}
	_, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "stat-orphan.png", Data: base64.StdEncoding.EncodeToString([]byte("never written")),
	}}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	path := filepath.Join(repoPath, "stat-orphan.png")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stat failure created visible destination, err=%v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var suppressed, images int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files`).Scan(&suppressed); err != nil || suppressed != 0 {
		t.Fatalf("unverified persistent stat-failure suppressions = %d, err=%v", suppressed, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&images); err != nil || images != 0 {
		t.Fatalf("persistent stat-failure image rows before scan = %d, err=%v", images, err)
	}
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		t.Fatalf("register after persistent stat failure: %v", err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("scan after persistent stat failure: %v", err)
	}
	if _, err := repo.RefreshFingerprints(context.Background()); err != nil {
		t.Fatalf("refresh after persistent stat failure: %v", err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&images); err != nil || images != 0 {
		t.Fatalf("persistent stat failure was rediscovered: rows=%d err=%v", images, err)
	}
}

func TestImportRejectsTransientFileIdentityLookupFailure(t *testing.T) {
	for _, tc := range []struct {
		name     string
		failCall int
	}{
		{name: "visible file", failCall: 1},
		{name: "retained copy", failCall: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			calls := 0
			service := &ImageService{fileIdentityAt: func(path string, info os.FileInfo) string {
				calls++
				if calls == tc.failCall {
					return ""
				}
				return store.FileIdentityAt(path, info)
			}}
			_, err := service.ImportMedia(repoPath, []ClipboardMedia{{
				Name: "transient-identity.png", Data: base64.StdEncoding.EncodeToString([]byte("captured bytes")),
			}}, false, 0, 0)
			if err == nil {
				t.Fatal("ImportMedia committed despite an unavailable recorded file identity")
			}
			if calls != tc.failCall {
				t.Fatalf("identity lookups = %d, want first failure on call %d", calls, tc.failCall)
			}
			// A subsequent lookup succeeds. The initial transaction must still
			// fail rather than recording an empty identity and retrying later.
			visiblePath := filepath.Join(repoPath, "transient-identity.png")
			if tc.name == "visible file" {
				if _, err := os.Stat(visiblePath); !os.IsNotExist(err) {
					t.Fatalf("visible file was published before identity failure: %v", err)
				}
			} else {
				visibleInfo, err := os.Stat(visiblePath)
				if err != nil {
					t.Fatalf("stat suppressed visible file after retained identity failure: %v", err)
				}
				if store.FileIdentityAt(visiblePath, visibleInfo) == "" {
					t.Fatal("identity lookup did not recover after the injected transient failure")
				}
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			var imageCount, historyCount int
			if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images`).Scan(&imageCount); err != nil {
				t.Fatal(err)
			}
			if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log WHERE kind = 'import_batch'`).Scan(&historyCount); err != nil {
				t.Fatal(err)
			}
			if imageCount != 0 || historyCount != 0 {
				t.Fatalf("failed identity lookup committed image/history rows: images=%d history=%d", imageCount, historyCount)
			}
			var suppressionCount int
			if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM discarded_import_files WHERE file_path = ?`, visiblePath).Scan(&suppressionCount); err != nil {
				t.Fatal(err)
			}
			if tc.name == "visible file" && suppressionCount != 0 {
				t.Fatalf("pre-publication identity failure wrote a suppression: %d", suppressionCount)
			}
			if tc.name == "retained copy" && suppressionCount != 1 {
				t.Fatalf("retained identity failure suppression count = %d, want 1", suppressionCount)
			}
			retainedFiles, err := filepath.Glob(filepath.Join(repoPath, ".loom", "trash", "import-redo", "*"))
			if err != nil || len(retainedFiles) != 0 {
				t.Fatalf("retained copies after failed import = %v, err=%v", retainedFiles, err)
			}
		})
	}
}

func TestRetainedCopyWriteFailureReclaimsVerifiedPrivateStage(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{writeRetainedImportFile: func(path string, data []byte, identityAt func(string, os.FileInfo) string) (os.FileInfo, string, error) {
		return writeExclusiveModeUsingWithIdentity(path, data, 0o600, func(stagePath string, flags int, mode os.FileMode) (exclusiveFile, error) {
			file, err := os.OpenFile(stagePath, flags, mode)
			if err != nil {
				return nil, err
			}
			return &failingExclusiveFile{file: file, writeSize: 4, writeErr: errors.New("injected retained-copy partial write")}, nil
		}, identityAt)
	}}
	_, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "retained-failure.png", Data: base64.StdEncoding.EncodeToString([]byte("retained payload")),
	}}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded after retained-copy write failure")
	}
	visiblePath := filepath.Join(repoPath, "retained-failure.png")
	if got, err := os.ReadFile(visiblePath); err != nil || string(got) != "retained payload" {
		t.Fatalf("visible failed-batch file = %q, err=%v", got, err)
	}
	retained, err := filepath.Glob(filepath.Join(repoPath, ".loom", "trash", "import-redo", "*"))
	if err != nil || len(retained) != 0 {
		t.Fatalf("retained copies after retained-write failure = %v, err=%v", retained, err)
	}
	anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(anchors) != 1 {
		t.Fatalf("anchors after retained-write failure = %v, err=%v, want only visible-file suppression anchor", anchors, err)
	}
	visibleInfo, err := os.Stat(visiblePath)
	if err != nil {
		t.Fatal(err)
	}
	visibleIdentity := store.FileIdentityAt(visiblePath, visibleInfo)
	anchorInfo, err := os.Stat(anchors[0])
	if err != nil {
		t.Fatal(err)
	}
	if got := store.FileIdentityAt(anchors[0], anchorInfo); got != visibleIdentity {
		t.Fatalf("remaining anchor identity = %q, want only visible tombstone identity %q", got, visibleIdentity)
	}
	if bytes, err := os.ReadFile(anchors[0]); err != nil || string(bytes) != "retained payload" {
		t.Fatalf("remaining visible-file anchor bytes = %q, err=%v", bytes, err)
	}
}

func TestImportWriteFailureLeavesPartialBytesHiddenAndAllowsExternalChange(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{writeImportFile: func(path string, data []byte, mode os.FileMode) (os.FileInfo, error) {
		return writeExclusiveModeUsing(path, data, mode, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
			file, err := os.OpenFile(path, flags, mode)
			if err != nil {
				return nil, err
			}
			return &failingExclusiveFile{file: file, writeSize: 4, writeErr: errors.New("injected partial write")}, nil
		})
	}}
	_, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "partial-import.png", Data: base64.StdEncoding.EncodeToString([]byte("complete import bytes")),
	}}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	path := filepath.Join(repoPath, "partial-import.png")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("failed partial write published destination, err=%v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	staged, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(staged) != 1 {
		t.Fatalf("remaining hidden staging files = %v, err=%v", staged, err)
	}
	if data, err := os.ReadFile(staged[0]); err != nil || string(data) != "comp" {
		t.Fatalf("remaining partial staging bytes = %q, err=%v", data, err)
	}
	var suppressed int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ? AND sha256 = ?`, staged[0], fmt.Sprintf("%x", sha256.Sum256([]byte("comp")))).Scan(&suppressed); err != nil || suppressed != 1 {
		t.Fatalf("remaining partial staging suppression = %d, err=%v", suppressed, err)
	}
	for name, discover := range map[string]func(context.Context) (int, error){
		"register": repo.RegisterImages,
		"scan":     repo.ScanAndRegisterImages,
		"refresh":  repo.RefreshFingerprints,
	} {
		if _, err := discover(context.Background()); err != nil {
			t.Fatalf("%s after failed partial import: %v", name, err)
		}
		var count int
		if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s registered partial failed import: count=%d err=%v", name, count, err)
		}
	}
	external := []byte("external replacement")
	if err := os.WriteFile(path, external, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("scan external replacement: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, external) {
		t.Fatalf("external replacement changed: bytes=%q err=%v", data, err)
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&count); err != nil || count != 1 {
		t.Fatalf("external replacement image rows = %d, err=%v", count, err)
	}
}

func TestImportOwnerAnchorPreventsFileIdentityReuse(t *testing.T) {
	repoPath := t.TempDir()
	if err := os.Mkdir(filepath.Join(repoPath, ".loom"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, "owned.png")
	data := []byte("owned bytes")
	originalInfo, err := writeExclusive(path, data)
	if err != nil {
		t.Fatal(err)
	}
	identity := store.FileIdentityAt(path, originalInfo)
	if identity == "" {
		t.Skip("platform does not expose stable device/inode identity")
	}
	anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(anchors) != 1 {
		t.Fatalf("ownership anchors = %v, err=%v", anchors, err)
	}
	anchorInfo, err := os.Stat(anchors[0])
	if err != nil || !os.SameFile(originalInfo, anchorInfo) {
		t.Fatalf("ownership anchor does not pin imported file: info=%v err=%v", anchorInfo, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if anchorInfo, err = os.Stat(anchors[0]); err != nil || !os.SameFile(originalInfo, anchorInfo) {
		t.Fatalf("identity anchor lost after visible path removal: info=%v err=%v", anchorInfo, err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	replacementInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(anchorInfo, replacementInfo) || store.FileIdentityAt(path, replacementInfo) == store.FileIdentityAt(anchors[0], anchorInfo) {
		t.Fatalf("replacement reused identity while owner anchor remained: original=%q replacement=%q", store.FileIdentityAt(anchors[0], anchorInfo), store.FileIdentityAt(path, replacementInfo))
	}
}

func TestImportBatchRedoRejectsChangedExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	original := []byte("first image payload")
	second := []byte("second image payload")
	items := []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString(original)},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString(second)},
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("imported IDs = %v", ids)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetThumbInfo(ids[0], filepath.Join(repoPath, "cached-thumb.png"), 17, 23); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetCanvasPosition(ids[0], 42, 84); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.LinkSource(ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET source_fingerprint = 'old-source', source_revision = 10 WHERE id = ?`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanUndo || state.CanRedo {
		t.Fatalf("history after import = %+v, err=%v", state, err)
	}
	undo, err := (&UndoService{}).Undo(repoPath)
	if err != nil || !undo.Applied {
		t.Fatalf("undo = %+v, err=%v", undo, err)
	}
	for _, name := range []string{"first.png", "second.png"} {
		if _, err := os.Stat(filepath.Join(repoPath, name)); err != nil {
			t.Fatalf("undo removed retained file %s: %v", name, err)
		}
	}
	state, err = (&UndoService{}).State(repoPath)
	if err != nil || state.CanUndo || !state.CanRedo {
		t.Fatalf("history after undo = %+v, err=%v", state, err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "first.png"), []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	redo, err := (&UndoService{}).Redo(repoPath)
	if err != nil || redo.Applied || redo.Error == "" {
		t.Fatalf("redo after external replacement = %+v, err=%v", redo, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for _, id := range ids {
		image, err := repo.GetImageByID(id)
		if err != nil {
			t.Fatal(err)
		}
		if !image.ImportUndone {
			t.Fatalf("image %d should remain undone after failed redo", id)
		}
	}
	external, err := os.ReadFile(filepath.Join(repoPath, "first.png"))
	if err != nil || !bytes.Equal(external, []byte("external replacement")) {
		t.Fatalf("external file changed: %q, err=%v", external, err)
	}
}

func TestUndoneImportReplacementBecomesDiscoverableAndCannotBeRedone(t *testing.T) {
	for _, discover := range []struct {
		name string
		fn   func(*store.Repo) (int, error)
	}{
		{name: "register", fn: func(repo *store.Repo) (int, error) { return repo.RegisterImages(context.Background()) }},
		{name: "scan", fn: func(repo *store.Repo) (int, error) { return repo.ScanAndRegisterImages(context.Background()) }},
	} {
		t.Run(discover.name, func(t *testing.T) {
			repoPath := t.TempDir()
			ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
				Name: "replaced-import.png", Data: base64.StdEncoding.EncodeToString([]byte("original imported bytes")),
			}}, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := (&UndoService{}).Undo(repoPath); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(repoPath, "replaced-import.png")
			external := []byte("external bytes with a different identity")
			if err := os.WriteFile(path, external, 0o600); err != nil {
				t.Fatal(err)
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := discover.fn(repo); err != nil {
				repo.Close()
				t.Fatalf("discover external replacement: %v", err)
			}
			image, err := repo.GetImageByID(ids[0])
			if err != nil || image.ImportUndone {
				repo.Close()
				t.Fatalf("replaced import row = %+v, err=%v", image, err)
			}
			if image.SourceFingerprint == "" || image.SourceFingerprint == fmt.Sprintf("%x", sha256.Sum256([]byte("original imported bytes"))) {
				repo.Close()
				t.Fatalf("external replacement fingerprint = %q", image.SourceFingerprint)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			result, err := (&UndoService{}).Redo(repoPath)
			if err != nil || result.Applied || result.Error == "" {
				t.Fatalf("redo after external replacement = %+v, err=%v", result, err)
			}
			if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, external) {
				t.Fatalf("external replacement changed by redo: %q err=%v", got, err)
			}
		})
	}
}

func TestRedoRefreshesActiveFileIdentityAfterRestoringMissingImport(t *testing.T) {
	repoPath := t.TempDir()
	data := []byte("captured bytes for repeated redo")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "repeat-redo.png", Data: base64.StdEncoding.EncodeToString(data),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repoPath, "repeat-redo.png")); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Redo(repoPath); err != nil || !result.Applied {
		t.Fatalf("redo missing import = %+v err=%v", result, err)
	}
	for _, replay := range []string{"undo", "redo"} {
		var result *UndoResult
		if replay == "undo" {
			result, err = (&UndoService{}).Undo(repoPath)
		} else {
			result, err = (&UndoService{}).Redo(repoPath)
		}
		if err != nil || !result.Applied {
			t.Fatalf("repeated %s = %+v err=%v", replay, result, err)
		}
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || image.ImportUndone {
		t.Fatalf("image after repeated redo = %+v err=%v", image, err)
	}
	got, err := os.ReadFile(image.FilePath)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("repeated redo bytes = %q err=%v", got, err)
	}
}

func TestRedoRejectsReplacementPublishedDuringReplay(t *testing.T) {
	repoPath := t.TempDir()
	data := []byte("captured import bytes")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "redo-race.png", Data: base64.StdEncoding.EncodeToString(data),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repoPath, "redo-race.png")); err != nil {
		t.Fatal(err)
	}
	service := &UndoService{afterImportRedoFileWrite: func(path string) {
		replacement := path + ".external"
		if err := os.WriteFile(replacement, data, 0o600); err != nil {
			t.Errorf("write identical external replacement: %v", err)
			return
		}
		if err := os.Remove(path); err != nil {
			t.Errorf("remove restored file before replacement: %v", err)
			return
		}
		if err := os.Rename(replacement, path); err != nil {
			t.Errorf("publish identical external replacement: %v", err)
		}
	}}
	result, err := service.Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo after in-replay replacement = %+v err=%v", result, err)
	}
	path := filepath.Join(repoPath, "redo-race (redo 1).png")
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("external replacement after failed redo = %q err=%v", got, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("image after rejected redo = %+v err=%v", image, err)
	}
	var suppressions int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, path).Scan(&suppressions); err != nil || suppressions != 0 {
		t.Fatalf("unowned identical replacement suppressions = %d err=%v", suppressions, err)
	}
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		t.Fatal(err)
	}
	var discovered int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ? AND id != ?`, path, ids[0]).Scan(&discovered); err != nil || discovered != 1 {
		t.Fatalf("identical external replacement discovered rows = %d err=%v", discovered, err)
	}
}

func TestRedoRejectsRetainedCopyChangedAfterRead(t *testing.T) {
	for _, tc := range []struct {
		name     string
		replace  bool
		newBytes []byte
	}{
		{name: "replacement", replace: true, newBytes: []byte("external retained replacement")},
		{name: "in-place modification", newBytes: []byte("external retained edit")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			captured := []byte("retained bytes read by redo")
			ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
				Name: "retained-race.png", Data: base64.StdEncoding.EncodeToString(captured),
			}}, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := (&UndoService{}).Undo(repoPath); err != nil {
				t.Fatal(err)
			}
			matches, err := filepath.Glob(filepath.Join(repoPath, ".loom", "trash", "import-redo", "*-retained-race.png"))
			if err != nil || len(matches) != 1 {
				t.Fatalf("retained copies = %v err=%v", matches, err)
			}
			retainedPath := matches[0]
			originalPath := filepath.Join(repoPath, "retained-race.png")
			if err := os.Remove(originalPath); err != nil {
				t.Fatal(err)
			}
			service := &UndoService{afterImportRedoFileWrite: func(_ string) {
				if tc.replace {
					replacement := retainedPath + ".external"
					if err := os.WriteFile(replacement, tc.newBytes, 0o600); err != nil {
						t.Errorf("write external retained replacement: %v", err)
						return
					}
					if err := os.Remove(retainedPath); err != nil {
						t.Errorf("remove retained copy: %v", err)
						return
					}
					if err := os.Rename(replacement, retainedPath); err != nil {
						t.Errorf("publish retained replacement: %v", err)
					}
					return
				}
				if err := os.WriteFile(retainedPath, tc.newBytes, 0o600); err != nil {
					t.Errorf("modify retained copy in place: %v", err)
				}
			}}
			result, err := service.Redo(repoPath)
			if err != nil || result.Applied || result.Error == "" {
				t.Fatalf("redo after retained-copy change = %+v err=%v", result, err)
			}
			if got, err := os.ReadFile(retainedPath); err != nil || !bytes.Equal(got, tc.newBytes) {
				t.Fatalf("external retained copy after rejected redo = %q err=%v", got, err)
			}
			state, err := (&UndoService{}).State(repoPath)
			if err != nil || !state.CanRedo || state.CanUndo {
				t.Fatalf("history after rejected redo = %+v err=%v", state, err)
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			image, err := repo.GetImageByID(ids[0])
			if err != nil || !image.ImportUndone || image.FilePath != originalPath {
				t.Fatalf("image after rejected redo = %+v err=%v", image, err)
			}
		})
	}
}

func TestRedoRejectsSameBytesRetainedReplacementBeforeReplay(t *testing.T) {
	repoPath := t.TempDir()
	captured := []byte("same bytes but a different retained file")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "retained-identity.png", Data: base64.StdEncoding.EncodeToString(captured),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	var operation OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &operation); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(operation.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Entries) != 1 || payload.Entries[0].RetainedIdentity == "" {
		t.Fatalf("initial retained identity = %+v", payload.Entries)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	retainedPath := payload.Entries[0].RetainedPath
	replacement := retainedPath + ".external"
	if err := os.WriteFile(replacement, captured, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(retainedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, retainedPath); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(retainedPath)
	if err != nil {
		t.Fatal(err)
	}
	if identity := store.FileIdentityAt(retainedPath, info); identity == "" || identity == payload.Entries[0].RetainedIdentity {
		t.Fatalf("replacement identity = %q, initial retained identity = %q", identity, payload.Entries[0].RetainedIdentity)
	}
	if got, err := os.ReadFile(retainedPath); err != nil || !bytes.Equal(got, captured) {
		t.Fatalf("retained replacement bytes = %q err=%v", got, err)
	}
	result, err := (&UndoService{}).Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo with same-bytes retained replacement = %+v err=%v", result, err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo || state.CanUndo {
		t.Fatalf("history after rejected redo = %+v err=%v", state, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("image after rejected redo = %+v err=%v", image, err)
	}
}

func TestRedoReleasesNewAnchorAfterSameBytesExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	captured := []byte("restored file replaced with identical bytes")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "redo-replacement.png", Data: base64.StdEncoding.EncodeToString(captured)}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, "redo-replacement.png")
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	var restoredIdentity string
	var restoredPath string
	service := &UndoService{afterImportRedoFileWrite: func(writtenPath string) {
		// A missing imported path is restored to an available sibling path.
		// Publish a same-bytes external replacement at that path before commit.
		restoredPath = writtenPath
		info, err := os.Stat(writtenPath)
		if err != nil {
			t.Errorf("stat restored file: %v", err)
			return
		}
		restoredIdentity = store.FileIdentityAt(restoredPath, info)
		replacement := writtenPath + ".external"
		if err := os.WriteFile(replacement, captured, 0o600); err != nil {
			t.Errorf("write same-bytes replacement: %v", err)
			return
		}
		if err := os.Remove(writtenPath); err != nil {
			t.Errorf("remove restored file: %v", err)
			return
		}
		if err := os.Rename(replacement, writtenPath); err != nil {
			t.Errorf("publish same-bytes replacement: %v", err)
		}
	}}
	result, err := service.Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo after same-bytes post-write replacement = %+v, err=%v", result, err)
	}
	if restoredIdentity == "" {
		t.Fatal("redo did not create a verifiable file before replacement")
	}
	if restoredPath == "" {
		t.Fatal("redo did not create a restored path")
	}
	if got, err := os.ReadFile(restoredPath); err != nil || !bytes.Equal(got, captured) {
		t.Fatalf("external replacement after failed redo = %q, err=%v", got, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("image after failed redo = %+v, err=%v", image, err)
	}
	var suppressions int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM discarded_import_files WHERE file_path = ?`, restoredPath).Scan(&suppressions); err != nil || suppressions != 0 {
		t.Fatalf("same-bytes replacement suppression count = %d, err=%v", suppressions, err)
	}
	anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil {
		t.Fatal(err)
	}
	for _, anchor := range anchors {
		info, err := os.Stat(anchor)
		if err != nil {
			t.Fatal(err)
		}
		if store.FileIdentityAt(anchor, info) == restoredIdentity {
			t.Fatalf("failed redo left an unreferenced anchor for %q: %s", restoredIdentity, anchor)
		}
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("discover same-bytes replacement after failed redo: %v", err)
	}
	var discovered int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE file_path = ? AND import_undone = 0`, restoredPath).Scan(&discovered); err != nil || discovered != 1 {
		t.Fatalf("same-bytes replacement discovered rows = %d, err=%v", discovered, err)
	}
}

func TestUnverifiedSuppressionCannotHideIdenticalExternalBytes(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	path := filepath.Join(repoPath, "unverified-identical.png")
	data := []byte("identical captured bytes")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	fileHash := fmt.Sprintf("%x", sha256.Sum256(data))
	recordImportFileSuppression(repo, path, fileHash, nil, "unverified regression")
	var suppressions int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, path).Scan(&suppressions); err != nil || suppressions != 0 {
		t.Fatalf("unverified identical file suppressions = %d err=%v", suppressions, err)
	}
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		t.Fatal(err)
	}
	var discovered int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&discovered); err != nil || discovered != 1 {
		t.Fatalf("unverified identical external bytes discovered rows = %d err=%v", discovered, err)
	}
}

func TestUnverifiedRedoFailureDoesNotSuppressExternalPath(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "redo-unverified.png", Data: base64.StdEncoding.EncodeToString([]byte("retained")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repoPath, "redo-unverified.png")); err != nil {
		t.Fatal(err)
	}
	var externalPath string
	service := &UndoService{writeImportRedoFile: func(path string, _ []byte) (os.FileInfo, error) {
		externalPath = path
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			return nil, err
		}
		return nil, &unverifiedExclusiveFileError{path: path, cause: errors.New("injected unverified publication")}
	}}
	result, err := service.Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo with an unverified path = %+v err=%v", result, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var suppressions int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, externalPath).Scan(&suppressions); err != nil || suppressions != 0 {
		t.Fatalf("unverified external path suppressions = %d err=%v", suppressions, err)
	}
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		t.Fatal(err)
	}
	var discovered int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, externalPath).Scan(&discovered); err != nil || discovered != 1 {
		t.Fatalf("unverified external path discovered rows = %d err=%v", discovered, err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("image after failed unverified redo = %+v err=%v", image, err)
	}
}

func TestSuppressionDoesNotHideIdenticalBytesAtReplacementIdentity(t *testing.T) {
	repoPath := t.TempDir()
	seedIDs, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{
		{Name: "suppress-seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "suppress-seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "same-hash-replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("same bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, "same-hash-replacement.png")
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var suppressedIdentity string
	if err := repo.DB.QueryRow(`SELECT file_identity FROM discarded_import_files WHERE file_path = ?`, path).Scan(&suppressedIdentity); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if suppressedIdentity == "" {
		repo.Close()
		t.Fatal("failed cleanup suppression has no file identity")
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(repoPath, "replacement.tmp")
	if err := os.WriteFile(replacement, []byte("same bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		t.Fatalf("register same-hash replacement: %v", err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("scan same-hash replacement: %v", err)
	}
	var rows int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ? AND import_undone = 0`, path).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("same-hash external replacement discoverable rows = %d err=%v", rows, err)
	}
	var suppressionCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, path).Scan(&suppressionCount); err != nil || suppressionCount != 0 {
		t.Fatalf("stale suppression remained for replacement: %d err=%v", suppressionCount, err)
	}
	if _, err := repo.GetImageByID(ids[0]); err == nil {
		t.Fatal("discarded original import row unexpectedly remained")
	}
}

func TestDiscardedRedoDoesNotDeleteSameHashExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	seedIDs, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{
		{Name: "identity-seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "identity-seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "identity-replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("identical retained bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, "identity-replacement.png")
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch' ORDER BY seq DESC LIMIT 1`).Scan(&raw); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	var operation OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(raw), &operation); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := json.Unmarshal(operation.Payload, &payload); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	oldInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(repoPath, "external-replacement.tmp")
	data := []byte("identical retained bytes")
	if err := os.WriteFile(replacement, data, 0o600); err != nil {
		t.Fatal(err)
	}
	newInfo, err := os.Stat(replacement)
	if err != nil {
		t.Fatal(err)
	}
	if store.FileIdentityAt(path, oldInfo) == "" || store.FileIdentityAt(replacement, newInfo) == "" || store.FileIdentityAt(path, oldInfo) == store.FileIdentityAt(replacement, newInfo) {
		t.Skip("platform does not expose distinct durable file identities")
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	retainedPath := payload.Entries[0].RetainedPath
	retainedReplacement := retainedPath + ".external"
	if err := os.WriteFile(retainedReplacement, data, 0o600); err != nil {
		t.Fatal(err)
	}
	retainedInfo, err := os.Stat(retainedReplacement)
	if err != nil {
		t.Fatal(err)
	}
	if store.FileIdentityAt(retainedReplacement, retainedInfo) == payload.Entries[0].RetainedIdentity {
		t.Skip("platform did not allocate a distinct retained-file identity")
	}
	if err := os.Rename(retainedReplacement, retainedPath); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("same-hash external replacement was removed or changed: %q err=%v", got, err)
	}
	if got, err := os.ReadFile(retainedPath); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("same-hash retained replacement was removed or changed: %q err=%v", got, err)
	}
	if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
		t.Fatalf("discover same-hash external replacement: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ? AND import_undone = 0`, path).Scan(&count); err != nil || count != 1 {
		t.Fatalf("same-hash external replacement rows = %d err=%v", count, err)
	}
	if _, err := repo.GetImageByID(ids[0]); err == nil {
		t.Fatal("discarded imported row was not removed")
	}
}

func TestReplacementAfterCleanupOwnershipCheckIsNeverUnlinked(t *testing.T) {
	repoPath := t.TempDir()
	data := []byte("same bytes during cleanup race")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "cleanup-race.png", Data: base64.StdEncoding.EncodeToString(data),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, "cleanup-race.png")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	identity := store.FileIdentityAt(path, info)
	if identity == "" {
		t.Skip("platform does not expose stable file identity")
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO discarded_import_files (file_path, sha256, file_identity) VALUES (?, ?, ?)`, path, fmt.Sprintf("%x", sha256.Sum256(data)), identity); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	discarded := discardedImportRedo{active: []discardedImportFile{{
		path: path, hash: fmt.Sprintf("%x", sha256.Sum256(data)), identity: identity,
	}}}
	replacement := path + ".replacement"
	cleanupDiscardedImportRedoBestEffortAfterCheck(repo, discarded, "test cleanup race", func(checkedPath string) {
		if checkedPath != path {
			t.Errorf("cleanup checked unexpected path %q", checkedPath)
			return
		}
		if err := os.WriteFile(replacement, data, 0o600); err != nil {
			t.Errorf("write concurrent replacement: %v", err)
			return
		}
		if err := os.Rename(replacement, path); err != nil {
			t.Errorf("publish concurrent replacement: %v", err)
		}
	})
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("replacement after cleanup check was removed: %q err=%v", got, err)
	}
	if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
		t.Fatalf("discover concurrent replacement: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || image.ImportUndone {
		t.Fatalf("replacement was not promoted to a discoverable asset: %+v err=%v", image, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := (&UndoService{}).Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo after post-check replacement = %+v err=%v", result, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ? AND import_undone = 0`, path).Scan(&count); err != nil || count != 1 {
		t.Fatalf("replacement rows after cleanup race = %d err=%v", count, err)
	}
}

func TestDiscardedRedoCleanupPreservesTombstoneWhenIdentityUnknown(t *testing.T) {
	repoPath := t.TempDir()
	path := filepath.Join(repoPath, "unknown-identity.png")
	data := []byte("retained hidden file")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	identity := store.FileIdentityAt(path, info)
	if identity == "" {
		t.Skip("platform does not expose stable file identity")
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	if _, err := repo.DB.Exec(`INSERT INTO discarded_import_files (file_path, sha256, file_identity) VALUES (?, ?, ?)`, path, hash, identity); err != nil {
		t.Fatal(err)
	}
	discarded := discardedImportRedo{active: []discardedImportFile{{path: path, hash: hash, identity: identity}}}
	cleanupDiscardedImportRedoWithIdentity(repo, discarded, "test unknown identity", nil, func(string, os.FileInfo) string { return "" })
	var count int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM discarded_import_files WHERE file_path = ?`, path).Scan(&count); err != nil || count != 1 {
		t.Fatalf("tombstone count after unknown identity = %d, err=%v", count, err)
	}
}

func TestUndoneImportIsHiddenFromLibraryAndTrashActions(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "hidden.png", Data: base64.StdEncoding.EncodeToString([]byte("hidden"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	images, err := repo.ListImages()
	if err != nil || len(images) != 0 {
		t.Fatalf("canvas images = %+v, err=%v", images, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil || len(canvas.Images) != 0 {
		t.Fatalf("canvas after reload = %+v, err=%v", canvas, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images`).Scan(&rowCount); err != nil || rowCount != 1 {
		t.Fatalf("image rows after discovery = %d, err=%v", rowCount, err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("discovered undone image = %+v, err=%v", image, err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("undone import file missing after discovery: %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"", "all", "trashed"} {
		rows, err := (&LibraryService{}).ListImages(repoPath, LibraryQuery{Status: status, Search: "hidden"})
		if err != nil || len(rows) != 0 {
			t.Fatalf("library status %q = %+v, err=%v", status, rows, err)
		}
	}
	imagesService := &ImageService{}
	if err := imagesService.RestoreImage(repoPath, ids[0]); err == nil {
		t.Fatal("Trash restore accepted an import-undone image")
	}
	if err := imagesService.PurgeImages(repoPath, ids); err == nil {
		t.Fatal("Trash purge accepted an import-undone image")
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo {
		t.Fatalf("redo history after rejected Trash actions = %+v, err=%v", state, err)
	}
}

func TestDiscardingUndoneImportRedoSuppressesFilesWithoutUnlinking(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "discard.png", Data: base64.StdEncoding.EncodeToString([]byte("discard me"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE seq = (SELECT max(seq) FROM operation_log)`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var logged OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &logged); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(logged.Payload, &payload); err != nil || len(payload.Entries) != 1 {
		t.Fatalf("discarded import payload = %+v, err=%v", payload, err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("undo should keep active file until redo branch is discarded: %v", err)
	}
	if _, err := os.Stat(retained); err != nil {
		t.Fatalf("undo should keep retained redo snapshot: %v", err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(image.FilePath); err != nil || string(data) != "discard me" {
		t.Fatalf("discarded import active file changed or vanished: %q err=%v", data, err)
	}
	if _, err := os.Stat(retained); !os.IsNotExist(err) {
		t.Fatalf("discarded redo snapshot was not reclaimed: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE id = ?`, ids[0]).Scan(&rowCount); err != nil || rowCount != 0 {
		t.Fatalf("discarded import rows = %d, err=%v", rowCount, err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range canvas.Images {
		if found.ID == ids[0] || found.FilePath == image.FilePath {
			t.Fatalf("reload rediscovered discarded import: %+v", found)
		}
	}
}

func TestDiscardedImportPreservesExternallyModifiedFilesAndSnapshots(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "external.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE seq = (SELECT max(seq) FROM operation_log)`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var logged OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &logged); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(logged.Payload, &payload); err != nil || len(payload.Entries) != 1 {
		t.Fatalf("import payload = %+v, err=%v", payload, err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(image.FilePath, []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	retainedReplacement := retained + ".external"
	if err := os.WriteFile(retainedReplacement, []byte("modified snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(retained); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(retainedReplacement, retained); err != nil {
		t.Fatal(err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	active, err := os.ReadFile(image.FilePath)
	if err != nil || string(active) != "external replacement" {
		t.Fatalf("external active file = %q, err=%v", active, err)
	}
	snapshot, err := os.ReadFile(retained)
	if err != nil || string(snapshot) != "modified snapshot" {
		t.Fatalf("external snapshot replacement = %q, err=%v", snapshot, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE id = ? AND import_undone = 1`, ids[0]).Scan(&rowCount); err != nil || rowCount != 0 {
		t.Fatalf("discarded undone rows = %d, err=%v", rowCount, err)
	}
}

func TestDiscardedRedoSnapshotIsReclaimed(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "discard.png", Data: base64.StdEncoding.EncodeToString([]byte("discard"))}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	retained := filepath.Join(repoPath, ".loom", "trash", "import-redo")
	entries, err := filepath.Glob(filepath.Join(retained, "*-discard.png"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("discard snapshot entries before branch = %v err=%v", entries, err)
	}
	retainedPath := entries[0]
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatalf("committed graph mutation failed: %v", err)
	}
	if _, err := os.Stat(retainedPath); !os.IsNotExist(err) {
		t.Fatalf("disused redo snapshot was not reclaimed: %v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	relationships, err := repo.ListRelationships()
	if err != nil || len(relationships) != 1 {
		t.Fatalf("relationships after redo-tail cleanup = %+v, err=%v", relationships, err)
	}
}

func TestDiscardedActiveFileRemainsSuppressedWithoutPathUnlink(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "cleanup-fails.png", Data: base64.StdEncoding.EncodeToString([]byte("keep suppressed"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatalf("public graph mutation failed: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("explicit scan after cleanup failure: %v", err)
	}
	var imageRows int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&imageRows); err != nil || imageRows != 0 {
		t.Fatalf("explicit scan resurrected discarded import: rows=%d err=%v", imageRows, err)
	}
	if _, err := repo.RefreshFingerprints(context.Background()); err != nil {
		t.Fatalf("fingerprint refresh after cleanup failure: %v", err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&imageRows); err != nil || imageRows != 0 {
		t.Fatalf("fingerprint refresh resurrected discarded import: rows=%d err=%v", imageRows, err)
	}
	var opCount, suppressionCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM operation_log WHERE kind = ?`, stepGraphInsert).Scan(&opCount); err != nil || opCount != 1 {
		t.Fatalf("committed graph operation count = %d, err=%v", opCount, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, image.FilePath).Scan(&suppressionCount); err != nil || suppressionCount != 1 {
		t.Fatalf("active-file suppression count = %d, err=%v", suppressionCount, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("suppressed import bytes should remain on disk: %v", err)
	}
	canvas, err := service.LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range canvas.Images {
		if found.ID == ids[0] || found.FilePath == image.FilePath {
			t.Fatalf("failed-cleanup import was rediscovered: %+v", found)
		}
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&opCount); err != nil || opCount != 0 {
		t.Fatalf("discarded import image rows after discovery = %d, err=%v", opCount, err)
	}
}

func TestFailedBatchRedoDoesNotWriteAnyReplacementFiles(t *testing.T) {
	repoPath := t.TempDir()
	items := []ClipboardMedia{
		{Name: "redo-a.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
		{Name: "redo-b.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "redo-a.png"), []byte("external A"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "redo-b.png"), []byte("external B"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(payload.Entries[1].RetainedPath); err != nil {
		t.Fatal(err)
	}
	result, err := (&UndoService{}).Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo with missing second snapshot = %+v, err=%v", result, err)
	}
	files, err := filepath.Glob(filepath.Join(repoPath, "* (redo *)"))
	if err != nil || len(files) != 0 {
		t.Fatalf("redo replacement files = %v, err=%v", files, err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo || state.CanUndo {
		t.Fatalf("history after failed redo = %+v, err=%v", state, err)
	}
	for _, id := range ids {
		image, err := func() (store.Image, error) {
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				return store.Image{}, err
			}
			defer repo.Close()
			return repo.GetImageByID(id)
		}()
		if err != nil || !image.ImportUndone {
			t.Fatalf("image after failed redo = %+v, err=%v", image, err)
		}
	}
}

func TestPersistentRedoStatFailureSuppressesUnverifiedReplacement(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "redo-stat.png", Data: base64.StdEncoding.EncodeToString([]byte("retained bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repoPath, "redo-stat.png")); err != nil {
		t.Fatal(err)
	}
	service := &UndoService{writeImportRedoFile: func(path string, data []byte) (os.FileInfo, error) {
		return writeExclusiveModeUsing(path, data, 0o600, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
			file, err := os.OpenFile(path, flags, mode)
			if err != nil {
				return nil, err
			}
			return &failingExclusiveFile{
				file: file, statErr: errors.New("persistent redo stat failure"), statAlwaysFail: true,
				writeSize: 0, writeErr: errors.New("write must not run"),
			}, nil
		})
	}}
	result, err := service.Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo with persistent stat failure = %+v, err=%v", result, err)
	}
	path := filepath.Join(repoPath, "redo-stat (redo 1).png")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("failed redo published an unverified replacement, err=%v", err)
	}
	staged, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil {
		t.Fatalf("unverified redo staging files = %v, err=%v", staged, err)
	}
	var unverifiedStage string
	for _, candidate := range staged {
		data, err := os.ReadFile(candidate)
		if err == nil && len(data) == 0 {
			unverifiedStage = candidate
			break
		}
	}
	if unverifiedStage == "" {
		t.Fatalf("unverified redo staging file not found in %v", staged)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for name, discover := range map[string]func(context.Context) (int, error){
		"register": repo.RegisterImages,
		"scan":     repo.ScanAndRegisterImages,
		"refresh":  repo.RefreshFingerprints,
	} {
		if _, err := discover(context.Background()); err != nil {
			t.Fatalf("%s after failed redo: %v", name, err)
		}
		var rows int
		if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("%s registered failed-redo file: rows=%d err=%v", name, rows, err)
		}
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("image after failed redo = %+v err=%v", image, err)
	}
}

func TestFailedBatchRedoKeepsPartialFilesSuppressedWithoutUnlinking(t *testing.T) {
	for _, tc := range []struct {
		name        string
		modifyFirst bool
	}{
		{name: "intact"},
		{name: "externally-modified", modifyFirst: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			items := []ClipboardMedia{
				{Name: "redo-a.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
				{Name: "redo-b.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
			}
			ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := (&UndoService{}).Undo(repoPath); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"redo-a.png", "redo-b.png"} {
				if err := os.Remove(filepath.Join(repoPath, name)); err != nil {
					t.Fatal(err)
				}
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			trigger := fmt.Sprintf(`CREATE TRIGGER fail_second_redo BEFORE UPDATE OF file_path ON images WHEN OLD.id = %d BEGIN SELECT RAISE(FAIL, 'injected redo failure'); END`, ids[1])
			if _, err := repo.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			service := &UndoService{}
			service.writeImportRedoFile = func(path string, data []byte) (os.FileInfo, error) {
				if filepath.Base(path) == "redo-b (redo 1).png" {
					return nil, errors.New("injected second redo write failure")
				}
				return writeExclusive(path, data)
			}
			if tc.modifyFirst {
				service.afterImportRedoFileWrite = func(path string) {
					if filepath.Base(path) == "redo-a (redo 1).png" {
						if err := os.WriteFile(path, []byte("external replacement edit"), 0o600); err != nil {
							t.Errorf("modify replacement: %v", err)
						}
					}
				}
			}
			result, err := service.Redo(repoPath)
			if err != nil || result.Applied || result.Error == "" {
				t.Fatalf("failed redo = %+v, err=%v", result, err)
			}
			firstReplacement := filepath.Join(repoPath, "redo-a (redo 1).png")
			secondReplacement := filepath.Join(repoPath, "redo-b (redo 1).png")
			data, err := os.ReadFile(firstReplacement)
			want := "first"
			if tc.modifyFirst {
				want = "external replacement edit"
			}
			if err != nil || string(data) != want {
				t.Fatalf("replacement after rollback = %q, want %q, err=%v", data, want, err)
			}
			if _, err := os.Stat(secondReplacement); !os.IsNotExist(err) {
				t.Fatalf("second replacement survived rollback: %v", err)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			for _, id := range ids {
				image, err := repo.GetImageByID(id)
				if err != nil || !image.ImportUndone {
					t.Fatalf("image after failed redo = %+v, err=%v", image, err)
				}
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
				t.Fatalf("discover after failed redo: %v", err)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			var count int
			if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstReplacement).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if tc.modifyFirst && count != 1 {
				t.Fatalf("externally changed redo file rows = %d, want 1", count)
			}
			if !tc.modifyFirst && count != 0 {
				t.Fatalf("failed-redo bytes were rediscovered: rows=%d", count)
			}
			if tc.modifyFirst {
				data, err := os.ReadFile(firstReplacement)
				if err != nil || string(data) != "external replacement edit" {
					t.Fatalf("external redo replacement changed during discovery: %q err=%v", data, err)
				}
			}
		})
	}
}

func TestMixedPurgeRejectsBeforeDeletingAnyImage(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	trashedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "trashed.png", Data: base64.StdEncoding.EncodeToString([]byte("trashed"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.TrashImage(repoPath, trashedIDs[0]); err != nil {
		t.Fatal(err)
	}
	undoneIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "undone.png", Data: base64.StdEncoding.EncodeToString([]byte("undone"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	trashedImage, err := repo.GetImageByID(trashedIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	trashedPath := trashedImage.FilePath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	undonePath := filepath.Join(repoPath, "undone.png")
	if err := service.PurgeImages(repoPath, []int64{trashedIDs[0], undoneIDs[0]}); err == nil {
		t.Fatal("mixed purge unexpectedly succeeded")
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for _, id := range []int64{trashedIDs[0], undoneIDs[0]} {
		if _, err := repo.GetImageByID(id); err != nil {
			t.Fatalf("image %d was deleted by rejected purge: %v", id, err)
		}
	}
	for _, path := range []string{trashedPath, undonePath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("file %s was deleted by rejected purge: %v", path, err)
		}
	}
}

func TestImportCommitSucceedsAndReclaimsModifiedOwnedSnapshot(t *testing.T) {
	repoPath := t.TempDir()
	_, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "branch.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	modified := []byte("external snapshot modification")
	if err := os.WriteFile(retained, modified, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "new-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new"))}}, false, 0, 0); err != nil {
		t.Fatalf("committed import failed during best-effort cleanup: %v", err)
	}
	if _, err := os.Stat(retained); !os.IsNotExist(err) {
		t.Fatalf("owned modified snapshot after cleanup was not reclaimed: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE import_undone = 0`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("committed active imports = %d, err=%v", count, err)
	}
}

func TestImportRollbackPreservesExternallyModifiedOwnedFile(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_second_import BEFORE INSERT ON images WHEN NEW.file_path LIKE '%second.png' BEGIN SELECT RAISE(FAIL, 'injected second insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	service := &ImageService{afterImportFileWrite: func(path string) {
		if filepath.Base(path) == "first.png" {
			if err := os.WriteFile(path, []byte("external in-place edit"), 0o600); err != nil {
				t.Errorf("modify owned file: %v", err)
			}
		}
	}}
	_, err = service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	data, err := os.ReadFile(filepath.Join(repoPath, "first.png"))
	if err != nil || string(data) != "external in-place edit" {
		t.Fatalf("external file after rollback = %q, err=%v", data, err)
	}
	firstPath := filepath.Join(repoPath, "first.png")
	firstInfo, err := os.Stat(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	firstIdentity := store.FileIdentityAt(firstPath, firstInfo)
	anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil {
		t.Fatal(err)
	}
	for _, anchor := range anchors {
		info, err := os.Stat(anchor)
		if err != nil {
			t.Fatal(err)
		}
		if store.FileIdentityAt(anchor, info) == firstIdentity {
			t.Fatalf("failed batch left an unreferenced anchor for the modified external file: %s", anchor)
		}
	}
}

func TestInitialImportRejectsFilesChangedDuringBatch(t *testing.T) {
	for _, tc := range []struct {
		name     string
		replace  bool
		newBytes []byte
	}{
		{name: "replacement", replace: true, newBytes: []byte("external replacement")},
		{name: "in-place modification", newBytes: []byte("external in-place edit")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			firstPath := filepath.Join(repoPath, "batch-first.png")
			service := &ImageService{afterImportFileWrite: func(path string) {
				if filepath.Base(path) != "batch-second.png" {
					return
				}
				if tc.replace {
					replacement := firstPath + ".external"
					if err := os.WriteFile(replacement, tc.newBytes, 0o600); err != nil {
						t.Errorf("write external replacement: %v", err)
						return
					}
					if err := os.Remove(firstPath); err != nil {
						t.Errorf("remove first published file: %v", err)
						return
					}
					if err := os.Rename(replacement, firstPath); err != nil {
						t.Errorf("publish external replacement: %v", err)
					}
					return
				}
				if err := os.WriteFile(firstPath, tc.newBytes, 0o600); err != nil {
					t.Errorf("modify first published file in place: %v", err)
				}
			}}
			_, err := service.ImportMedia(repoPath, []ClipboardMedia{
				{Name: "batch-first.png", Data: base64.StdEncoding.EncodeToString([]byte("captured first bytes"))},
				{Name: "batch-second.png", Data: base64.StdEncoding.EncodeToString([]byte("captured second bytes"))},
			}, false, 0, 0)
			if err == nil {
				t.Fatal("ImportMedia committed a batch after a member changed")
			}
			if got, err := os.ReadFile(firstPath); err != nil || !bytes.Equal(got, tc.newBytes) {
				t.Fatalf("external file after rejected import = %q err=%v", got, err)
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			var imports, rows, suppressions int
			if err := repo.DB.QueryRow(`SELECT count(*) FROM operation_log WHERE kind = 'import_batch'`).Scan(&imports); err != nil || imports != 0 {
				t.Fatalf("committed import operations = %d err=%v", imports, err)
			}
			if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 0 {
				t.Fatalf("rolled-back import rows before discovery = %d err=%v", rows, err)
			}
			if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, firstPath).Scan(&suppressions); err != nil || suppressions != 0 {
				t.Fatalf("changed file suppression count = %d err=%v", suppressions, err)
			}
			if _, err := repo.RegisterImages(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 1 {
				t.Fatalf("external file discovery rows = %d err=%v", rows, err)
			}
		})
	}
}

func TestInitialImportRejectsChangedRetainedCopiesDuringBatch(t *testing.T) {
	for _, tc := range []struct {
		name     string
		replace  bool
		newBytes []byte
	}{
		{name: "replacement", replace: true, newBytes: []byte("external retained replacement")},
		{name: "in-place modification", newBytes: []byte("external retained edit")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			var changedRetainedPath string
			service := &ImageService{afterImportFileWrite: func(path string) {
				if filepath.Base(path) != "retained-second.png" {
					return
				}
				matches, err := filepath.Glob(filepath.Join(repoPath, ".loom", "trash", "import-redo", "*-retained-first.png"))
				if err != nil || len(matches) != 1 {
					t.Errorf("find first retained copy: paths=%v err=%v", matches, err)
					return
				}
				changedRetainedPath = matches[0]
				if tc.replace {
					replacement := changedRetainedPath + ".external"
					if err := os.WriteFile(replacement, tc.newBytes, 0o600); err != nil {
						t.Errorf("write retained replacement: %v", err)
						return
					}
					if err := os.Remove(changedRetainedPath); err != nil {
						t.Errorf("remove retained copy: %v", err)
						return
					}
					if err := os.Rename(replacement, changedRetainedPath); err != nil {
						t.Errorf("publish retained replacement: %v", err)
					}
					return
				}
				if err := os.WriteFile(changedRetainedPath, tc.newBytes, 0o600); err != nil {
					t.Errorf("modify retained copy in place: %v", err)
				}
			}}
			_, err := service.ImportMedia(repoPath, []ClipboardMedia{
				{Name: "retained-first.png", Data: base64.StdEncoding.EncodeToString([]byte("captured retained bytes"))},
				{Name: "retained-second.png", Data: base64.StdEncoding.EncodeToString([]byte("second batch member"))},
			}, false, 0, 0)
			if err == nil {
				t.Fatal("ImportMedia committed after a retained copy changed")
			}
			if changedRetainedPath == "" {
				t.Fatal("first retained copy was not found during second item import")
			}
			if got, err := os.ReadFile(changedRetainedPath); err != nil || !bytes.Equal(got, tc.newBytes) {
				t.Fatalf("external retained file after rollback = %q err=%v", got, err)
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			var operations, images int
			if err := repo.DB.QueryRow(`SELECT count(*) FROM operation_log WHERE kind = 'import_batch'`).Scan(&operations); err != nil || operations != 0 {
				t.Fatalf("committed import operations = %d err=%v", operations, err)
			}
			if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path IN (?, ?)`, filepath.Join(repoPath, "retained-first.png"), filepath.Join(repoPath, "retained-second.png")).Scan(&images); err != nil || images != 0 {
				t.Fatalf("rolled-back import image rows = %d err=%v", images, err)
			}
		})
	}
}

func TestImportRollbackSuppressionAllowsExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_second_import BEFORE INSERT ON images WHEN NEW.file_path LIKE '%second.png' BEGIN SELECT RAISE(FAIL, 'injected second insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	service := &ImageService{}
	_, err = service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("failed batch member"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("trigger failure"))},
	}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	firstPath := filepath.Join(repoPath, "first.png")
	if data, err := os.ReadFile(firstPath); err != nil || string(data) != "failed batch member" {
		t.Fatalf("retained failed-batch file = %q, err=%v", data, err)
	}
	secondPath := filepath.Join(repoPath, "second.png")
	if data, err := os.ReadFile(secondPath); err != nil || string(data) != "trigger failure" {
		t.Fatalf("second failed-batch file after rollback = %q, err=%v", data, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var rows, suppressions int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, firstPath).Scan(&suppressions); err != nil || suppressions != 1 {
		t.Fatalf("failed-batch suppression = %d, err=%v", suppressions, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, secondPath).Scan(&suppressions); err != nil || suppressions != 1 {
		t.Fatalf("second failed-batch suppression = %d, err=%v", suppressions, err)
	}
	retainedFiles, err := filepath.Glob(filepath.Join(repoPath, ".loom", "trash", "import-redo", "*"))
	if err != nil || len(retainedFiles) != 0 {
		t.Fatalf("retained copies after batch rollback = %v, err=%v", retainedFiles, err)
	}
	anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(anchors) != 2 {
		t.Fatalf("anchors after failed batch = %v err=%v, want only the two tombstone-owned visible files", anchors, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("failed-batch row before discovery = %d, err=%v", rows, err)
	}
	for name, discover := range map[string]func(context.Context) (int, error){
		"register": repo.RegisterImages,
		"scan":     repo.ScanAndRegisterImages,
		"refresh":  repo.RefreshFingerprints,
	} {
		if _, err := discover(context.Background()); err != nil {
			t.Fatalf("%s after failed import: %v", name, err)
		}
		if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("%s registered failed-batch file: rows=%d err=%v", name, rows, err)
		}
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	external := []byte("genuine external replacement")
	if err := os.WriteFile(firstPath, external, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RescanRepository(repoPath); err != nil {
		t.Fatalf("discover external replacement: %v", err)
	}
	data, err := os.ReadFile(firstPath)
	if err != nil || !bytes.Equal(data, external) {
		t.Fatalf("external replacement after discovery = %q, err=%v", data, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("external replacement rows = %d, err=%v", rows, err)
	}
}

func TestDiscardedImportRedoBranchReclaimsUnreferencedSnapshots(t *testing.T) {
	repoPath := t.TempDir()
	_, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "branch.png", Data: base64.StdEncoding.EncodeToString([]byte("branch"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	newIDs, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "new-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(retained); !os.IsNotExist(err) {
		t.Fatalf("discarded redo snapshot remains: %v", err)
	}
	anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(anchors) != 3 {
		t.Fatalf("anchors after redo-tail discard = %v err=%v, want hidden asset anchor plus new import anchors", anchors, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	purgedSnapshot := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).TrashImage(repoPath, newIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).PurgeImages(repoPath, newIDs); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(purgedSnapshot); !os.IsNotExist(err) {
		t.Fatalf("purged image snapshot remains: %v", err)
	}
	anchors, err = filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(anchors) != 1 {
		t.Fatalf("anchors after purge = %v err=%v, want only still-hidden discarded asset anchor", anchors, err)
	}
}

func TestRedoTailCleanupPreservesExternalRetainedReplacement(t *testing.T) {
	repoPath := t.TempDir()
	captured := []byte("retained bytes")
	if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "retained-cleanup.png", Data: base64.StdEncoding.EncodeToString(captured),
	}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	var operation OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &operation); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := json.Unmarshal(operation.Payload, &payload); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	entry := payload.Entries[0]
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	replacement := entry.RetainedPath + ".external"
	if err := os.WriteFile(replacement, captured, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(entry.RetainedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, entry.RetainedPath); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(entry.RetainedPath)
	if err != nil {
		t.Fatal(err)
	}
	if identity := store.FileIdentityAt(entry.RetainedPath, info); identity == entry.RetainedIdentity {
		t.Fatalf("retained replacement reused identity %q", identity)
	}
	if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "new-history-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new branch")),
	}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(entry.RetainedPath); err != nil || !bytes.Equal(got, captured) {
		t.Fatalf("external retained replacement after cleanup = %q err=%v", got, err)
	}
}

func TestRedoTailDiscardReclaimsResourcesAfterRescanExposesReplacement(t *testing.T) {
	for _, tc := range []struct {
		name     string
		discover func(*store.Repo) (int, error)
	}{
		{name: "rescan", discover: func(repo *store.Repo) (int, error) { return repo.ScanAndRegisterImages(context.Background()) }},
		{name: "normal discovery", discover: func(repo *store.Repo) (int, error) { return repo.RegisterImages(context.Background()) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "rescanned.png", Data: base64.StdEncoding.EncodeToString([]byte("imported"))}}, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			var forward string
			if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			var step OpStep
			var payload importBatchPayload
			if err := json.Unmarshal([]byte(forward), &step); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			if err := json.Unmarshal(step.Payload, &payload); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			entry := payload.Entries[0]
			var path string
			if err := repo.DB.QueryRow(`SELECT file_path FROM images WHERE id = ?`, ids[0]).Scan(&path); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := (&UndoService{}).Undo(repoPath); err != nil {
				t.Fatal(err)
			}
			replacement := path + ".external"
			if err := os.WriteFile(replacement, []byte("external replacement"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tc.discover(repo); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			var undone bool
			var identity sql.NullString
			if err := repo.DB.QueryRow(`SELECT import_undone, import_file_identity FROM images WHERE id = ?`, ids[0]).Scan(&undone, &identity); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			if undone || !identity.Valid || identity.String != "" {
				repo.Close()
				t.Fatalf("discovered external replacement retains import ownership: undone=%v identity=%v", undone, identity)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "new-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new branch"))}}, false, 0, 0); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(entry.RetainedPath); !os.IsNotExist(err) {
				t.Fatalf("retained snapshot after rescan and redo-tail discard: %v", err)
			}
			if got, err := os.ReadFile(path); err != nil || string(got) != "external replacement" {
				t.Fatalf("visible external replacement = %q, err=%v", got, err)
			}
			anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
			if err != nil {
				t.Fatal(err)
			}
			for _, anchor := range anchors {
				info, err := os.Stat(anchor)
				if err != nil {
					t.Fatal(err)
				}
				if store.FileIdentityAt(anchor, info) == entry.FileIdentity {
					t.Fatalf("obsolete import identity anchor remains: %s", anchor)
				}
			}
		})
	}
}

func TestDiscoveryDetachesActiveImportOwnershipFromSameBytesReplacement(t *testing.T) {
	for _, tc := range []struct {
		name     string
		discover func(*store.Repo) (int, error)
	}{
		{name: "normal discovery", discover: func(repo *store.Repo) (int, error) { return repo.RegisterImages(context.Background()) }},
		{name: "explicit rescan", discover: func(repo *store.Repo) (int, error) { return repo.ScanAndRegisterImages(context.Background()) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			captured := []byte("same bytes, external inode")
			ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "active-replacement.png", Data: base64.StdEncoding.EncodeToString(captured)}}, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			var path, originalIdentity string
			if err := repo.DB.QueryRow(`SELECT file_path, import_file_identity FROM images WHERE id = ?`, ids[0]).Scan(&path, &originalIdentity); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			originalInfo, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			replacement := path + ".external"
			if err := os.WriteFile(replacement, captured, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(replacement, originalInfo.ModTime(), originalInfo.ModTime()); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
			replacementInfo, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if got := store.FileIdentityAt(path, replacementInfo); got == "" || got == originalIdentity {
				t.Fatalf("replacement identity %q, original identity %q", got, originalIdentity)
			}
			if replacementInfo.Size() != originalInfo.Size() || !replacementInfo.ModTime().Equal(originalInfo.ModTime()) {
				t.Fatalf("replacement stat differs: original=%v replacement=%v", originalInfo, replacementInfo)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tc.discover(repo); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			var importUndone bool
			var identity, hash string
			if err := repo.DB.QueryRow(`SELECT import_undone, import_file_identity, import_file_sha256 FROM images WHERE id = ?`, ids[0]).Scan(&importUndone, &identity, &hash); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			if importUndone || identity != "" || hash != "" {
				repo.Close()
				t.Fatalf("discovery kept import ownership: undone=%v identity=%q hash=%q", importUndone, identity, hash)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			result, err := (&UndoService{}).Undo(repoPath)
			if err != nil || result.Applied || result.Error == "" {
				t.Fatalf("undo after replacement discovery = %+v, err=%v", result, err)
			}
			if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, captured) {
				t.Fatalf("external replacement after failed undo = %q, err=%v", got, err)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			image, err := repo.GetImageByID(ids[0])
			if err != nil || image.ImportUndone || image.Trashed {
				t.Fatalf("image after failed undo = %+v, err=%v", image, err)
			}
		})
	}
}

func TestRepeatedImportRestoresRetainEveryIdentityForCleanup(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "restore-cycles.png", Data: base64.StdEncoding.EncodeToString([]byte("restore bytes"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	for cycle := 0; cycle < 2; cycle++ {
		if _, err := (&UndoService{}).Undo(repoPath); err != nil {
			t.Fatalf("undo cycle %d: %v", cycle+1, err)
		}
		repo, err := store.Bootstrap(repoPath)
		if err != nil {
			t.Fatal(err)
		}
		var currentPath string
		if err := repo.DB.QueryRow(`SELECT file_path FROM images WHERE id = ?`, ids[0]).Scan(&currentPath); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := repo.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(currentPath); err != nil && !os.IsNotExist(err) {
			t.Fatalf("remove import before redo cycle %d: %v", cycle+1, err)
		}
		if _, err := (&UndoService{}).Redo(repoPath); err != nil {
			t.Fatalf("redo cycle %d: %v", cycle+1, err)
		}
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var path string
	if err := repo.DB.QueryRow(`SELECT file_path FROM images WHERE id = ?`, ids[0]).Scan(&path); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	var step OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &step); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := json.Unmarshal(step.Payload, &payload); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	identities := payload.Entries[0].FileIdentities
	if len(identities) < 3 {
		repo.Close()
		t.Fatalf("recorded file identities after restore cycles = %v, want all three identities", identities)
	}
	for i, identity := range identities {
		for _, later := range identities[i+1:] {
			if identity == later {
				repo.Close()
				t.Fatalf("duplicate recorded file identity %q in %v", identity, identities)
			}
		}
	}
	var currentIdentity string
	if err := repo.DB.QueryRow(`SELECT import_file_identity FROM images WHERE id = ?`, ids[0]).Scan(&currentIdentity); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	retainedPath := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "discard-cycles.png", Data: base64.StdEncoding.EncodeToString([]byte("new branch"))}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	for _, identity := range identities {
		anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
		if err != nil {
			t.Fatal(err)
		}
		for _, anchor := range anchors {
			info, err := os.Stat(anchor)
			if err != nil {
				t.Fatal(err)
			}
			if identity != currentIdentity && store.FileIdentityAt(anchor, info) == identity {
				t.Errorf("obsolete restore-cycle identity anchor remains for %q: %s", identity, anchor)
			}
		}
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("visible import path after redo-tail discard: %v", err)
	}
	if _, err := os.Stat(retainedPath); !os.IsNotExist(err) {
		t.Fatalf("retained snapshot after redo-tail discard: %v", err)
	}
}

func TestRedoTailDiscardFailsClosedWhenRecordedIdentityIsUnknown(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "unknown-identity.png", Data: base64.StdEncoding.EncodeToString([]byte("unknown identity"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var seq int64
	var forward, inverse string
	if err := repo.DB.QueryRow(`SELECT seq, forward, inverse FROM operation_log WHERE kind = 'import_batch'`).Scan(&seq, &forward, &inverse); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	unknownPayload := func(raw string) string {
		var step OpStep
		var payload importBatchPayload
		if err := json.Unmarshal([]byte(raw), &step); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(step.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		for i := range payload.Entries {
			payload.Entries[i].FileIdentity = ""
			payload.Entries[i].FileIdentities = nil
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		step.Payload = encoded
		updated, err := json.Marshal(step)
		if err != nil {
			t.Fatal(err)
		}
		return string(updated)
	}
	if _, err := repo.DB.Exec(`UPDATE operation_log SET forward = ?, inverse = ? WHERE seq = ?`, unknownPayload(forward), unknownPayload(inverse), seq); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET import_undone = 1, import_file_identity = '' WHERE id = ?`, ids[0]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO settings(scope, key, value) VALUES ('repo', 'undo_cursor', ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, fmt.Sprint(seq-1)); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "must-not-resurrect.png", Data: base64.StdEncoding.EncodeToString([]byte("new branch"))}}, false, 0, 0); err == nil {
		t.Fatal("redo-tail discard succeeded without a verifiable recorded identity")
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var undone bool
	if err := repo.DB.QueryRow(`SELECT import_undone FROM images WHERE id = ?`, ids[0]).Scan(&undone); err != nil || !undone {
		t.Fatalf("hidden import state after rejected discard = %v, err=%v", undone, err)
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log WHERE kind = 'import_batch'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("import history after rejected discard = %d, err=%v", count, err)
	}
}

func TestPurgePreservesExternalRetainedReplacementAndReclaimsAnchors(t *testing.T) {
	repoPath := t.TempDir()
	captured := []byte("purged retained bytes")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "purge-retained.png", Data: base64.StdEncoding.EncodeToString(captured),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	var operation OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &operation); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := json.Unmarshal(operation.Payload, &payload); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	entry := payload.Entries[0]
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).TrashImage(repoPath, ids[0]); err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	visibleReplacement := image.FilePath + ".external"
	if err := os.WriteFile(visibleReplacement, []byte("external visible replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(image.FilePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(visibleReplacement, image.FilePath); err != nil {
		t.Fatal(err)
	}
	replacement := entry.RetainedPath + ".external"
	if err := os.WriteFile(replacement, captured, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(entry.RetainedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, entry.RetainedPath); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).PurgeImages(repoPath, ids); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(entry.RetainedPath); err != nil || !bytes.Equal(got, captured) {
		t.Fatalf("external retained replacement after purge = %q err=%v", got, err)
	}
	if got, err := os.ReadFile(image.FilePath); err != nil || string(got) != "external visible replacement" {
		t.Fatalf("external visible replacement after purge = %q err=%v", got, err)
	}
	anchors, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil {
		t.Fatal(err)
	}
	for _, anchor := range anchors {
		info, err := os.Stat(anchor)
		if err != nil {
			continue
		}
		identity := store.FileIdentityAt(anchor, info)
		if identity == entry.FileIdentity || identity == entry.RetainedIdentity {
			t.Fatalf("purged import anchor remains: %s (%s)", anchor, identity)
		}
	}
}

func TestInvalidImportDoesNotCreateHistoryOrFiles(t *testing.T) {
	repoPath := t.TempDir()
	for _, items := range [][]ClipboardMedia{
		{},
		{{Name: "unsupported.txt", Data: base64.StdEncoding.EncodeToString([]byte("x"))}},
		{{Name: "empty.png", Data: ""}},
	} {
		if _, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0); err == nil {
			t.Fatalf("ImportMedia(%v) unexpectedly succeeded", items)
		}
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if state.CanUndo || state.CanRedo {
		t.Fatalf("invalid imports changed history: %+v", state)
	}
	entries, err := os.ReadDir(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != ".loom" {
			t.Fatalf("invalid imports wrote repository files: %v, err=%v", entries, err)
		}
	}
}
