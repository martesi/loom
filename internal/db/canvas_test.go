package db

import (
	"database/sql"
	"testing"
)

func TestCanvasMigrationUsesMembership(t *testing.T) {
	c, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, name := range []string{"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql"} {
		b, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Exec(string(b)); err != nil {
			t.Fatal(err)
		}
	}
	_, err = c.Exec(`INSERT INTO boards (id,name) VALUES (1,'A'),(2,'B');
 INSERT INTO images(id,file_path,canvas_x,canvas_y) VALUES (1,'a',12,34),(2,'b',NULL,NULL),(3,'c',99,88);
 INSERT INTO board_images VALUES (1,1),(2,1),(2,2);`)
	if err != nil {
		t.Fatal(err)
	}
	b, err := migrationsFS.ReadFile("migrations/0004_repository_canvas.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(string(b)); err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct {
		id   int
		x, y sql.NullFloat64
	}{{1, sql.NullFloat64{Float64: 12, Valid: true}, sql.NullFloat64{Float64: 34, Valid: true}}, {2, sql.NullFloat64{Float64: 190, Valid: true}, sql.NullFloat64{Float64: 0, Valid: true}}, {3, sql.NullFloat64{}, sql.NullFloat64{}}} {
		var x, y sql.NullFloat64
		if err := c.QueryRow("SELECT canvas_x,canvas_y FROM images WHERE id = ?", want.id).Scan(&x, &y); err != nil {
			t.Fatal(err)
		}
		if x != want.x || y != want.y {
			t.Fatalf("asset %d: %v,%v", want.id, x, y)
		}
	}
	var n int
	if err := c.QueryRow("SELECT count(*) FROM sqlite_master WHERE name IN ('boards','board_images')").Scan(&n); err != nil || n != 0 {
		t.Fatalf("board tables remain: %d, %v", n, err)
	}
}

func TestFingerprintMigrationUpgradesExistingImages(t *testing.T) {
	c, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, name := range []string{"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql", "0004_repository_canvas.sql", "0005_trash_retention.sql"} {
		migration, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Exec(string(migration)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	if _, err := c.Exec(`INSERT INTO images (file_path, file_size, content_hash) VALUES ('old.png', 10, 'stat:10:1')`); err != nil {
		t.Fatal(err)
	}
	migration, err := migrationsFS.ReadFile("migrations/0006_image_fingerprint.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(string(migration)); err != nil {
		t.Fatalf("upgrade existing database: %v", err)
	}
	var fingerprint sql.NullString
	var revision int64
	if err := c.QueryRow(`SELECT source_fingerprint, source_revision FROM images WHERE file_path = 'old.png'`).Scan(&fingerprint, &revision); err != nil {
		t.Fatal(err)
	}
	if fingerprint.Valid || revision != 1 {
		t.Fatalf("upgraded fingerprint=%v revision=%d", fingerprint, revision)
	}
}
