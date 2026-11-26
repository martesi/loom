package service

import (
	"loom/internal/store"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOrdinaryPlacementPreservesLegacyGroupMetadata(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	ids, err := s.ImportMedia(path, []ClipboardMedia{{Name: "a.png", Data: "YQ=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	r, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err := r.DB.Exec(`INSERT INTO groups (id, name, kind, cover_image_id) VALUES (99, 'legacy empty', 'pair', ?)`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.PlaceImages(path, ids, 12, 34); err != nil {
		t.Fatal(err)
	}
	var name, kind string
	var cover int64
	if err := r.DB.QueryRow(`SELECT name, kind, cover_image_id FROM groups WHERE id = 99`).Scan(&name, &kind, &cover); err != nil {
		t.Fatalf("legacy group changed during ordinary placement: %v", err)
	}
	if name != "legacy empty" || kind != "pair" || cover != ids[0] {
		t.Fatalf("legacy metadata changed: %q %q %d", name, kind, cover)
	}
}

func TestPersistedLegacyGroupSurvivesCanvasReload(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	ids, err := s.ImportMedia(path, []ClipboardMedia{
		{Name: "a.png", Data: "YQ=="},
		{Name: "b.png", Data: "Yg=="},
		{Name: "c.png", Data: "Yw=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	result, err := repo.DB.Exec("INSERT INTO groups(name,kind,cover_image_id) VALUES('legacy','pair',?)", ids[0])
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	groupID, err := result.LastInsertId()
	if err == nil {
		_, err = repo.DB.Exec("UPDATE images SET group_id=? WHERE id IN (?,?)", groupID, ids[0], ids[1])
	}
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.PlaceImages(path, []int64{ids[0], ids[2]}, 10, 20); err != nil {
		t.Fatal(err)
	}
	for _, target := range ids[1:] {
		if err := s.LinkSource(path, ids[0], target); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (&PromptService{}).CreateAndAttachPrompt(path, ids[1], "legacy", "legacy prompt", ""); err != nil {
		t.Fatal(err)
	}
	first, err := s.LoadCanvas(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.LoadCanvas(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("canvas reload changed persisted data: first=%+v second=%+v", first, second)
	}
	if len(first.Images) != 3 || len(first.Relationships) != 2 || len(first.Groups) != 1 {
		t.Fatalf("lost legacy data: %+v", first)
	}
	if first.Groups[0].ID != groupID || first.Groups[0].Name != "legacy" || first.Groups[0].Kind != "pair" || first.Groups[0].CoverImageID != ids[0] || !reflect.DeepEqual(first.Groups[0].MemberIDs, ids[:2]) {
		t.Fatalf("legacy group changed: %+v", first.Groups[0])
	}
	images := make(map[int64]ImageInfo)
	for _, image := range first.Images {
		images[image.ID] = image
	}
	if images[ids[1]].Placed || images[ids[1]].GroupID != groupID || images[ids[1]].PromptText != "legacy prompt" {
		t.Fatalf("unplaced member changed: %+v", images[ids[1]])
	}
	for i, edge := range first.Relationships {
		if edge.ID == 0 || edge.SourceImageID != ids[0] || edge.DerivedImageID != ids[i+1] {
			t.Fatalf("individual relationship changed: %+v", edge)
		}
	}
	for i, name := range []string{"a.png", "b.png", "c.png"} {
		contents, err := os.ReadFile(filepath.Join(path, name))
		if err != nil || string(contents) != string(rune('a'+i)) {
			t.Fatalf("media %s changed: %q %v", name, contents, err)
		}
	}
}
