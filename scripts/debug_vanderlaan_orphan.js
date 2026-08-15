import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

try {
  const db = await PGlite.create({
    dataDir: '/root/.gbrain/brain.pglite',
    extensions: { vector, pg_trgm }
  });

  const fromCount = await db.query("SELECT count(*) FROM links WHERE from_page_id = 251");
  const toCount = await db.query("SELECT count(*) FROM links WHERE to_page_id = 251");
  const isOrphan = await db.query(`
    SELECT id, slug FROM pages p
    WHERE id = 251
      AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)
  `);

  console.log("For page ID 251:");
  console.log("- from_page_id count in links:", fromCount.rows[0].count);
  console.log("- to_page_id count in links:", toCount.rows[0].count);
  console.log("- Is orphan according to exact query:", isOrphan.rows.length > 0);

  await db.close();
} catch (e) {
  console.error(e);
}
