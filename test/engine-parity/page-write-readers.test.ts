/**
 * BrainEngine parity: the put_page write guard for the readers key.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: put_page, run through the real operation handler on each engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), refuses content whose frontmatter names its
 *    readers with a key that is not exactly `readable_by` (`Readable_By: [alice-example]`) with the code
 *    `readers_noncanonical`, and the page does not exist afterward. The exact key still stores the page.
 *  - Regression: an engine or a write path that lets the misspelled key through stores a page every member can
 *    read while its author believes it is restricted (page access reads only the exact key).
 *  - Why existing coverage misses it: the cases in this directory call typed engine members; none runs the write
 *    guard in page-prepare.ts, which is shared TypeScript that every engine's put_page goes through.
 *  - Seam: the put_page operation handler over the arm's engine. The write path still reads and writes through raw
 *    SQL, so the case requires `raw_sql`; an engine without it stops on the typed refusal before the guard.
 *    The Rust arm is such an engine today: its first write (the `exact` page) stops on `engine_capability_missing`
 *    (raw_sql), the harness counts that as a stop, and the guard itself is reached only on the SQL arms until the
 *    Rust engine serves the write path.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';
import { createSource, parityArms } from './harness.ts';
import type { ParityBackend } from './harness.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const putPage = operations.find((op) => op.name === 'put_page')!;
const page = (extra: string) => `---\ntitle: Example\ntype: note\n${extra}---\nA page about acme-example.\n`;

describe('engine parity: put_page readers key guard', () => {
  parityTest('put_page refuses a misspelled readable_by key as readers_noncanonical and stores nothing; the exact key still stores', {
    methods: ['getPage'], requires: 'raw_sql',
  }, async (engine) => {
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const put = (slug: string, content: string) => (putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, unknown>>)
      .then((result) => ({ code: null as string | null, status: String(result.status) }), (e: { code?: string }) => {
        // An engine without raw SQL stops on its typed refusal; the harness reads that as the arm's outcome, so it must reach it.
        if (e.code === 'engine_capability_missing') throw e;
        return { code: e.code ?? null, status: 'refused' };
      });
    try {
      const outcomes: Record<string, { code: string | null; status: string }> = {
        exact: await put('notes/exact', page('readable_by: [alice-example]\n')),
        cased: await put('notes/cased', page('Readable_By: [alice-example]\n')),
        hyphen: await put('notes/hyphen', page('readable-by: [alice-example]\n')),
        camel: await put('notes/camel', page('readableBy: [alice-example]\n')),
        both: await put('notes/both', page('readable_by: [alice-example]\nREADABLE_BY: [bob-example]\n')),
      };
      const stored: Record<string, boolean> = {};
      for (const slug of ['exact', 'cased', 'hyphen', 'camel', 'both']) stored[slug] = (await engine.getPage(`notes/${slug}`)) !== null;
      expect(outcomes.exact!.code).toBeNull();
      for (const key of ['cased', 'hyphen', 'camel', 'both']) expect({ key, code: outcomes[key]!.code }).toEqual({ key, code: 'readers_noncanonical' });
      expect(stored).toEqual({ exact: true, cased: false, hyphen: false, camel: false, both: false });
      return { outcomes, stored };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  });
});

/**
 * A shared skillpack registered for a source reserves `skills/...` and `skillpack.json` in it: a knowledge put there is
 * refused with `skill_bundle_required` (shared-skills/knowledge-guard.ts) before anything is written. The pack row is
 * seeded per arm: SQL into shared_skill_packs, and on Rust through the store's own publication calls (activation needs a
 * source with a local path, so the case registers one).
 */
/** Registers a shared skillpack for source `default` (rooted at `root`) the way each arm stores one. */
async function seedSharedSkillPack(engine: BrainEngine, backend: ParityBackend, root: string): Promise<void> {
  await createSource(engine, backend, 'pack-root', {}, root);
  const incarnation = (await engine.readSourceState('default'))!.incarnation;
  const pack = { sourceId: 'default', incarnation, packId: 'pack-a', revision: randomUUID(), manifest: { skills: [] }, manifestHash: 'h' };
  if (backend === 'rust') {
    const { brain } = (engine as unknown as RustEngine).openStore('writeSharedSkillPack') as unknown as { brain: {
      activateSharedSkillPublication(dryRun: boolean): Promise<unknown>; writeSharedSkillPack(write: typeof pack): Promise<null> } };
    await brain.activateSharedSkillPublication(false);
    await brain.writeSharedSkillPack(pack);
  } else {
    // The row as an adopted pack leaves it; the publication trigger (which wants protocol 2) is off for the seed only.
    await engine.transaction(async (tx) => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      await tx.executeRaw('INSERT INTO shared_skill_packs (source_id,source_incarnation,pack_id,revision,manifest,manifest_hash) VALUES ($1,$2::uuid,$3,$4::uuid,$5::jsonb,$6)',
        [pack.sourceId, pack.incarnation, pack.packId, pack.revision, JSON.stringify(pack.manifest), pack.manifestHash]);
    });
  }
}

describe('engine parity: put_page shared skillpack guard', () => {
  parityTest('put_page of a reserved skills/ page in a source with a shared skillpack is refused and stores nothing', {
    methods: ['getPage', 'readSourceState'],
  }, async (engine, backend) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pack-guard-'));
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    try {
      await seedSharedSkillPack(engine, backend, root);
      const content = '---\ntitle: Planted\ntype: note\n---\nPlanted skill text.\n';
      const outcome = await (putPage.handler(ctx, { slug: 'skills/planted/skill', content, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, unknown>>)
        .then((result) => ({ code: null as string | null, status: String(result.status) }), (e: { code?: string }) => {
          if (e.code === 'engine_capability_missing') throw e;
          return { code: e.code ?? null, status: 'refused' };
        });
      const stored = (await engine.getPage('skills/planted/skill')) !== null;
      expect({ outcome, stored }).toEqual({ outcome: { code: 'skill_bundle_required', status: 'refused' }, stored: false });
      return { outcome, stored };
    } finally {
      await disposePersistenceConsumer(engine);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The guard screens an ordinary page too: it reads where the page's file lives (source_path, source_uri) to check the
  // file is outside every pack root. On every arm that read is served, so a create and a rewrite of the page both land.
  parityTest('put_page of an ordinary page in a source with a shared skillpack commits, a create and a rewrite', {
    methods: ['getPage', 'readSourceState', 'readPageOrigin'],
  }, async (engine, backend) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pack-guard-'));
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    try {
      await seedSharedSkillPack(engine, backend, root);
      let revision: string | undefined;
      const put = (line: string) => (putPage.handler(ctx, { slug: 'notes/ordinary', content: `---\ntitle: Ordinary\ntype: note\n---\n${line}\n`,
        request_id: randomUUID(), wait_ms: 25_000, ...(revision ? { expected_revision: revision } : {}) }) as Promise<Record<string, unknown>>)
        .then((result) => { revision = String(result.revision); return { code: null as string | null, status: String(result.status) }; },
          (e: { code?: string }) => ({ code: e.code ?? null, status: 'refused' }));
      const outcomes = [await put('An ordinary note.'), await put('An ordinary note, rewritten.')];
      const body = (await engine.getPage('notes/ordinary'))?.compiled_truth ?? null;
      expect({ outcomes, body }).toEqual({ outcomes: [{ code: null, status: 'created_or_updated' }, { code: null, status: 'created_or_updated' }],
        body: 'An ordinary note, rewritten.' });
      return { outcomes, body };
    } finally {
      await disposePersistenceConsumer(engine);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A put to a source with a checkout but no canonical owner, which `persistence.unbound_write=database_only` (and, on
 * PGLite, activation's database-only list) writes database-only. PGLite stores the page and writes no file. The Rust
 * engine cannot publish it (the publication rechecks the binding and stamps the page through raw SQL), so it must refuse
 * with the typed raw_sql refusal before admission: no write request is journaled, so no failed receipt is left behind.
 */
describe('engine parity: put_page to an unbound source, database-only', () => {
  parityTest('a database-only put to an unbound source stores the page and no file; Rust refuses it before admission', {
    methods: ['getPage'], requires: 'raw_sql',
  }, async (engine, backend) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-unbound-db-only-'));
    const ctx = { engine, sourceId: 'unbound', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const requestId = randomUUID();
    try {
      await createSource(engine, backend, 'unbound', {}, root);
      await engine.setConfig('persistence.unbound_write', 'database_only');
      await engine.setConfig('persistence.database_only_sources', JSON.stringify(['unbound']));
      try {
        const result = await putPage.handler(ctx, { slug: 'notes/unbound', content: page(''), request_id: requestId, wait_ms: 25_000 }) as Record<string, unknown>;
        return { status: String(result.status), stored: (await engine.getPage('notes/unbound', { sourceId: 'unbound' })) !== null,
          files: readdirSync(root, { recursive: true }).map(String) };
      } catch (error) {
        const principal = await requestPrincipalForContext(ctx);
        expect({ journaled: (await engine.readWriteRequest(principal.kind, principal.id, requestId))?.state ?? null }).toEqual({ journaled: null });
        throw error;
      }
    } finally {
      await disposePersistenceConsumer(engine);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A rename that lands between link preparation's two alias reads (the source's alias rows, then which of their pages
 * are live) never stores a link to the wrong page. Here `notes/first` was once `notes/old`, and a new page took the old
 * slug; the put links `[[notes/old]]` while that new page is renamed to `notes/second` between the two reads. The
 * alias rows are read again after the live-page read: they moved, so the pair is read once more and the link goes to
 * `notes/second`, the page that held the slug. Before the re-read the stale alias row and the fresh live set
 * combined into a link to `notes/first`, a page the note never named. The rename's alias row is seeded per arm as in
 * the case below (Rust records it; the SQL arms take a fixture row).
 */
describe('engine parity: put_page link targets through slug aliases under a rename', () => {
  parityTest('a rename between the alias read and the live-page read links the renamed page, never the alias\'s former target', {
    methods: ['updateSlug', 'listSlugAliases', 'listLinkEndpointPages', 'getLinks'],
  }, async (engine, backend) => {
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const put = async (slug: string, body: string) => String((await (putPage.handler(ctx, { slug,
      content: `---\ntitle: ${slug}\ntype: note\n---\n${body}\n`, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, unknown>>)).status);
    const rename = async (from: string, to: string) => {
      expect(await engine.updateSlug(from, to)).toBe(1);
      if (backend !== 'rust') {
        await engine.executeRaw(`UPDATE slug_aliases SET canonical_slug = $2 WHERE source_id = 'default' AND canonical_slug = $1`, [from, to]);
        await engine.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', $1, $2)
          ON CONFLICT (source_id, alias_slug) DO UPDATE SET canonical_slug = EXCLUDED.canonical_slug`, [from, to]);
      }
    };
    const handle = engine as unknown as Record<string, unknown>;
    try {
      const statuses = [await put('notes/old', 'The page that becomes notes/first.')];
      await rename('notes/old', 'notes/first');
      statuses.push(await put('notes/old', 'A new page under the old slug.'));
      // The first live-page read renames the new notes/old away, after the alias rows were read.
      const read = engine.listLinkEndpointPages.bind(engine);
      // Each queued rename runs at the start of the next live-page read that asks about notes/old.
      const putDuring = async (slug: string, renames: [string, string][]) => {
        const queue = [...renames];
        handle.listLinkEndpointPages = async (...args: Parameters<BrainEngine['listLinkEndpointPages']>) => {
          const next = args[1].includes('notes/old') ? queue.shift() : undefined;
          if (next) await rename(...next);
          return read(...args);
        };
        try {
          statuses.push(await put(slug, 'Points at [[notes/old]].'));
        } finally {
          delete handle.listLinkEndpointPages;
        }
        return { left: queue.length, linked: (await engine.getLinks(slug)).map(link => link.to_slug).sort() };
      };
      // One rename: the alias rows moved, the pair is read once more and agrees, the link goes to the renamed page.
      const once = await putDuring('notes/origin', [['notes/old', 'notes/second']]);
      // A rename on each read: the rows moved twice, so no alias is followed and the link is stored as written
      // (notes/old is no live page, so no edge): stale, never notes/first or another wrong page.
      statuses.push(await put('notes/old', 'Another new page under the old slug.'));
      const twice = await putDuring('notes/origin-two', [['notes/old', 'notes/third'], ['notes/third', 'notes/fourth']]);
      expect({ statuses, once, twice }).toEqual({
        statuses: Array(5).fill('created_or_updated'),
        once: { left: 0, linked: ['notes/second'] },
        twice: { left: 0, linked: [] },
      });
      return { once, twice };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  });
});

/**
 * A put of a note that wikilinks an old slug of a renamed page stores the link to the page's current slug: admission
 * reads the source's slug aliases and which of their pages are live (persistence/links-preparation.ts liveSlugAliases).
 * An alias whose old slug is itself a live page again is not followed. On a brain without the alias table (SQL arms
 * only; the Rust store always keeps the alias family) the alias read answers nothing, so the write gets past link
 * preparation and fails later, at publication, which needs the table too (as before the read became typed). The alias
 * row is seeded per arm: on Rust the rename records it, on the SQL arms (whose engine rename does not) a fixture row.
 */
describe('engine parity: put_page link targets through slug aliases', () => {
  parityTest('a wikilink to a renamed page\'s old slug links its current slug; a live old slug or a missing alias table links as written', {
    methods: ['updateSlug', 'listSlugAliases', 'listLinkEndpointPages', 'getLinks'],
  }, async (engine, backend) => {
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const put = async (slug: string, body: string) => {
      const result = await (putPage.handler(ctx, { slug, content: `---\ntitle: ${slug}\ntype: note\n---\n${body}\n`, request_id: randomUUID(),
        wait_ms: 25_000 }) as Promise<Record<string, unknown>>);
      return String(result.status);
    };
    const targets = async (slug: string) => (await engine.getLinks(slug)).map(link => link.to_slug).sort();
    try {
      const statuses = [await put('notes/old', 'The page before its rename.'), await put('notes/other-old', 'A second page to rename.')];
      expect(await engine.updateSlug('notes/old', 'notes/new')).toBe(1);
      expect(await engine.updateSlug('notes/other-old', 'notes/other-new')).toBe(1);
      if (backend !== 'rust') {
        for (const [alias, canonical] of [['notes/old', 'notes/new'], ['notes/other-old', 'notes/other-new']]) {
          await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', ['default', alias, canonical]);
        }
      }
      const aliases = (await engine.listSlugAliases('default')).map(row => `${row.alias_slug}>${row.canonical_slug}`).sort();
      // notes/other-old is a live page again, so a link to it stays on it.
      statuses.push(await put('notes/other-old', 'A new page under the old slug.'));
      // A folder-qualified link no page holds exactly resolves through the source's basename index to the deeper page.
      statuses.push(await put('archive/notes/deep', 'A page one folder deeper than the link names.'));
      statuses.push(await put('notes/source', 'About [[notes/old]], [[notes/other-old]] and [[notes/deep]].'));
      const linked = await targets('notes/source');
      expect({ statuses, aliases, linked }).toEqual({
        statuses: ['created_or_updated', 'created_or_updated', 'created_or_updated', 'created_or_updated', 'created_or_updated'],
        aliases: ['notes/old>notes/new', 'notes/other-old>notes/other-new'],
        linked: ['archive/notes/deep', 'notes/new', 'notes/other-old'],
      });
      if (backend !== 'rust') {
        await engine.executeRaw('DROP TABLE slug_aliases');
        const missing = await put('notes/source-two', 'About [[notes/old]].').then(status => ({ status, phase: null as string | null }),
          (e: { writeError?: string; message?: string }) => ({ status: e.writeError ?? 'refused',
            phase: String(e.message).includes('Publication failed') && String(e.message).includes('slug_aliases') ? 'publication' : String(e.message) }));
        expect(missing).toEqual({ status: 'storage_error', phase: 'publication' });
      }
      return { aliases, linked };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  });
});
