package service

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestSetRetirementPersistedHistory(t *testing.T) {
	path := t.TempDir()
	loomDir := filepath.Join(path, ".loom")
	if err := os.MkdirAll(loomDir, 0755); err != nil {
		t.Fatal(err)
	}
	c, err := sql.Open("sqlite", filepath.Join(loomDir, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(`PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_init.sql", "0002_operation_log.sql", "0003_canvas_size.sql", "0004_repository_canvas.sql", "0005_trash_retention.sql", "0006_image_fingerprint.sql", "0007_relationship_order.sql", "0008_layout_revision.sql"} {
		migration, err := os.ReadFile(filepath.Join("..", "db", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Exec(string(migration)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := c.Exec(`INSERT INTO schema_migrations VALUES (?)`, name); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"a.png", "b.png", "c.png", "d.png"} {
		if err := os.WriteFile(filepath.Join(path, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	_, err = c.Exec(`INSERT INTO prompts(id,prompt_hash,text,negative) VALUES (5,'hash','prompt','negative');
		INSERT INTO tags(id,name) VALUES (7,'tag');
		INSERT INTO groups(id,name,kind) VALUES (11,'collapsed','variants');
		INSERT INTO groups(id,name) VALUES (99,'deleted'); DELETE FROM groups WHERE id=99;
		INSERT INTO images(id,file_path,prompt_id,group_id,canvas_x,canvas_y) VALUES
		 (1,'a.png',5,NULL,10,20),(2,'b.png',5,11,30,40),(3,'c.png',NULL,11,NULL,NULL),(4,'d.png',NULL,NULL,50,60);
		UPDATE images SET width=100,height=200,file_size=42,content_hash='digest' WHERE id=2;
		INSERT INTO images(id,file_path) VALUES (90,'deleted'); DELETE FROM images WHERE id=90;
		UPDATE groups SET cover_image_id=3 WHERE id=11;
		INSERT INTO image_tags VALUES (2,7);
		INSERT INTO relationships(id,source_image_id,derived_image_id,pairing_order,created_at) VALUES (8,1,2,8,'old'),(10,1,3,10,'old');
		INSERT INTO relationships(id,source_image_id,derived_image_id,pairing_order) VALUES (100,2,4,100);
		DELETE FROM relationships WHERE id=100;
		INSERT INTO operation_log(seq,kind,forward,inverse) VALUES
		 (1,'group_existence','{"kind":"group_existence","payload":{"groupId":11,"exists":true}}','{"kind":"group_existence","payload":{"groupId":11,"exists":false}}'),
		 (2,'group_member_add','{"kind":"group_member_add","payload":{"groupId":11,"imageId":4}}','{"kind":"group_member_remove","payload":{"groupId":11,"imageId":4}}');
		INSERT INTO settings(scope,key,value) VALUES ('repo','undo_cursor','1') ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value;`)
	if err != nil {
		t.Fatal(err)
	}
	for id, name := range []string{"a.png", "b.png", "c.png", "d.png"} {
		if _, err := c.Exec(`UPDATE images SET file_path=? WHERE id=?`, filepath.Join(path, name), id+1); err != nil {
			t.Fatal(err)
		}
	}
	var originalHistory string
	if err := c.QueryRow(`SELECT json_group_array(json_array(seq,kind,forward,inverse,created_at)) FROM (SELECT * FROM operation_log ORDER BY seq)`).Scan(&originalHistory); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	checks := []struct{ query, want string }{
		{`SELECT count(*) FROM groups`, "0"},
		{`SELECT count(*) FROM images WHERE group_id IS NOT NULL`, "0"},
		{`SELECT group_concat(id||':'||coalesce(canvas_x,'null')||':'||coalesce(canvas_y,'null'),'|') FROM (SELECT * FROM images ORDER BY id)`, "1:10.0:20.0|2:30.0:40.0|3:null:null|4:50.0:60.0"},
		{`SELECT group_concat(id||':'||source_image_id||':'||derived_image_id||':'||pairing_order||':'||created_at,'|') FROM (SELECT * FROM relationships ORDER BY id)`, "8:1:2:8:old|10:1:3:10:old"},
		{`SELECT group_concat(image_id||':'||group_id,'|') FROM (SELECT * FROM retired_set_members ORDER BY image_id)`, "2:11|3:11"},
		{`SELECT name||':'||kind||':'||cover_image_id FROM retired_sets`, "collapsed:variants:3"},
		{`SELECT group_concat(seq||':'||kind,'|') FROM (SELECT * FROM retired_operation_log ORDER BY seq)`, "1:group_existence|2:group_member_add"},
		{`SELECT value FROM retired_history_settings WHERE key='undo_cursor'`, "1"},
		{`SELECT width||':'||height||':'||file_size||':'||content_hash||':'||prompt_id FROM images WHERE id=2`, "100:200:42:digest:5"},
		{`SELECT group_concat(name||':'||seq,'|') FROM (SELECT name,seq FROM sqlite_sequence WHERE name IN ('images','groups','relationships') ORDER BY name)`, "groups:99|images:90|relationships:100"},
		{`SELECT text||':'||negative FROM prompts WHERE id=5`, "prompt:negative"},
		{`SELECT name FROM tags JOIN image_tags ON tags.id=image_tags.tag_id WHERE image_id=2`, "tag"},
		{`PRAGMA integrity_check`, "ok"},
	}
	for _, name := range []string{"a.png", "b.png", "c.png", "d.png"} {
		data, err := os.ReadFile(filepath.Join(path, name))
		if err != nil || string(data) != name {
			t.Fatalf("media %s changed: %q %v", name, data, err)
		}
	}
	for _, check := range checks {
		var got string
		if err := r.DB.QueryRow(check.query).Scan(&got); err != nil || got != check.want {
			t.Fatalf("%s: got %q want %q: %v", check.query, got, check.want, err)
		}
	}
	rows, err := r.DB.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	if rows.Next() {
		t.Fatal("foreign key violation")
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	u := &UndoService{}
	for _, redo := range []bool{false, true} {
		var result *UndoResult
		if redo {
			result, err = u.Redo(path)
		} else {
			result, err = u.Undo(path)
		}
		if err != nil || result.Applied {
			t.Fatalf("legacy replay: %+v %v", result, err)
		}
	}
	if err := (&ImageService{}).LinkSource(path, 2, 4); err != nil {
		t.Fatal(err)
	}
	var id, order int64
	if err := r.DB.QueryRow(`SELECT id,pairing_order FROM relationships WHERE source_image_id=2 AND derived_image_id=4`).Scan(&id, &order); err != nil || id <= 100 || id != order {
		t.Fatalf("relationship high-water: %d %d %v", id, order, err)
	}
	mustUndo(t, u, path, false)
	blocked, err := u.Undo(path)
	if err != nil || blocked.Applied {
		t.Fatalf("legacy undo after branching: %+v %v", blocked, err)
	}
	mustUndo(t, u, path, true)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	r, err = store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var archived, linked int
	if err := r.DB.QueryRow(`SELECT (SELECT count(*) FROM retired_operation_log), (SELECT count(*) FROM relationships WHERE id=?)`, id).Scan(&archived, &linked); err != nil || archived != 2 || linked != 1 {
		t.Fatalf("reopen: archive=%d linked=%d err=%v", archived, linked, err)
	}
	var archivedHistory string
	if err := r.DB.QueryRow(`SELECT json_group_array(json_array(seq,kind,forward,inverse,created_at)) FROM (SELECT * FROM retired_operation_log ORDER BY seq)`).Scan(&archivedHistory); err != nil || archivedHistory != originalHistory {
		t.Fatalf("archived history changed: %q != %q: %v", archivedHistory, originalHistory, err)
	}
	mustUndo(t, u, path, false)
	mustUndo(t, u, path, true)
	var remainingGroups, remainingEdges int
	if err := r.DB.QueryRow(`SELECT (SELECT count(*) FROM groups), (SELECT count(*) FROM relationships WHERE (id=8 AND pairing_order=8) OR (id=10 AND pairing_order=10) OR (id=? AND pairing_order=?))`, id, order).Scan(&remainingGroups, &remainingEdges); err != nil || remainingGroups != 0 || remainingEdges != 3 {
		t.Fatalf("replay changed legacy data: groups=%d edges=%d err=%v", remainingGroups, remainingEdges, err)
	}
}
