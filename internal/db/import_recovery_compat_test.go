package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestImportRecoveryPreservesLegacyRetainedRowsAsUntrusted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	base := []string{
		"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql",
		"0004_repository_canvas.sql", "0005_trash_retention.sql", "0006_image_fingerprint.sql",
		"0007_relationship_order.sql",
	}
	for _, name := range base {
		applyMigrationFixture(t, conn, name)
	}
	if _, err := conn.Exec(`ALTER TABLE images ADD COLUMN history_retained INTEGER NOT NULL DEFAULT 0`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO images(file_path,history_retained) VALUES ('legacy-hidden.png',1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO schema_migrations(version) VALUES ('0008_import_retention.sql')`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(conn); err != nil {
		t.Fatalf("migrate legacy import-retention schema: %v", err)
	}
	var pathOnRecord, fingerprint string
	var retained, trusted int
	if err := conn.QueryRow(`SELECT file_path,fingerprint,retained,trusted FROM import_recovery`).Scan(&pathOnRecord, &fingerprint, &retained, &trusted); err != nil {
		t.Fatal(err)
	}
	if pathOnRecord != "legacy-hidden.png" || fingerprint != "" || retained != 1 || trusted != 0 {
		t.Fatalf("legacy recovery evidence was fabricated or lost: %q %q retained=%d trusted=%d", pathOnRecord, fingerprint, retained, trusted)
	}
	var hidden int
	if err := conn.QueryRow(`SELECT history_retained FROM images WHERE file_path=?`, pathOnRecord).Scan(&hidden); err != nil || hidden != 1 {
		t.Fatalf("legacy retained marker changed: hidden=%d err=%v", hidden, err)
	}
}

func TestImportRecoveryTrustMigrationPreservesExistingEvidence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prior-import-schema.sqlite")
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql",
		"0004_repository_canvas.sql", "0005_trash_retention.sql", "0006_image_fingerprint.sql",
		"0007_relationship_order.sql", "0008_layout_revision.sql", "0009_retire_sets.sql",
		"0011_import_recovery.sql", "0012_import_intents.sql",
	} {
		applyMigrationFixture(t, conn, name)
	}
	if _, err := conn.Exec(`INSERT INTO images(file_path,source_fingerprint,source_revision) VALUES ('kept.png','digest',1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO import_recovery(image_id,file_path,fingerprint,retained) VALUES (1,'kept.png','digest',1)`); err != nil {
		t.Fatal(err)
	}
	var before int64
	if err := conn.QueryRow(`SELECT revision FROM layout_revision WHERE singleton=1`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(conn); err != nil {
		t.Fatal(err)
	}
	var fingerprint string
	var retained, trusted int
	if err := conn.QueryRow(`SELECT fingerprint,retained,trusted FROM import_recovery WHERE image_id=1`).Scan(&fingerprint, &retained, &trusted); err != nil {
		t.Fatal(err)
	}
	var after int64
	if err := conn.QueryRow(`SELECT revision FROM layout_revision WHERE singleton=1`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if fingerprint != "digest" || retained != 1 || trusted != 1 || after <= before {
		t.Fatalf("migration lost or mistrusted existing recovery: fingerprint=%q retained=%d trusted=%d revision=%d->%d", fingerprint, retained, trusted, before, after)
	}
}

func applyMigrationFixture(t *testing.T, conn *sql.DB, name string) {
	t.Helper()
	content, err := migrationsFS.ReadFile("migrations/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(string(content)); err != nil {
		t.Fatalf("apply fixture migration %s: %v", name, err)
	}
	if _, err := conn.Exec(`INSERT INTO schema_migrations(version) VALUES (?)`, name); err != nil {
		t.Fatal(err)
	}
}
