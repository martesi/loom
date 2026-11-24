package service

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"loom/internal/store"
)

type graphState struct {
	relationships []store.Relationship
	cursor        int64
	log           string
}

func snapshotGraph(t *testing.T, repo *store.Repo) graphState {
	t.Helper()
	var state graphState
	var err error
	state.relationships, err = repo.ListRelationships()
	if err != nil {
		t.Fatal(err)
	}
	state.cursor, err = repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT json_group_array(json_array(seq, kind, forward, inverse, created_at)) FROM (SELECT * FROM operation_log ORDER BY seq)`).Scan(&state.log); err != nil {
		t.Fatal(err)
	}
	return state
}

func replaceGraphFile(t *testing.T, path string, index int, replacement string) {
	t.Helper()
	file := filepath.Join(path, fmt.Sprintf("%d.png", index))
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	switch replacement {
	case "directory":
		if err := os.Mkdir(file, 0700); err != nil {
			t.Fatal(err)
		}
	case "symlink":
		target := file + ".target"
		if err := os.WriteFile(target, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, file); err != nil {
			t.Fatal(err)
		}
	case "symlink-directory", "symlink-missing":
		target := file + ".target"
		if replacement == "symlink-directory" {
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.Symlink(target, file); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGraphDirectoryEndpointsRejectMutations(t *testing.T) {
	for _, action := range []string{"link", "reverse"} {
		for _, endpoint := range []int{0, 1} {
			t.Run(fmt.Sprintf("%s/endpoint-%d", action, endpoint), func(t *testing.T) {
				path, repo, ids := graphFixture(t)
				s, u := &ImageService{}, &UndoService{}
				if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
					t.Fatal(err)
				}
				if err := s.LinkSource(path, ids[2], ids[3]); err != nil {
					t.Fatal(err)
				}
				mustUndo(t, u, path, false)
				before := snapshotGraph(t, repo)
				replaceGraphFile(t, path, endpoint, "directory")
				var err error
				if action == "reverse" {
					err = s.ReverseRelationship(path, before.relationships[0].ID)
				} else if endpoint == 0 {
					err = s.LinkSource(path, ids[0], ids[2])
				} else {
					err = s.LinkSource(path, ids[2], ids[1])
				}
				if err == nil || !strings.Contains(err.Error(), "endpoint is unavailable") {
					t.Fatalf("expected unavailable endpoint, got %v", err)
				}
				if after := snapshotGraph(t, repo); !reflect.DeepEqual(before, after) {
					t.Fatalf("failed edit changed state: %#v -> %#v", before, after)
				}
				mustUndo(t, u, path, true)
			})
		}
	}
}

func TestFanoutUnavailableFilesPreserveRedo(t *testing.T) {
	for _, replacement := range []string{"missing", "directory", "symlink-directory", "symlink-missing"} {
		for _, endpoint := range []int{0, 1, 2} {
			t.Run(fmt.Sprintf("%s/endpoint-%d", replacement, endpoint), func(t *testing.T) {
				path, repo, ids := graphFixture(t)
				s, u := &ImageService{}, &UndoService{}
				group, err := repo.DB.Exec(`INSERT INTO groups (name, kind) VALUES ('set', 'variant')`)
				if err != nil {
					t.Fatal(err)
				}
				groupID, err := group.LastInsertId()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := repo.DB.Exec(`UPDATE images SET group_id = ? WHERE id IN (?, ?)`, groupID, ids[1], ids[2]); err != nil {
					t.Fatal(err)
				}
				if err := s.LinkSource(path, ids[2], ids[3]); err != nil {
					t.Fatal(err)
				}
				mustUndo(t, u, path, false)
				trigger := fmt.Sprintf(`CREATE TRIGGER fail_early_insert BEFORE INSERT ON relationships WHEN NEW.source_image_id = %d BEGIN SELECT RAISE(ABORT, 'inserted before file validation'); END`, ids[0])
				if _, err := repo.DB.Exec(trigger); err != nil {
					t.Fatal(err)
				}
				before := snapshotGraph(t, repo)
				replaceGraphFile(t, path, endpoint, replacement)
				if err := s.LinkSourceToGroup(path, ids[0], groupID); err == nil || !strings.Contains(err.Error(), "endpoint is unavailable") {
					t.Fatalf("expected unavailable endpoint, got %v", err)
				}
				if after := snapshotGraph(t, repo); !reflect.DeepEqual(before, after) {
					t.Fatalf("failed fan-out changed state: %#v -> %#v", before, after)
				}
				mustUndo(t, u, path, true)
			})
		}
	}
}

func TestGraphSymlinkToRegularFile(t *testing.T) {
	for _, action := range []string{"link", "reverse", "fanout"} {
		for _, endpoint := range []int{0, 1} {
			t.Run(fmt.Sprintf("%s/endpoint-%d", action, endpoint), func(t *testing.T) {
				path, repo, ids := graphFixture(t)
				s, u := &ImageService{}, &UndoService{}
				if action == "reverse" {
					if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
						t.Fatal(err)
					}
				}
				replaceGraphFile(t, path, endpoint, "symlink")
				var err error
				switch action {
				case "link":
					err = s.LinkSource(path, ids[0], ids[1])
				case "reverse":
					links, e := repo.ListRelationships()
					if e != nil {
						t.Fatal(e)
					}
					err = s.ReverseRelationship(path, links[0].ID)
				case "fanout":
					group, e := repo.DB.Exec(`INSERT INTO groups (name, kind) VALUES ('set', 'variant')`)
					if e != nil {
						t.Fatal(e)
					}
					groupID, e := group.LastInsertId()
					if e != nil {
						t.Fatal(e)
					}
					if _, e := repo.DB.Exec(`UPDATE images SET group_id = ? WHERE id IN (?, ?)`, groupID, ids[1], ids[2]); e != nil {
						t.Fatal(e)
					}
					err = s.LinkSourceToGroup(path, ids[0], groupID)
				}
				if err != nil {
					t.Fatal(err)
				}
				// Replay must not depend on the symlink target or any other media.
				if err := os.Remove(filepath.Join(path, fmt.Sprintf("%d.png.target", endpoint))); err != nil {
					t.Fatal(err)
				}
				mustUndo(t, u, path, false)
				mustUndo(t, u, path, true)
			})
		}
	}
}

func TestFanoutSkipsExistingEdgeWithUnavailableFile(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	group, err := repo.DB.Exec(`INSERT INTO groups (name, kind) VALUES ('set', 'variant')`)
	if err != nil {
		t.Fatal(err)
	}
	groupID, err := group.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET group_id = ? WHERE id IN (?, ?)`, groupID, ids[1], ids[2]); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	replaceGraphFile(t, path, 1, "directory")
	if err := s.LinkSourceToGroup(path, ids[0], groupID); err != nil {
		t.Fatalf("fan-out should skip existing edge: %v", err)
	}
	links, err := repo.ListRelationships()
	if err != nil || len(links) != 2 {
		t.Fatalf("fan-out links: %v (%v)", links, err)
	}
	// Neither undo nor redo of the new edge requires its media to remain valid.
	replaceGraphFile(t, path, 2, "directory")
	mustUndo(t, u, path, false)
	mustUndo(t, u, path, true)
	after, err := repo.ListRelationships()
	if err != nil || !reflect.DeepEqual(links, after) {
		t.Fatalf("fan-out replay: %v -> %v (%v)", links, after, err)
	}
}
