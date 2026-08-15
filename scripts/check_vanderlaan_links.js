import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

try {
  const db = await PGlite.create({
    dataDir: '/root/.gbrain/brain.pglite',
    extensions: { vector, pg_trgm }
  });

  const pageRes = await db.query(`
    SELECT id, slug, deleted_at, title, type FROM pages WHERE slug LIKE '%vanderlaan_vasey_2009_coercion%'
  `);

  console.log(`Found ${pageRes.rows.length} rows matching '%vanderlaan_vasey_2009_coercion%':`);
  for (const row of pageRes.rows) {
    console.log(`- ID: ${row.id}, Slug: '${row.slug}', Deleted At: ${row.deleted_at}, Title: ${row.title}, Type: ${row.type}`);
  }

  await db.close();
} catch (e) {
  console.error(e);
}
