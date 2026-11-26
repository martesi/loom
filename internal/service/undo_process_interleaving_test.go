package service

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"loom/internal/store"
)

// The helper is a separate process, with its own coordinator and session map.
func TestUndoProcessHelper(t *testing.T) {
	path := os.Getenv("LOOM_REPLAY_HELPER_PATH")
	if path == "" {
		return
	}
	u := &UndoService{}
	if _, err := u.State(path); err != nil {
		t.Fatal(err)
	}
	fmt.Println("READY")
	var direction string
	if _, err := fmt.Fscanln(os.Stdin, &direction); err != nil {
		t.Fatal(err)
	}
	fmt.Println("START")
	var result *UndoResult
	var err error
	if direction == "redo" {
		result, err = u.Redo(path)
	} else {
		result, err = u.Undo(path)
	}
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(string(data))
}

func TestReplayWaitsForIndependentWriter(t *testing.T) {
	for _, name := range []string{"undo-newest-graph", "undo-newest-geometry", "redo-after-branch", "redo-failure"} {
		t.Run(name, func(t *testing.T) {
			redo := name == "redo-after-branch" || name == "redo-failure"
			failRedo := name == "redo-failure"
			geometryLast := name == "undo-newest-geometry"
			path, repo, ids := graphFixture(t)
			cmd := exec.Command(os.Args[0], "-test.run=^TestUndoProcessHelper$")
			cmd.Env = append(os.Environ(), "LOOM_REPLAY_HELPER_PATH="+path)
			in, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			out, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			var stderr strings.Builder
			cmd.Stderr = &stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				in.Close()
				if cmd.ProcessState == nil {
					cmd.Process.Kill()
					cmd.Wait()
				}
			})
			scanner := bufio.NewScanner(out)
			readLine := func(want string) {
				t.Helper()
				if !scanner.Scan() || scanner.Text() != want {
					t.Fatalf("helper line = %q, want %q: %v", scanner.Text(), want, scanner.Err())
				}
			}
			readLine("READY")
			s, u := &ImageService{}, &UndoService{}
			if geometryLast {
				if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := s.SetGeometry(path, []GeometryUpdate{rect(ids[0], 1, 2, 3, 4)}); err != nil {
					t.Fatal(err)
				}
			}
			if redo {
				if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
					t.Fatal(err)
				}
				mustUndo(t, u, path, false)
			}
			tx, err := repo.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			var previousCursor int64
			if failRedo {
				if _, err := tx.Exec(`CREATE TRIGGER fail_graph_redo BEFORE INSERT ON relationships BEGIN SELECT RAISE(ABORT, 'forced graph redo failure'); END`); err != nil {
					t.Fatal(err)
				}
			} else if redo || geometryLast {
				g := rect(ids[1], 8, 9, 10, 11)
				if err := applyGeometryTx(tx, []GeometryUpdate{g}); err != nil {
					t.Fatal(err)
				}
				previousCursor, err = graphRecord(repo, tx, stepGeometry, step(stepGeometry, geometryPayload{[]GeometryUpdate{g}}), step(stepGeometry, geometryPayload{[]GeometryUpdate{{ImageID: ids[1]}}}))
				if err != nil {
					t.Fatal(err)
				}
			} else {
				res, err := tx.Exec(`INSERT INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, ids[0], ids[1])
				if err != nil {
					t.Fatal(err)
				}
				id, err := res.LastInsertId()
				if err != nil {
					t.Fatal(err)
				}
				r, err := relationshipTx(tx, id)
				if err != nil {
					t.Fatal(err)
				}
				p := graphPayload{Relationships: []store.Relationship{r}}
				previousCursor, err = graphRecord(repo, tx, stepGraphInsert, step(stepGraphInsert, p), step(stepGraphDelete, p))
				if err != nil {
					t.Fatal(err)
				}
			}
			direction := "undo"
			if redo {
				direction = "redo"
			}
			if _, err := fmt.Fprintln(in, direction); err != nil {
				t.Fatal(err)
			}
			readLine("START")
			line := make(chan string, 1)
			go func() {
				if scanner.Scan() {
					line <- scanner.Text()
				} else {
					line <- ""
				}
			}()
			select {
			case result := <-line:
				t.Fatalf("replay returned while writer held lock: %q", result)
			case <-time.After(150 * time.Millisecond):
			}
			if err := repo.CommitOperation(tx, previousCursor); err != nil {
				t.Fatal(err)
			}
			var result UndoResult
			select {
			case data := <-line:
				if err := json.Unmarshal([]byte(data), &result); err != nil {
					t.Fatalf("helper result %q: %v", data, err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("replay remained blocked after commit")
			}
			if err := cmd.Wait(); err != nil {
				t.Fatalf("helper: %v, stderr %s", err, stderr.String())
			}
			if redo && result.Applied || !redo && (!result.Applied || geometryLast && result.Kind != stepGeometry || !geometryLast && result.Kind != stepGraphInsert) {
				t.Fatalf("replay result = %+v", result)
			}
			if failRedo && (!strings.Contains(result.Error, "forced graph redo failure") || result.Kind != stepGraphInsert) {
				t.Fatalf("failed redo result = %+v", result)
			}
			if geometryLast && (len(result.Geometry) != 1 || result.Geometry[0].ImageID != ids[1] || result.Geometry[0].X != nil || result.Geometry[0].W != nil) {
				t.Fatalf("geometry replay result = %+v", result.Geometry)
			}
			cursor, err := repo.UndoCursor()
			if err != nil || (redo && !failRedo && cursor != 2) || ((!redo || failRedo) && cursor != 1) {
				t.Fatalf("cursor = %d, %v", cursor, err)
			}
			if failRedo {
				pending, err := repo.PeekRedo()
				if err != nil || pending == nil || pending.Kind != stepGraphInsert {
					t.Fatalf("failed redo lost its history: %+v, %v", pending, err)
				}
			}
			var edges int
			wantEdges := 0
			if geometryLast {
				wantEdges = 1
			}
			if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&edges); err != nil || edges != wantEdges {
				t.Fatalf("edges = %d, %v", edges, err)
			}
			if !geometryLast {
				var x float64
				if err := repo.DB.QueryRow(`SELECT canvas_x FROM images WHERE id = ?`, ids[0]).Scan(&x); err != nil || x != 1 {
					t.Fatalf("geometry = %v, %v", x, err)
				}
			}
		})
	}
}
