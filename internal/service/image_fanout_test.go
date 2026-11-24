package service

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestLinkSourceToGroupValidationAndDuplicates(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	addImage := func(name string) int64 {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repoPath, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, filepath.Join(repoPath, name))
		if err != nil {
			t.Fatal(err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	source, one, two := addImage("source.png"), addImage("one.png"), addImage("two.png")
	res, err := repo.DB.Exec(`INSERT INTO groups (name, kind) VALUES ('set', 'variant')`)
	if err != nil {
		t.Fatal(err)
	}
	groupID, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET group_id = ? WHERE id IN (?, ?)`, groupID, one, two); err != nil {
		t.Fatal(err)
	}
	svc := &ImageService{}
	count := func() int {
		t.Helper()
		var n int
		if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM relationships`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// A cycle on a later target must not leave the valid earlier edge behind.
	if _, err := repo.DB.Exec(`INSERT INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, one, source); err != nil {
		t.Fatal(err)
	}
	if err := svc.linkSourceToGroup(repoPath, source, groupID); err == nil {
		t.Fatal("expected cycle validation to reject the fan-out")
	}
	if got := count(); got != 1 {
		t.Fatalf("invalid fan-out partially inserted edges: count=%d", got)
	}
	if _, err := repo.DB.Exec(`DELETE FROM relationships`); err != nil {
		t.Fatal(err)
	}

	// Membership containing its source is rejected, not silently skipped.
	if _, err := repo.DB.Exec(`UPDATE images SET group_id = ? WHERE id = ?`, groupID, source); err != nil {
		t.Fatal(err)
	}
	if err := svc.linkSourceToGroup(repoPath, source, groupID); err == nil {
		t.Fatal("expected source-in-set rejection")
	}
	if got := count(); got != 0 {
		t.Fatalf("source-in-set inserted edges: count=%d", got)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET group_id = NULL WHERE id = ?`, source); err != nil {
		t.Fatal(err)
	}

	// Existing edges remain intact and are excluded; new edges are added once.
	if _, err := repo.DB.Exec(`INSERT INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, source, one); err != nil {
		t.Fatal(err)
	}
	if err := svc.linkSourceToGroup(repoPath, source, groupID); err != nil {
		t.Fatalf("valid mixed fan-out: %v", err)
	}
	if got := count(); got != 2 {
		t.Fatalf("mixed fan-out relationship count=%d, want 2", got)
	}
	if _, err := repo.DB.Exec(`DELETE FROM relationships`); err != nil {
		t.Fatal(err)
	}
	if err := svc.linkSourceToGroup(repoPath, source, groupID); err != nil {
		t.Fatal(err)
	}
	before, err := repo.ListRelationships()
	if err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	if result, err := undo.Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo fan-out: result=%+v err=%v", result, err)
	}
	if got := count(); got != 0 {
		t.Fatalf("undo left fan-out edges: count=%d, want 0", got)
	}
	if result, err := undo.Redo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("redo fan-out: result=%+v err=%v", result, err)
	}
	if got := count(); got != 2 {
		t.Fatalf("redo restored %d fan-out edges, want 2", got)
	}
	after, err := repo.ListRelationships()
	if err != nil {
		t.Fatal(err)
	}
	for i := range before {
		if before[i].ID != after[i].ID || before[i].PairingOrder != after[i].PairingOrder {
			t.Fatalf("fan-out identity changed: %v -> %v", before, after)
		}
	}
}

func TestLinkSourceToGroupRollsBackWhenOperationLogFails(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	addImage := func(name string) int64 {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repoPath, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, filepath.Join(repoPath, name))
		if err != nil {
			t.Fatal(err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	source, member := addImage("source.png"), addImage("member.png")
	res, err := repo.DB.Exec(`INSERT INTO groups (name, kind) VALUES ('set', 'variant')`)
	if err != nil {
		t.Fatal(err)
	}
	groupID, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET group_id = ? WHERE id = ?`, groupID, member); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_operation_log BEFORE INSERT ON operation_log BEGIN SELECT RAISE(ABORT, 'forced operation-log failure'); END`); err != nil {
		t.Fatal(err)
	}
	repo.Close()

	if err := (&ImageService{}).linkSourceToGroup(repoPath, source, groupID); err == nil {
		t.Fatal("expected operation-log failure")
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var links, operations int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM relationships`).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if links != 0 || operations != 0 {
		t.Fatalf("failed history write left links=%d operations=%d", links, operations)
	}
}

func TestBatchRelationshipReplayRollsBackOnPartialFailure(t *testing.T) {
	for _, direction := range []string{"undo", "redo"} {
		t.Run(direction, func(t *testing.T) {
			repoPath := t.TempDir()
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			addImage := func(name string) int64 {
				t.Helper()
				if err := os.WriteFile(filepath.Join(repoPath, name), []byte("fixture"), 0600); err != nil {
					t.Fatal(err)
				}
				res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, filepath.Join(repoPath, name))
				if err != nil {
					t.Fatal(err)
				}
				id, err := res.LastInsertId()
				if err != nil {
					t.Fatal(err)
				}
				return id
			}
			source, one, two := addImage("source.png"), addImage("one.png"), addImage("two.png")
			res, err := repo.DB.Exec(`INSERT INTO groups (name, kind) VALUES ('set', 'variant')`)
			if err != nil {
				t.Fatal(err)
			}
			groupID, err := res.LastInsertId()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := repo.DB.Exec(`UPDATE images SET group_id = ? WHERE id IN (?, ?)`, groupID, one, two); err != nil {
				t.Fatal(err)
			}
			repo.Close()
			if err := (&ImageService{}).linkSourceToGroup(repoPath, source, groupID); err != nil {
				t.Fatal(err)
			}
			if direction == "redo" {
				if result, err := (&UndoService{}).Undo(repoPath); err != nil || result == nil || !result.Applied {
					t.Fatalf("prepare redo: result=%+v err=%v", result, err)
				}
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			trigger := `CREATE TRIGGER fail_second_link BEFORE `
			if direction == "undo" {
				trigger += `DELETE ON relationships WHEN OLD.derived_image_id = ` + fmt.Sprint(two)
			} else {
				trigger += `INSERT ON relationships WHEN NEW.derived_image_id = ` + fmt.Sprint(two)
			}
			trigger += ` BEGIN SELECT RAISE(ABORT, 'forced partial replay failure'); END`
			if _, err := repo.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			before, err := repo.UndoCursor()
			if err != nil {
				t.Fatal(err)
			}
			repo.Close()
			var result *UndoResult
			if direction == "undo" {
				result, err = (&UndoService{}).Undo(repoPath)
			} else {
				result, err = (&UndoService{}).Redo(repoPath)
			}
			if err != nil || result == nil || result.Applied || result.Error == "" {
				t.Fatalf("expected failed %s: result=%+v err=%v", direction, result, err)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			var links int
			if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM relationships`).Scan(&links); err != nil {
				t.Fatal(err)
			}
			after, err := repo.UndoCursor()
			if err != nil {
				t.Fatal(err)
			}
			wantLinks := 2
			if direction == "redo" {
				wantLinks = 0
			}
			if links != wantLinks || after != before {
				t.Fatalf("failed %s left links=%d cursor=%d, want links=%d cursor=%d", direction, links, after, wantLinks, before)
			}
		})
	}
}
