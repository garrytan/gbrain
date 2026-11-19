/**
 * The pages `gitHeldFilesCheck` names as noncanonical private requests, in byte order on both SQL engines.
 *
 * 1. Contract: `details.visibility_noncanonical.stored` counts the live stored pages whose frontmatter asks for private in a spelling
 *    page privacy does not read, and the message names the first five of them ordered by (source id, slug) in byte order, the order
 *    PGLite (database collation C) and the Rust engine (string order) return. The fix names the first of them.
 * 2. Regression: `readNoncanonicalPrivate` (src/commands/doctor/checks/git-holds.ts) sorting with the database's default collation.
 *    On Postgres with en_US.utf8 punctuation is ignored at the first level, so 'notes/ab' sorts before 'notes/a-z' and source 'ab'
 *    before 'a-z', and the check names a different first page than the other two engines do.
 * 3. Existing coverage misses it: the doctor git-holds tests build a few pages whose slugs differ in letters, never in punctuation,
 *    and run on PGLite, whose collation is byte order, so no existing test sees a collation-dependent order.
 * 4. Seams: none. Pages and sources are inserted with `executeRaw`; the production check reads them back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) {
  describe(`git_held_files noncanonical private order (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      for (const id of ['ab', 'a-z']) await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1)`, [id]);
      // Each page asks for private under a key page privacy does not read.
      for (const [source, slug] of [['ab', 'notes/ab'], ['ab', 'notes/a-z'], ['a-z', 'notes/ab'], ['a-z', 'notes/a-z']]) {
        await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, frontmatter) VALUES ($1, $2, 'note', $2, $3::text::jsonb)`,
          [source, slug, JSON.stringify({ Visibility: 'private' })]);
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('names the first stored pages by source id then slug in byte order', async () => {
      const check = await gitHeldFilesCheck(engine);
      expect(check.details).toMatchObject({ visibility_noncanonical: { held: 0, stored: 4 } });
      expect(check.message).toContain('(first: a-z:notes/a-z, a-z:notes/ab, ab:notes/a-z, ab:notes/ab)');
      expect(check.fix).toMatchObject({ argv: ['gbrain', 'get', '--source', 'a-z', '--', 'notes/a-z'] });
    });
  });
}
