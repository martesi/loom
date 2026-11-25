package service

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"loom/internal/store"
)

func TestImportDoesNotReuseRegisteredMissingPath(t *testing.T) {
	root := t.TempDir()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	reserved := filepath.Join(root, "reserved.png")
	if _, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, reserved); err != nil {
		t.Fatal(err)
	}
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "reserved.png", Data: "YQ=="}}, false, 0, 0)
	if err != nil || len(ids) != 1 {
		t.Fatalf("import with reserved name: ids=%v err=%v", ids, err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || image.FilePath != filepath.Join(root, "reserved (1).png") {
		t.Fatalf("reserved path reused: image=%+v err=%v", image, err)
	}
	if _, err := os.Stat(reserved); !os.IsNotExist(err) {
		t.Fatalf("reserved path should stay absent: %v", err)
	}
}

func TestImportRejectsNonfiniteDropCoordinates(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		for _, coordinates := range [][2]float64{{value, 0}, {0, value}} {
			root := t.TempDir()
			_, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "a.png", Data: "YQ=="}}, true, coordinates[0], coordinates[1])
			if err == nil {
				t.Fatalf("accepted nonfinite coordinates %v", coordinates)
			}
			if _, err := os.Stat(filepath.Join(root, "a.png")); !os.IsNotExist(err) {
				t.Fatalf("invalid coordinates created file: %v", err)
			}
		}
	}
}

func TestImportFailureLeavesCreatedFilesAndRollsBackRows(t *testing.T) {
	root := t.TempDir()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	_, err = repo.DB.Exec(`CREATE TRIGGER fail_second_import BEFORE INSERT ON images
		WHEN NEW.file_path LIKE '%second.png' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
	if err != nil {
		t.Fatal(err)
	}

	items := []ClipboardMedia{{Name: "first.png", Data: "YQ=="}, {Name: "second.png", Data: "Yg=="}}
	ids, err := (&ImageService{}).ImportMedia(root, items, false, 0, 0)
	if err == nil || len(ids) != 0 {
		t.Fatalf("expected failed batch, got ids=%v err=%v", ids, err)
	}
	for _, name := range []string{"first.png", "second.png"} {
		path := filepath.Join(root, name)
		if _, statErr := os.Stat(path); statErr != nil {
			t.Errorf("failed import must leave %s in place: %v", name, statErr)
		}
		if !strings.Contains(err.Error(), path) {
			t.Errorf("failure must report potentially discoverable file %s: %v", path, err)
		}
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial database batch: count=%d err=%v", count, err)
	}
}
