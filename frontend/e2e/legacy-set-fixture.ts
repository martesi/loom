import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const legacyNames = [
  'group-alpha.png',
  'group-beta.png',
  'group-gamma.png',
]

// Create a persisted pre-0009 repository before the upgraded app opens it.
export async function seedLegacySet(repo: string) {
  const dir = path.join(repo, '.loom')
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'db.sqlite'))
  db.exec(
    'PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)'
  )
  const migrations = [
    '0001_init.sql',
    '0002_operation_log.sql',
    '0003_canvas_size.sql',
    '0004_repository_canvas.sql',
    '0005_trash_retention.sql',
    '0006_image_fingerprint.sql',
    '0007_relationship_order.sql',
    '0008_layout_revision.sql',
  ]
  for (const name of migrations) {
    db.exec(
      await readFile(
        path.resolve(import.meta.dirname, '../../internal/db/migrations', name),
        'utf8'
      )
    )
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name)
  }
  db.exec(`
    INSERT INTO prompts(id,prompt_hash,text,negative) VALUES (5,'hash','legacy prompt','legacy negative');
    INSERT INTO tags(id,name) VALUES (7,'legacy tag');
    INSERT INTO groups(id,name,kind) VALUES (11,'Legacy pair','variant');
    INSERT INTO images(id,file_path,prompt_id,group_id,canvas_x,canvas_y,width,height)
      VALUES (1,'placeholder1',5,11,80,100,1,1), (2,'placeholder2',5,11,300,100,1,1), (3,'placeholder3',NULL,NULL,520,100,1,1);
    UPDATE groups SET cover_image_id=1 WHERE id=11;
    INSERT INTO image_tags VALUES (1,7);
    INSERT INTO relationships(id,source_image_id,derived_image_id,pairing_order,created_at) VALUES (8,1,2,8,'old'),(10,1,3,10,'old');
    INSERT INTO operation_log(seq,kind,forward,inverse,created_at) VALUES
      (1,'group_existence','{"kind":"group_existence","payload":{}}','{"kind":"group_existence","payload":{}}','old'),
      (2,'group_member_add','{"kind":"group_member_add","payload":{}}','{"kind":"group_member_remove","payload":{}}','old'),
      (3,'link','{"kind":"link","payload":{"sourceId":2,"derivedId":3}}','{"kind":"unlink","payload":{"sourceId":2,"derivedId":3}}','old');
    INSERT INTO settings(scope,key,value) VALUES ('repo','undo_cursor','1');
  `)
  for (const [index, name] of legacyNames.entries()) {
    const filePath = path.join(repo, name)
    const info = await stat(filePath, { bigint: true })
    db.prepare(
      'UPDATE images SET file_path=?,file_size=?,content_hash=? WHERE id=?'
    ).run(filePath, info.size, `stat:${info.size}:${info.mtimeNs}`, index + 1)
  }
  db.close()
}
