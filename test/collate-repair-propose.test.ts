/**
 * The slug order `proposeVisibility` writes into each reader set's slugs file and lists as unmatched, in byte order on both SQL engines.
 *
 * 1. Contract: the pages read for a visibility proposal come back ordered by (source id, slug) in byte order, the order PGLite
 *    (database collation C) and the Rust engine (string order) return, so a slugs file lists its slugs in that order and the
 *    unmatched list follows it.
 * 2. Regression: the pages read in src/commands/repair-propose.ts sorting with the database's default collation. On Postgres with
 *    en_US.utf8 punctuation is ignored at the first level, so 'meetings/ab' sorts before 'meetings/a-z' and source 'ab' before
 *    'a-z': the slugs file, the preview and the unmatched list differ from the other two engines for the same brain.
 * 3. Existing coverage misses it: test/repair-visibility-propose-gst2670.test.ts uses slugs that differ in letters and digits
 *    (m1, m4, m5, e1, e2), never in punctuation, and its reads sort the same under every collation.
 * 4. Seams: none. Sources, members and pages come from the production helpers (addMember, setOwner, importFromContent) and the
 *    production `proposeVisibility` reads them back; the slugs files are read from disk.
 *
 * The engine-parity case below (PGLite, Postgres with DATABASE_URL, Rust with GBRAIN_TEST_RUST_ARM=1): the SQL arms propose
 * the same reader set, and the Rust engine, which has no raw SQL for the page read, refuses by name
 * (`engine_capability_missing`, raw_sql, "repair propose visibility") before any read and writes no file. Before the named
 * refusal a Rust brain answered "Nothing to propose" from its member read, so the proposal looked complete. The Rust arm
 * runs unseeded: addMember itself still refuses on Rust (the access members are not served there yet).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { proposeVisibility } from '../src/commands/repair-propose.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { parityArms } from './engine-parity/harness.ts';

const fm = (type: string, slug: string, extra: string) => `---\ntype: ${type}\ntitle: ${slug}\n${extra}---\n# ${slug}\n\nHarbor ledger body for ${slug}.\n`;
const SOURCES = ['ab', 'a-z'];
// Matched pages share one reader set per source; unmatched pages name an address no member declares.
const MATCHED = ['meetings/ab', 'meetings/a-z'];
const UNMATCHED = ['emails/ab', 'emails/a-z'];

for (const kind of testBackends()) {
  describe(`repair visibility --propose slug order (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let out: string;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      out = mkdtempSync(join(tmpdir(), 'gbrain-collate-propose-'));
      await addMember(engine, 'owner-example', { email: 'owner@example.com' });
      await addMember(engine, 'alice-example', { email: 'alice@example.com' });
      await setOwner(engine, 'owner-example');
      for (const source of SOURCES) {
        await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
        // Import in the reverse of byte order so the stored order cannot give the expected one.
        for (const slug of [...UNMATCHED, ...MATCHED].reverse()) {
          const extra = MATCHED.includes(slug) ? 'attendees: [alice@example.com]\n' : 'attendees: [stranger@example.com]\n';
          await importFromContent(engine, slug, fm(MATCHED.includes(slug) ? 'meeting' : 'email', slug, extra), { sourceId: source, noEmbed: true });
        }
      }
    }, 120_000);
    afterAll(async () => { await close?.(); rmSync(out, { recursive: true, force: true }); }, 60_000);

    test('each slugs file lists its slugs in byte order', async () => {
      const proposal = await proposeVisibility(engine, { out });
      expect(proposal.applicable).toBe(true);
      const bySource = Object.fromEntries(proposal.sets.map(set => [set.source, readFileSync(set.file, 'utf8')]));
      expect(bySource).toEqual({ 'a-z': 'meetings/a-z\nmeetings/ab\n', ab: 'meetings/a-z\nmeetings/ab\n' });
    }, 60_000);

    test('the unmatched list follows byte order of source id then slug', async () => {
      const proposal = await proposeVisibility(engine, { out });
      expect(proposal.unmatched.map(page => `${page.source}:${page.slug}`)).toEqual(['a-z:emails/a-z', 'a-z:emails/ab', 'ab:emails/a-z', 'ab:emails/ab']);
    }, 60_000);
  });
}

const { parityTest } = parityArms(testBackends());

describe('engine parity: repair visibility --propose', () => {
  parityTest('the SQL engines propose the same readers, and the Rust engine refuses the proposal by name', {
    methods: [],
    requires: 'raw_sql',
    timeout: 60_000,
  }, async (engine, backend) => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-propose-parity-'));
    const out = join(dir, 'out');
    try {
      return await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        if (backend !== 'rust') { // addMember refuses on Rust; the refusal under test comes first on any brain.
          await addMember(engine, 'owner-example', { email: 'owner@example.com' });
          await addMember(engine, 'alice-example', { email: 'alice@example.com' });
          await setOwner(engine, 'owner-example');
          await importFromContent(engine, 'meetings/m1', fm('meeting', 'meetings/m1', 'attendees: [alice@example.com]\n'), { sourceId: 'default', noEmbed: true });
          await importFromContent(engine, 'emails/e1', fm('email', 'emails/e1', 'attendees: [stranger@example.com]\n'), { sourceId: 'default', noEmbed: true });
        }
        try {
          const proposal = await proposeVisibility(engine, { out });
          return { applicable: proposal.applicable, owner: proposal.owner,
            sets: proposal.sets.map(set => ({ source: set.source, readers: set.readers, slugs: readFileSync(set.file, 'utf8') })),
            unmatched: proposal.unmatched.map(page => `${page.source}:${page.slug}`) };
        } catch (err) {
          if (backend === 'rust') {
            const text = JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });
            expect(text).toContain('repair propose visibility');
            expect(() => readdirSync(out)).toThrow();
          }
          throw err;
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
