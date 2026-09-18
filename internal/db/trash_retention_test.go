package db

import (
	"database/sql"
	"testing"
)

func TestTrashRetentionMigrationBackfillsExistingTrash(t *testing.T) {
	c, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, name := range []string{"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql", "0004_repository_canvas.sql"} {
		b, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Exec(string(b)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.Exec(`INSERT INTO images(id,file_path,trashed) VALUES (1,'active',0),(2,'trashed',1)`); err != nil {
		t.Fatal(err)
	}
	b, err := migrationsFS.ReadFile("migrations/0005_trash_retention.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(string(b)); err != nil {
		t.Fatal(err)
	}

	var active, trashed sql.NullString
	if err := c.QueryRow(`SELECT trashed_at FROM images WHERE id = 1`).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if err := c.QueryRow(`SELECT trashed_at FROM images WHERE id = 2`).Scan(&trashed); err != nil {
		t.Fatal(err)
	}
	if active.Valid {
		t.Fatalf("active asset got trash timestamp %q", active.String)
	}
	if !trashed.Valid || trashed.String == "" {
		t.Fatal("existing trashed asset did not receive upgrade grace timestamp")
	}
}
