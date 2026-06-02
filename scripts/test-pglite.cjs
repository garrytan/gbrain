const { PGlite } = require('@electric-sql/pglite');
async function main() {
  try {
    const db = await new PGlite({ dataDir: '/tmp/test-pglite-data-' + Date.now() });
    const res = await db.query('SELECT version()');
    console.log('OK:', res.rows[0].version);
    await db.close();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
}
main();
