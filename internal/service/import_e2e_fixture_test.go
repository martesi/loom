package service

import (
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

// TestSeedImportRecoveryE2EFixture prepares only the isolated Playwright
// repository selected by the caller. It is inert during ordinary Go tests.
func TestSeedImportRecoveryE2EFixture(t *testing.T) {
	root := os.Getenv("LOOM_E2E_IMPORT_FIXTURE_ROOT")
	mode := os.Getenv("LOOM_E2E_IMPORT_FIXTURE_MODE")
	if root == "" || mode == "" {
		return
	}
	service := &ImageService{}
	switch mode {
	case "pending":
		items, err := prepareImportItems([]ClipboardMedia{
			{Name: "e2e-pending-verified.png", Data: "dmVyaWZpZWQ="},
			{Name: "e2e-pending-changed.png", Data: "Y2hhbmdlZA=="},
			{Name: "e2e-pending-missing.png", Data: "bWlzc2luZw=="},
		})
		if err != nil {
			t.Fatal(err)
		}
		repo, err := store.Bootstrap(root)
		if err != nil {
			t.Fatal(err)
		}
		_, paths, err := reserveImportPaths(repo, items, false, 0, 0)
		if err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := createReservedFiles(items, paths); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := os.WriteFile(paths[1].Path, []byte("changed by user"), 0o600); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := os.Remove(paths[2].Path); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := repo.Close(); err != nil {
			t.Fatal(err)
		}
	case "expired-retained-link":
		sourceIDs, err := service.ImportMedia(root, []ClipboardMedia{{Name: "e2e-expired-source.png", Data: "c291cmNl"}}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		retainedIDs, err := service.ImportMedia(root, []ClipboardMedia{{Name: "e2e-retained-target.png", Data: "dGFyZ2V0"}}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		repo, err := store.Bootstrap(root)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.DB.Exec(`INSERT INTO relationships(source_image_id,derived_image_id) VALUES (?,?)`, sourceIDs[0], retainedIDs[0]); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := repo.Close(); err != nil {
			t.Fatal(err)
		}
		if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
			t.Fatalf("retain linked import: result=%+v err=%v", result, err)
		}
		repo, err = store.Bootstrap(root)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.DB.Exec(`UPDATE images SET trashed=1,trashed_at='2000-01-01T00:00:00.000Z' WHERE id=?`, sourceIDs[0]); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := repo.Close(); err != nil {
			t.Fatal(err)
		}
		for name, want := range map[string]string{
			"e2e-expired-source.png":  "source",
			"e2e-retained-target.png": "target",
		} {
			path := filepath.Join(root, name)
			data, err := os.ReadFile(path)
			if err != nil || string(data) != want {
				t.Fatalf("seed changed fixture file %s: %q err=%v", path, data, err)
			}
		}
	case "legacy-retained":
		ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "e2e-legacy-retained.png", Data: "bGVnYWN5"}}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
			t.Fatalf("retain legacy fixture: %+v err=%v", result, err)
		}
		repo, err := store.Bootstrap(root)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.DB.Exec(`UPDATE import_recovery SET trusted=0 WHERE image_id=?`, ids[0]); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := repo.Close(); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown recovery fixture mode %q", mode)
	}
}
