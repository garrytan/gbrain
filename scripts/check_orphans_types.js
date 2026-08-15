import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

try {
  const db = await PGlite.create({
    dataDir: '/root/.gbrain/brain.pglite',
    extensions: { vector, pg_trgm }
  });

  // Query pages of type 'person' or 'company' which are orphans
  const orphansRes = await db.query(`
    SELECT id, slug, title, type FROM pages p
    WHERE p.type IN ('person', 'company')
      AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)
  `);

  console.log("=== ORPHAN PEOPLE & COMPANIES ===");
  console.log(`Found ${orphansRes.rows.length} orphan entities.`);
  for (const row of orphansRes.rows) {
    console.log(`- [${row.type}] ${row.title} (slug: ${row.slug})`);
  }

  // Query count of all pages and all distinct timeline pages
  const statsRes = await db.query(`
    SELECT
      (SELECT count(*) FROM pages) as total_pages,
      (SELECT count(DISTINCT page_id) FROM timeline_entries) as pages_with_timeline
  `);
  console.log("\n=== TIMELINE COVERAGE STATS ===");
  const stats = statsRes.rows[0];
  console.log(`Total Pages: ${stats.total_pages}`);
  console.log(`Pages with Timeline: ${stats.pages_with_timeline}`);
  console.log(`Coverage Density: ${(stats.pages_with_timeline / stats.total_pages).toFixed(4)}`);

  await db.close();
} catch (e) {
  console.error("Error executing query:", e);
}
