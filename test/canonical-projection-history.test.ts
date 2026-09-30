import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { prepareCanonicalProjections, timelineRowAction, type ProjectionWriter } from '../src/core/persistence/canonical-projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-projection-history-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
  rmSync(dataDir, { recursive: true, force: true });
});

interface Fixture { engine: BrainEngine; sourceId: string; put(slug: string, content: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  revision(slug: string): Promise<string>; pageId(slug: string): Promise<number>;
  legacyTimeline(slug: string, row: { date: string; source: string; summary: string; detail?: string }): Promise<void>;
  legacyTake(slug: string, rowNum: number, claim: string): Promise<void>;
  timeline(slug: string): Promise<Array<{ date: string; source: string; summary: string; detail: string }>>;
  takes(slug: string): Promise<Array<{ row_num: number; claim: string }>> }

async function fixture(run: (f: Fixture) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(dataDir, 'case-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `history-${randomUUID().slice(0, 8)}`;
    const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
      dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    const coordinated = (sql: string, params: unknown[]) =>
      engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(sql, params)));
    const f: Fixture = {
      engine, sourceId,
      put: (slug, content, extra = {}) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(), ...extra } }),
      revision: async slug => (await engine.readPageSnapshot(slug, { sourceId }))!.revision,
      pageId: async slug => (await engine.readPageSnapshot(slug, { sourceId }))!.page.id,
      legacyTimeline: async (slug, row) => { await coordinated(`INSERT INTO timeline_entries(page_id,date,source,summary,detail)
        SELECT id,$3::date,$4,$5,$6 FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug, row.date, row.source, row.summary, row.detail ?? '']); },
      legacyTake: async (slug, rowNum, claim) => { await coordinated(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight)
        SELECT id,$3,$4,'take','brain',0.5 FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug, rowNum, claim]); },
      timeline: async slug => engine.executeRaw(`SELECT t.date::text AS date,t.source,t.summary,t.detail FROM timeline_entries t
        JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2 AND t.event_page_id IS NULL ORDER BY t.date,t.summary`, [sourceId, slug]),
      takes: async slug => engine.executeRaw(`SELECT k.row_num,k.claim FROM takes k JOIN pages p ON p.id=k.page_id
        WHERE p.source_id=$1 AND p.slug=$2 ORDER BY k.row_num`, [sourceId, slug]),
    };
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await run(f);
      });
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }
}

const page = (body: string, timeline = '') =>
  `---\ntype: note\ntitle: Example project\n---\n${body}\n${timeline ? `\n## Timeline\n\n${timeline}\n` : ''}`;
const legacy = { date: '2026-07-01', source: 'legacy', summary: 'Kickoff held before write-through', detail: 'pre-write-through evidence' };
const derived = { date: '2026-07-02', source: '', summary: 'Example project', detail: '' };

describe('#5567 coordinated writes keep database-only timeline history', () => {
  test('a forced put_page without a revision keeps legacy and extracted rows that have no bullet', async () => {
    await fixture(async f => {
      await f.put('projects/example', page('First draft.'));
      await f.legacyTimeline('projects/example', legacy);
      await f.legacyTimeline('projects/example', derived);
      await f.put('projects/example', page('Second draft.'), { force: true });
      expect(await f.timeline('projects/example')).toEqual([legacy, derived]);
    });
  });

  test('a put_page with the current revision keeps database-only rows and adds its own bullets', async () => {
    await fixture(async f => {
      await f.put('projects/example', page('First draft.'));
      await f.legacyTimeline('projects/example', legacy);
      await f.put('projects/example', page('Second draft.', '- **2026-08-01** | markdown — Launch review'),
        { expected_revision: await f.revision('projects/example') });
      expect(await f.timeline('projects/example')).toEqual([legacy,
        { date: '2026-08-01', source: 'markdown', summary: 'Launch review', detail: '' }]);
    });
  });

  test('removing a bullet still deletes its own row and nothing else', async () => {
    await fixture(async f => {
      await f.put('projects/example', page('Draft.', '- **2026-08-01** | markdown — Launch review\n- **2026-08-02** | markdown — Follow-up'));
      await f.legacyTimeline('projects/example', legacy);
      await f.put('projects/example', page('Draft.', '- **2026-08-02** | markdown — Follow-up'),
        { expected_revision: await f.revision('projects/example') });
      expect(await f.timeline('projects/example')).toEqual([legacy,
        { date: '2026-08-02', source: 'markdown', summary: 'Follow-up', detail: '' }]);
    });
  });

  test('a user-removed bullet whose legacy row drifted in whitespace is deleted, not resurrected', async () => {
    await fixture(async f => {
      await f.put('projects/example', page('Draft.', '- **2026-08-01** | markdown — Launch review'));
      const pageId = await f.pageId('projects/example');
      await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => tx.executeRaw(
        `UPDATE timeline_entries SET summary='Launch  review ' WHERE page_id=$1`, [pageId])));
      await f.put('projects/example', page('Draft without the bullet.'), { expected_revision: await f.revision('projects/example') });
      expect(await f.timeline('projects/example')).toEqual([]);
    });
  });

  test('a kept bullet replaces its drifted legacy row instead of duplicating it', async () => {
    await fixture(async f => {
      await f.put('projects/example', page('Draft.', '- **2026-08-01** | markdown — Launch review'));
      const pageId = await f.pageId('projects/example');
      await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => tx.executeRaw(
        `UPDATE timeline_entries SET summary='Launch  review ' WHERE page_id=$1`, [pageId])));
      await f.put('projects/example', page('Edited draft.', '- **2026-08-01** | markdown — Launch review'), { force: true });
      expect(await f.timeline('projects/example')).toEqual([{ date: '2026-08-01', source: 'markdown', summary: 'Launch review', detail: '' }]);
    });
  });

  test('editing a bullet detail refreshes its row detail', async () => {
    await fixture(async f => {
      await f.put('projects/example', page('Draft.', '- **2026-08-01** | markdown — Launch review\n  First detail'));
      await f.put('projects/example', page('Draft.', '- **2026-08-01** | markdown — Launch review\n  Revised detail'),
        { expected_revision: await f.revision('projects/example') });
      expect(await f.timeline('projects/example')).toEqual([{ date: '2026-08-01', source: 'markdown', summary: 'Launch review', detail: 'Revised detail' }]);
    });
  });

  test('rows that change between preparation and apply are never touched by that write', async () => {
    await fixture(async f => {
      const slug = 'projects/example';
      await f.put(slug, page('Draft.', '- **2026-08-01** | markdown — Removed later\n- **2026-08-02** | markdown — Kept bullet'));
      const pageId = await f.pageId(slug);
      const snapshot = await f.engine.readPageSnapshot(slug, { sourceId: f.sourceId, includeDeleted: true });
      const next = parseMarkdown(page('Draft.', '- **2026-08-02** | markdown — Kept bullet\n  Canonical detail'), slug);
      const project = await prepareCanonicalProjections(f.engine, next, slug, f.sourceId, snapshot, 'editing');
      await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], async () => {
        await tx.executeRaw(`DELETE FROM timeline_entries WHERE page_id=$1 AND summary='Removed later'`, [pageId]);
        await tx.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES($1,'2026-08-01','markdown','Removed later','recreated')`, [pageId]);
        await tx.executeRaw(`UPDATE timeline_entries SET detail='concurrent detail' WHERE page_id=$1 AND summary='Kept bullet'`, [pageId]);
        await tx.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES($1,'2026-08-03','','Arrived mid-flight','')`, [pageId]);
      }));
      await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => project(tx)));
      expect(await f.timeline(slug)).toEqual([
        { date: '2026-08-01', source: 'markdown', summary: 'Removed later', detail: 'recreated' },
        { date: '2026-08-02', source: 'markdown', summary: 'Kept bullet', detail: 'concurrent detail' },
        { date: '2026-08-03', source: '', summary: 'Arrived mid-flight', detail: '' },
      ]);
    });
  });

  test('every writer class keeps database-only rows and deletes only the prior bullets it removed', async () => {
    await fixture(async f => {
      const slug = 'projects/example';
      for (const writer of ['editing', 'preserving', 'immutable'] as ProjectionWriter[]) {
        await f.put(slug, page(`Draft for ${writer}.`, '- **2026-08-01** | markdown — Removed bullet'), { force: true });
        await f.legacyTimeline(slug, legacy);
        const snapshot = await f.engine.readPageSnapshot(slug, { sourceId: f.sourceId, includeDeleted: true });
        const project = await prepareCanonicalProjections(f.engine, parseMarkdown(page(`Next for ${writer}.`), slug), slug, f.sourceId, snapshot, writer);
        await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => project(tx)));
        expect(await f.timeline(slug)).toEqual([legacy]);
        await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => tx.executeRaw(
          'DELETE FROM timeline_entries WHERE page_id=$1', [snapshot!.page.id])));
      }
    });
  });
});

describe('#5567 managed sync keeps database-only timeline history', () => {
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (root: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'edit'); };

  test('a committed file edit synced by the owner keeps legacy rows, deletes only its removed bullet and leaves the file alone', async () => {
    for (const engine of engines) {
      const dir = mkdtempSync(join(dataDir, 'sync-'));
      const root = join(dir, 'brain'); mkdirSync(join(root, 'projects'), { recursive: true });
      const sourceId = `history-sync-${randomUUID().slice(0, 8)}`;
      const file = join(root, 'projects/example.md');
      try {
        await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
          git(root, 'init', '-q');
          writeFileSync(file, page('Draft.', '- **2026-08-01** | markdown — Launch review\n- **2026-08-02** | markdown — Follow-up'));
          commit(root);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
          await claimWorktree(engine, sourceId, root);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          await performManagedSync(engine, { sourceId, noPull: true });
          await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail)
            SELECT id,$3::date,$4,$5,$6 FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, 'projects/example', legacy.date, legacy.source, legacy.summary, legacy.detail])));
          const edited = page('Edited draft.', '- **2026-08-02** | markdown — Follow-up');
          writeFileSync(file, edited); commit(root);
          expect(await performManagedSync(engine, { sourceId, noPull: true })).toMatchObject({ status: 'synced' });
          expect(await engine.executeRaw(`SELECT t.date::text AS date,t.source,t.summary,t.detail FROM timeline_entries t JOIN pages p ON p.id=t.page_id
            WHERE p.source_id=$1 AND p.slug='projects/example' ORDER BY t.date`, [sourceId])).toEqual([legacy,
            { date: '2026-08-02', source: 'markdown', summary: 'Follow-up', detail: '' }]);
          expect(readFileSync(file, 'utf8')).toBe(edited);
        });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    }
  }, 120_000);
});

describe('#5567 coordinated writes keep database-only takes', () => {
  const fence = (rows: string[]) => ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
    '|---|-------|------|-----|--------|-------|--------|', ...rows, '<!--- gbrain:takes:end -->'].join('\n');
  const row = (n: number, claim: string) => `| ${n} | ${claim} | take | brain | 0.5 | 2026-07 | notes |`;

  test('a fenced take and a database-only take both survive a page write', async () => {
    await fixture(async f => {
      await f.put('projects/example', page(`Draft.\n\n${fence([row(1, 'Fenced claim')])}`));
      await f.legacyTake('projects/example', 7, 'Database-only claim');
      await f.put('projects/example', page(`Edited.\n\n${fence([row(1, 'Fenced claim')])}`), { force: true });
      expect(await f.takes('projects/example')).toEqual([{ row_num: 1, claim: 'Fenced claim' }, { row_num: 7, claim: 'Database-only claim' }]);
    });
  });

  test('removing a fenced take still deletes it', async () => {
    await fixture(async f => {
      await f.put('projects/example', page(`Draft.\n\n${fence([row(1, 'Fenced claim'), row(2, 'Removed claim')])}`));
      await f.put('projects/example', page(`Edited.\n\n${fence([row(1, 'Fenced claim')])}`), { expected_revision: await f.revision('projects/example') });
      expect(await f.takes('projects/example')).toEqual([{ row_num: 1, claim: 'Fenced claim' }]);
    });
  });

  test('an incoming fence row that collides with a database-only take refuses and leaves the take unchanged', async () => {
    await fixture(async f => {
      await f.put('projects/example', page(`Draft.\n\n${fence([row(1, 'Fenced claim')])}`));
      await f.legacyTake('projects/example', 2, 'Database-only claim');
      const before = await f.revision('projects/example');
      await expect(f.put('projects/example', page(`Edited.\n\n${fence([row(1, 'Fenced claim'), row(2, 'New claim')])}`), { force: true }))
        .rejects.toMatchObject({ code: 'take_row_collision', writeError: 'take_row_collision' });
      expect(await f.takes('projects/example')).toEqual([{ row_num: 1, claim: 'Fenced claim' }, { row_num: 2, claim: 'Database-only claim' }]);
      expect(await f.revision('projects/example')).toBe(before);
    });
  });

  test('an incoming fence row identical to a database-only take adopts it instead of refusing', async () => {
    await fixture(async f => {
      await f.put('projects/example', page(`Draft.\n\n${fence([row(1, 'Fenced claim')])}`));
      await f.legacyTake('projects/example', 2, 'Same claim');
      await f.put('projects/example', page(`Edited.\n\n${fence([row(1, 'Fenced claim'), row(2, 'Same claim')])}`), { force: true });
      expect(await f.takes('projects/example')).toEqual([{ row_num: 1, claim: 'Fenced claim' }, { row_num: 2, claim: 'Same claim' }]);
    });
  });
});

describe('#5567 writer decision table', () => {
  const table: Record<ProjectionWriter, Record<Parameters<typeof timelineRowAction>[1], ReturnType<typeof timelineRowAction>>> = {
    editing: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'delete', database_only: 'materialize' },
    preserving: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'materialize', database_only: 'materialize' },
    file: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'delete', database_only: 'keep' },
    immutable: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'keep', database_only: 'keep' },
  };
  for (const [writer, rows] of Object.entries(table) as Array<[ProjectionWriter, (typeof table)[ProjectionWriter]]>) {
    for (const [state, action] of Object.entries(rows) as Array<[Parameters<typeof timelineRowAction>[1], ReturnType<typeof timelineRowAction>]>) {
      test(`${writer} writer: ${state} row -> ${action}`, () => { expect(timelineRowAction(writer, state)).toBe(action); });
    }
  }
});
