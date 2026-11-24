package db

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestLayoutRevisionMigrationAndReopen(t *testing.T) {
	if path := os.Getenv("LOOM_LAYOUT_RESTART_DB"); path != "" {
		conn, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		var revision int64
		if err := conn.QueryRow(`SELECT revision FROM layout_revision`).Scan(&revision); err != nil || revision < 2 {
			t.Fatalf("fresh process revision %d: %v", revision, err)
		}
		if _, err := conn.Exec(`UPDATE images SET trashed = 0 WHERE id = 1`); err != nil {
			t.Fatal(err)
		}
		return
	}
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql", "0004_repository_canvas.sql", "0005_trash_retention.sql", "0006_image_fingerprint.sql", "0007_relationship_order.sql"} {
		migration, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.Exec(string(migration)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := legacy.Exec(`INSERT INTO schema_migrations VALUES (?)`, name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := legacy.Exec(`INSERT INTO images (id, file_path, canvas_x, canvas_y) VALUES (1, 'a', 3, 4), (2, 'b', NULL, NULL); INSERT INTO relationships (id, source_image_id, derived_image_id) VALUES (5, 1, 2)`); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	conn, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var revision, images, edges int64
	if err := conn.QueryRow(`SELECT revision, (SELECT count(*) FROM images), (SELECT count(*) FROM relationships) FROM layout_revision`).Scan(&revision, &images, &edges); err != nil || revision != 0 || images != 2 || edges != 1 {
		t.Fatalf("migration: %d %d %d %v", revision, images, edges, err)
	}
	if _, err := conn.Exec(`UPDATE relationships SET source_image_id = 2, derived_image_id = 1 WHERE id = 5`); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(`SELECT revision FROM layout_revision`).Scan(&revision); err != nil || revision == 0 {
		t.Fatalf("revision %d: %v", revision, err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	conn, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var reopened int64
	if err := conn.QueryRow(`SELECT revision FROM layout_revision`).Scan(&reopened); err != nil || reopened != revision {
		t.Fatalf("reopen %d, want %d: %v", reopened, revision, err)
	}
	if _, err := conn.Exec(`UPDATE images SET trashed = 1 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(`SELECT revision FROM layout_revision`).Scan(&reopened); err != nil || reopened <= revision {
		t.Fatalf("post-reopen %d: %v", reopened, err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestLayoutRevisionMigrationAndReopen$")
	child.Env = append(os.Environ(), "LOOM_LAYOUT_RESTART_DB="+path)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("fresh process: %v\n%s", err, output)
	}
	conn, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var restarted int64
	if err := conn.QueryRow(`SELECT revision FROM layout_revision`).Scan(&restarted); err != nil || restarted <= reopened {
		t.Fatalf("restart revision %d: %v", restarted, err)
	}
}
