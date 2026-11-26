package service

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestGraphMissingFilesRejectMutationsWithoutChangingRedo(t *testing.T) {
	for _, action := range []string{"link", "reverse"} {
		for _, missing := range []int{0, 1} {
			t.Run(fmt.Sprintf("%s/endpoint-%d", action, missing), func(t *testing.T) {
				path, repo, ids := graphFixture(t)
				s, u := &ImageService{}, &UndoService{}
				if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
					t.Fatal(err)
				}
				if err := s.LinkSource(path, ids[2], ids[3]); err != nil {
					t.Fatal(err)
				}
				mustUndo(t, u, path, false)
				before, err := repo.ListRelationships()
				if err != nil {
					t.Fatal(err)
				}
				cursor, err := repo.UndoCursor()
				if err != nil {
					t.Fatal(err)
				}
				redo, err := repo.PeekRedo()
				if err != nil || redo == nil {
					t.Fatalf("redo: %v %v", redo, err)
				}
				var logBefore string
				if err := repo.DB.QueryRow(`SELECT json_group_array(json_array(seq, kind, forward, inverse, created_at)) FROM (SELECT * FROM operation_log ORDER BY seq)`).Scan(&logBefore); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(filepath.Join(path, fmt.Sprintf("%d.png", missing))); err != nil {
					t.Fatal(err)
				}
				if action == "reverse" {
					err = s.ReverseRelationship(path, before[0].ID)
				} else if missing == 0 {
					err = s.LinkSource(path, ids[0], ids[2])
				} else {
					err = s.LinkSource(path, ids[2], ids[1])
				}
				if err == nil || !strings.Contains(err.Error(), "endpoint is unavailable") {
					t.Fatalf("expected unavailable endpoint, got %v", err)
				}
				after, err := repo.ListRelationships()
				if err != nil || !reflect.DeepEqual(before, after) {
					t.Fatalf("relationships changed: %v -> %v (%v)", before, after, err)
				}
				if got, err := repo.UndoCursor(); err != nil || got != cursor {
					t.Fatalf("cursor: %d -> %d (%v)", cursor, got, err)
				}
				gotRedo, err := repo.PeekRedo()
				if err != nil || !reflect.DeepEqual(redo, gotRedo) {
					t.Fatalf("redo changed: %v -> %v (%v)", redo, gotRedo, err)
				}
				var logAfter string
				if err := repo.DB.QueryRow(`SELECT json_group_array(json_array(seq, kind, forward, inverse, created_at)) FROM (SELECT * FROM operation_log ORDER BY seq)`).Scan(&logAfter); err != nil || logAfter != logBefore {
					t.Fatalf("history changed: %s -> %s (%v)", logBefore, logAfter, err)
				}
				mustUndo(t, u, path, true)
			})
		}
	}
}

func TestGraphReplayAllowsTemporarilyMissingFiles(t *testing.T) {
	for _, action := range []string{"insert", "delete", "reverse"} {
		t.Run(action, func(t *testing.T) {
			path, repo, ids := graphFixture(t)
			s, u := &ImageService{}, &UndoService{}
			if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
				t.Fatal(err)
			}
			original, err := repo.ListRelationships()
			if err != nil {
				t.Fatal(err)
			}
			switch action {
			case "delete":
				err = s.UnlinkSource(path, original[0].ID)
			case "reverse":
				err = s.ReverseRelationship(path, original[0].ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			forward, err := repo.ListRelationships()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(path, "0.png")); err != nil {
				t.Fatal(err)
			}
			mustUndo(t, u, path, false)
			undoState, err := repo.ListRelationships()
			if err != nil {
				t.Fatal(err)
			}
			if action == "insert" {
				original = nil
			}
			if len(undoState) != len(original) || (len(original) > 0 && !reflect.DeepEqual(undoState, original)) {
				t.Fatalf("undo snapshot: %v, want %v", undoState, original)
			}
			mustUndo(t, u, path, true)
			got, err := repo.ListRelationships()
			if err != nil || len(got) != len(forward) || (len(got) > 0 && !reflect.DeepEqual(got, forward)) {
				t.Fatalf("redo snapshot: %v, want %v (%v)", got, forward, err)
			}
		})
	}
}
