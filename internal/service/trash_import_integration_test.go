package service

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBatchTrashPreservesImportedLinkOwnership(t *testing.T) {
	for _, mode := range []string{"symlink", "hard-link"} {
		t.Run(mode, func(t *testing.T) {
			repo, sources := makeImportModeFixture(t, t.TempDir(), "linked.png", "copied.png")
			var linked []int64
			var anchor string
			if mode == "hard-link" {
				linked, anchor = createHardlinkForLifecycleTest(t, repo, sources[0])
			} else {
				var err error
				linked, err = importNativePaths(repo, sources[:1], importLink, false, 0, 0)
				if err != nil || len(linked) != 1 {
					t.Fatalf("import link: ids=%v err=%v", linked, err)
				}
				if _, err := os.Readlink(filepath.Join(repo, "linked.png")); err != nil && runtime.GOOS == "windows" {
					t.Skip("symlinks unavailable on this Windows runner")
				}
			}
			copied, err := importNativePaths(repo, sources[1:], importCopy, false, 0, 0)
			if err != nil || len(copied) != 1 {
				t.Fatalf("import copy: ids=%v err=%v", copied, err)
			}
			ids := []int64{linked[0], copied[0]}
			movedSource := sources[0] + ".offline"
			if err := os.Rename(sources[0], movedSource); err != nil {
				t.Fatal(err)
			}
			linkedInRepo := filepath.Join(repo, "linked.png")
			linkedInTrash := filepath.Join(repo, ".loom", "trash", "linked.png")
			assertLink := func(path string) {
				t.Helper()
				if mode == "hard-link" {
					active, err := os.Lstat(path)
					held, heldErr := os.Lstat(anchor)
					if err != nil || heldErr != nil || !os.SameFile(active, held) {
						t.Fatalf("batch move lost hard-link identity at %q: file=%v anchor=%v", path, err, heldErr)
					}
				} else if target, err := os.Readlink(path); err != nil || target != sources[0] {
					t.Fatalf("batch move changed dangling symlink at %q: target=%q err=%v", path, target, err)
				}
			}

			images := &ImageService{}
			if err := images.TrashImages(repo, ids); err != nil {
				t.Fatal(err)
			}
			expectAbsentImport(t, linkedInRepo)
			assertLink(linkedInTrash)
			assertImportHistory(t, repo, false)
			expectAbsentImport(t, linkedInTrash)
			assertLink(linkedInRepo)
			assertImportHistory(t, repo, true)
			expectAbsentImport(t, linkedInRepo)
			assertLink(linkedInTrash)
			if err := images.RestoreImages(repo, ids); err != nil {
				t.Fatal(err)
			}
			expectAbsentImport(t, linkedInTrash)
			assertLink(linkedInRepo)
			if err := images.PurgeImages(repo, ids); err != nil {
				t.Fatal(err)
			}
			expectAbsentImport(t, linkedInRepo)
			if anchor != "" {
				expectAbsentImport(t, anchor)
			}
			expectImportBytes(t, movedSource, "linked.png")
			expectImportBytes(t, sources[1], "copied.png")
		})
	}
}
