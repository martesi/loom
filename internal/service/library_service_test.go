package service

import (
	"testing"
)

func TestLibraryPairedIncludesTrashedRelationships(t *testing.T) {
	path, repo, ids := graphFixture(t)
	if _, err := repo.DB.Exec(`
		INSERT INTO relationships(source_image_id, derived_image_id) VALUES
			(?, ?), (?, ?), (?, ?)`,
		ids[0], ids[1], ids[0], ids[2], ids[2], ids[3]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE relationships SET created_at = NULL WHERE source_image_id = ? AND derived_image_id = ?`, ids[0], ids[2]); err != nil {
		t.Fatal(err)
	}
	activeEdges, err := repo.ListRelationships()
	if err != nil {
		t.Fatal(err)
	}
	legacyTimestampRead := false
	for _, edge := range activeEdges {
		if edge.SourceImageID == ids[0] && edge.DerivedImageID == ids[2] {
			legacyTimestampRead = edge.CreatedAt == nil
		}
	}
	if !legacyTimestampRead {
		t.Fatalf("legacy relationship was not read with a NULL timestamp: %+v", activeEdges)
	}
	imageService := &ImageService{}
	for _, id := range ids[2:] {
		if err := imageService.TrashImage(path, id); err != nil {
			t.Fatal(err)
		}
	}

	service := &LibraryService{}
	all, err := service.ListImages(path, LibraryQuery{Status: "all"})
	if err != nil {
		t.Fatal(err)
	}
	paired := make(map[int64]bool, len(all))
	trashed := make(map[int64]bool, len(all))
	for _, row := range all {
		paired[row.ID] = row.Paired
		trashed[row.ID] = row.Trashed
	}
	for _, id := range ids[:4] {
		if !paired[id] {
			t.Errorf("asset %d paired = %v, trashed = %v", id, paired[id], trashed[id])
		}
	}
	if !trashed[ids[2]] || !trashed[ids[3]] {
		t.Fatalf("trashed endpoints not returned as trashed: %v", trashed)
	}

	activeEdges, err = repo.ListRelationships()
	if err != nil {
		t.Fatal(err)
	}
	if len(activeEdges) != 1 || activeEdges[0].SourceImageID != ids[0] || activeEdges[0].DerivedImageID != ids[1] {
		t.Fatalf("active-canvas relationships changed: %+v", activeEdges)
	}

	if err := imageService.RestoreImage(path, ids[2]); err != nil {
		t.Fatal(err)
	}
	active, err := service.ListImages(path, LibraryQuery{Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	activeIDs := make(map[int64]bool, len(active))
	for _, row := range active {
		activeIDs[row.ID] = true
		if row.ID == ids[0] || row.ID == ids[1] || row.ID == ids[2] {
			if !row.Paired {
				t.Errorf("restored/active related asset %d marked unpaired", row.ID)
			}
		}
	}
	for _, id := range ids[:3] {
		if !activeIDs[id] {
			t.Errorf("restored active asset %d missing from active results", id)
		}
	}
}
