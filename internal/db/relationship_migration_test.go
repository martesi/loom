package db

import (
	"database/sql"
	"testing"
)

func TestRelationshipOrderMigrationPreservesLegacyData(t *testing.T) {
	c, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, name := range []string{"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql", "0004_repository_canvas.sql", "0005_trash_retention.sql", "0006_image_fingerprint.sql"} {
		migration, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Exec(string(migration)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	_, err = c.Exec(`INSERT INTO groups (id, name) VALUES (1, 'legacy');
		INSERT INTO images (id, file_path, group_id, canvas_x, canvas_y) VALUES (1, 'a', 1, 2, 3), (2, 'b', 1, NULL, NULL), (3, 'c', NULL, NULL, NULL);
		INSERT INTO relationships (id, source_image_id, derived_image_id) VALUES (9, 1, 2), (4, 1, 3);
		INSERT INTO operation_log (seq, kind, forward, inverse) VALUES (1, 'group_existence', '{}', '{}');`)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := migrationsFS.ReadFile("migrations/0007_relationship_order.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(string(migration)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{4, 9} {
		var order int64
		var created sql.NullString
		if err := c.QueryRow(`SELECT pairing_order, created_at FROM relationships WHERE id = ?`, id).Scan(&order, &created); err != nil {
			t.Fatal(err)
		}
		if order != id || created.Valid {
			t.Fatalf("id=%d order=%d timestamp=%v", id, order, created)
		}
	}
	var groups, images, history int
	if err := c.QueryRow(`SELECT (SELECT count(*) FROM groups), (SELECT count(*) FROM images), (SELECT count(*) FROM operation_log)`).Scan(&groups, &images, &history); err != nil {
		t.Fatal(err)
	}
	if groups != 1 || images != 3 || history != 1 {
		t.Fatalf("lost data: groups=%d images=%d history=%d", groups, images, history)
	}
	var floor string
	if err := c.QueryRow(`SELECT value FROM settings WHERE key = 'undo_history_floor'`).Scan(&floor); err != nil || floor != "1" {
		t.Fatalf("history floor=%q err=%v", floor, err)
	}
	if _, err := c.Exec(`UPDATE relationships SET pairing_order = 99 WHERE id = 4`); err == nil {
		t.Fatal("pairing order changed")
	}
	if _, err := c.Exec(`DELETE FROM relationships WHERE id = 9; INSERT INTO relationships(source_image_id, derived_image_id) VALUES (2, 3)`); err != nil {
		t.Fatal(err)
	}
	var id, order int64
	var created sql.NullString
	if err := c.QueryRow(`SELECT id, pairing_order, created_at FROM relationships WHERE source_image_id = 2`).Scan(&id, &order, &created); err != nil {
		t.Fatal(err)
	}
	if id <= 9 || order != id || !created.Valid {
		t.Fatalf("new edge id=%d order=%d created=%v", id, order, created)
	}
}
