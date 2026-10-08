/**
 * #5567 materialize + marker: database-only timeline rows are written back into
 * the page as marked bullets by writers that render from the database, and the
 * per-writer class decides who may remove a marked row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { materializeTimeline, prepareCanonicalProjections, renderMaterializedBullet, type ProjectionWriter } from '../src/core/persistence/canonical-projections.ts';
import { parseTimelineEntries } from '../src/core/link-extraction.ts';
import { extractTimelineFromContent } from '../src/core/timeline-extract.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { materializedMarker } from '../src/core/timeline-marker.ts';
import { operationsByName } from '../src/core/operations.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-materialize-'));
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

type Row = { date: string; source: string; summary: string; detail: string };
interface Fixture { engine: BrainEngine; sourceId: string; root: string;
  put(slug: string, content: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  revision(slug: string): Promise<string>; body(slug: string): Promise<string>; file(slug: string): string;
  legacy(slug: string, row: Omit<Row, 'detail'> & { detail?: string }): Promise<void>; timeline(slug: string): Promise<Row[]> }

async function fixture(run: (f: Fixture) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(dataDir, 'case-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `materialize-${randomUUID().slice(0, 8)}`;
    const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
      dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    const f: Fixture = {
      engine, sourceId, root,
      put: (slug, content, extra = {}) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(), ...extra } }),
      revision: async slug => (await engine.readPageSnapshot(slug, { sourceId }))!.revision,
      body: async slug => { const s = (await engine.readPageSnapshot(slug, { sourceId }))!; return [s.page.compiled_truth, s.page.timeline ?? ''].join('\n'); },
      file: slug => {
        const hit = [join(root, `${slug}.md`), join(root, '.sources', sourceId, `${slug}.md`)].find(existsSync);
        if (!hit) throw new Error(`no canonical file for ${slug}: ${readdirSync(root)}`);
        return readFileSync(hit, 'utf8');
      },
      legacy: async (slug, row) => { await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
        `INSERT INTO timeline_entries(page_id,date,source,summary,detail) SELECT id,$3::date,$4,$5,$6 FROM pages WHERE source_id=$1 AND slug=$2`,
        [sourceId, slug, row.date, row.source, row.summary, row.detail ?? '']), TEST_WRITE_ATTRIBUTION)); },
      timeline: async slug => engine.executeRaw<Row>(`SELECT t.date::text AS date,t.source,t.summary,t.detail FROM timeline_entries t
        JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2 AND t.event_page_id IS NULL ORDER BY t.date,t.summary`, [sourceId, slug]),
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
const slug = 'projects/example';
const legacy = { date: '2026-07-01', source: 'legacy', summary: 'Kickoff   held before write-through', detail: 'pre-write-through\n   evidence' };
const normalized = { date: '2026-07-01', source: 'legacy', summary: 'Kickoff held before write-through', detail: 'pre-write-through evidence' };
const bullet = `${materializedMarker(normalized)}\n- **2026-07-01** | legacy — Kickoff held before write-through\n  pre-write-through evidence`;

describe('#5567 database-only rows are materialized as marked bullets', () => {
  test('a put_page writes a legacy row back as a marked bullet with its normalized detail, in the file too', async () => {
    await fixture(async f => {
      await f.put(slug, page('First draft.', '- **2026-08-01** | markdown — Launch review'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Second draft.', '- **2026-08-01** | markdown — Launch review'), { expected_revision: await f.revision(slug) });
      expect(await f.body(slug)).toContain(`- **2026-08-01** | markdown — Launch review\n${bullet}`);
      expect(f.file(slug)).toContain(bullet);
      expect(await f.timeline(slug)).toEqual([normalized, { date: '2026-08-01', source: 'markdown', summary: 'Launch review', detail: '' }]);
    });
  });

  test('materializing history keeps the stored type of a body-only update', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, '---\ntitle: Example project\n---\nBody-only update.\n', { force: true });
      expect((await f.engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!.page.type).toBe('note');
      expect(await f.body(slug)).toContain(bullet);
    });
  });

  test('a second put of the rendered page and a forced re-put of the original body are byte-identical', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.'), { force: true });
      const first = f.file(slug);
      const revision = await f.revision(slug);
      const again = await f.put(slug, first, { expected_revision: revision });
      expect(again.noop ?? again.status === 'skipped').toBeTruthy();
      expect(f.file(slug)).toBe(first);
      await f.put(slug, page('Draft.'), { force: true });
      expect(f.file(slug)).toBe(first);
      expect(await f.revision(slug)).toBe(revision);
    });
  });

  test('removing a marked bullet in a revision-bound put_page deletes its row', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.'), { force: true });
      await f.put(slug, page('Draft without history.'), { expected_revision: await f.revision(slug) });
      expect(await f.timeline(slug)).toEqual([]);
      expect(await f.body(slug)).not.toContain('gbrain:materialized');
    });
  });

  test('a stale put_page without a revision keeps a marked row and renders it again', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.'), { force: true });
      await f.put(slug, page('Stale copy.'), { force: true });
      expect(await f.timeline(slug)).toEqual([normalized]);
      expect(await f.body(slug)).toContain(bullet);
    });
  });

  test('deleting only the marker comment in an editing write keeps the row', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.'), { force: true });
      const withoutMarker = f.file(slug).replace(`${materializedMarker(normalized)}\n`, '');
      await f.put(slug, withoutMarker, { expected_revision: await f.revision(slug) });
      expect(await f.timeline(slug)).toEqual([normalized]);
      expect(await f.body(slug)).not.toContain('gbrain:materialized');
    });
  });

  test('a hand-edited marked bullet is an ordinary edited bullet', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.'), { force: true });
      const edited = f.file(slug).replace('Kickoff held before write-through', 'Kickoff held in person');
      await f.put(slug, edited, { expected_revision: await f.revision(slug) });
      expect((await f.timeline(slug)).map(r => r.summary)).toEqual(['Kickoff held in person']);
      // #5969 (D3): a preserving put that omits the section keeps every row, so the dropped bullet is dropped from a present section.
      await f.put(slug, page('Draft.', '- **2026-08-02** | markdown — Next step'), { force: true });
      expect((await f.timeline(slug)).map(r => r.summary)).toEqual(['Next step']);
    });
  });

  test('a row whose normalized tuple already has a bullet is not duplicated', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.', '- **2026-07-01** | legacy — Kickoff held before write-through'));
      await f.legacy(slug, { date: '2026-07-01', source: 'legacy', summary: 'Kickoff  held before write-through ' });
      await f.put(slug, page('Edited.', '- **2026-07-01** | legacy — Kickoff held before write-through'), { force: true });
      expect(await f.body(slug)).not.toContain('gbrain:materialized');
      expect((await f.timeline(slug)).map(r => r.summary)).toEqual(['Kickoff held before write-through']);
    });
  });

  test('a source with internal whitespace materializes once and repeated saves converge', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, { date: '2026-07-05', source: 'meeting  notes', summary: 'Spaced source' });
      for (const body of ['Edited.', 'Edited again.', 'Edited once more.']) await f.put(slug, page(body), { force: true });
      expect((await f.body(slug)).match(/gbrain:materialized/g)?.length).toBe(1);
      expect(await f.timeline(slug)).toEqual([{ date: '2026-07-05', source: 'meeting  notes', summary: 'Spaced source', detail: '' }]);
    });
  });

  test('backlink receipts, empty sources and delimiter-bearing sources are kept, never materialized', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      const kept = [
        { date: '2026-07-02', source: 'markdown', summary: 'Referenced in [Acme](companies/acme-example.md)' },
        { date: '2026-07-03', source: '', summary: 'Example project' },
        { date: '2026-07-04', source: 'notes — call', summary: 'Delimiter in the source' },
      ];
      for (const row of kept) await f.legacy(slug, row);
      await f.put(slug, page('Edited.'), { force: true });
      expect(await f.body(slug)).not.toContain('gbrain:materialized');
      expect((await f.timeline(slug)).map(r => r.summary).sort()).toEqual(kept.map(r => r.summary).sort());
    });
  });

  test('a markdown rebuild keeps markers and their protection', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.'), { force: true });
      const rendered = f.file(slug);
      await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => tx.executeRaw(
        `UPDATE pages SET compiled_truth='', timeline='' WHERE source_id=$1 AND slug=$2`, [f.sourceId, slug]), TEST_WRITE_ATTRIBUTION));
      await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () =>
        importFromContent(tx, slug, rendered, { sourceId: f.sourceId, noEmbed: true, forceRechunk: true }), TEST_WRITE_ATTRIBUTION));
      expect(await f.body(slug)).toContain(bullet);
      await f.put(slug, page('Stale copy.'), { force: true });
      expect(await f.timeline(slug)).toEqual([normalized]);
    });
  });

  test('remote get_page keeps markers so a remote edit round-trips them; chunks never contain them', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.'), { force: true });
      const remote = await operationsByName.get_page.handler({ engine: f.engine, config: { engine: f.engine.kind }, logger: { info() {}, warn() {}, error() {} },
        dryRun: false, remote: true, sourceId: f.sourceId } as never, { slug, include_content: true }) as { timeline: string; content?: string };
      expect(remote.timeline).toContain(materializedMarker(normalized));
      const chunks = await f.engine.executeRaw<{ chunk_text: string }>(`SELECT c.chunk_text FROM content_chunks c JOIN pages p ON p.id=c.page_id
        WHERE p.source_id=$1 AND p.slug=$2`, [f.sourceId, slug]);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some(c => c.chunk_text.includes('Kickoff held'))).toBe(true);
      expect(chunks.some(c => c.chunk_text.includes('gbrain:materialized'))).toBe(false);
    });
  });
});

describe('#5567 per-writer classes for marked rows', () => {
  async function marked(f: Fixture) {
    await f.put(slug, page('Draft.'));
    await f.legacy(slug, legacy);
    await f.put(slug, page('Draft.'), { force: true });
    return f.engine.readPageSnapshot(slug, { sourceId: f.sourceId, includeDeleted: true });
  }
  const cases: Array<[ProjectionWriter, boolean, boolean]> = [
    // writer, renders the row back, keeps the row
    ['editing', false, false],
    ['file', false, false],
    ['preserving', true, true],
    ['immutable', false, true],
  ];
  for (const [writer, renders, keeps] of cases) {
    test(`${writer} writer that drops a marked bullet ${keeps ? 'keeps' : 'deletes'} the row${renders ? ' and renders it again' : ''}`, async () => {
      await fixture(async f => {
        const prior = await marked(f);
        const next = parseMarkdown(page('Regenerated body.'), slug);
        const carried = await materializeTimeline(f.engine, next, slug, prior, writer);
        expect(carried.materialized).toBe(renders ? 1 : 0);
        const project = await prepareCanonicalProjections(f.engine, { ...next, timeline: carried.timeline }, slug, f.sourceId, prior, writer);
        await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => project(tx), TEST_WRITE_ATTRIBUTION));
        expect(await f.timeline(slug)).toEqual(keeps ? [normalized] : []);
      });
    });
  }

  test('two consecutive connector-style regenerations keep a marked row and drop an unmarked bullet they stopped producing', async () => {
    await fixture(async f => {
      await f.put(slug, page('Draft.', '- **2026-08-01** | connector — Old item'));
      await f.legacy(slug, legacy);
      await f.put(slug, page('Draft.', '- **2026-08-01** | connector — Old item'), { force: true });
      // #5969 (D3): each render carries its section (an omitted one keeps every row for a preserving put).
      const current = '- **2026-08-02** | connector — Current item';
      for (const render of [page('Connector render.', current), page('Connector render.', current)]) {
        await f.put(slug, render, { force: true });
        expect(await f.timeline(slug)).toEqual([normalized, { date: '2026-08-02', source: 'connector', summary: 'Current item', detail: '' }]);
        expect(await f.body(slug)).toContain(bullet);
      }
    });
  });
});

describe('#5567 marker parsing', () => {
  test('a marked bullet does not become detail of the preceding bullet, and the marker is not text anywhere', () => {
    const body = `- **2026-06-30** | markdown — Earlier bullet\n  earlier detail\n${bullet}\n`;
    expect(parseTimelineEntries(body)).toEqual([
      { date: '2026-06-30', source: 'markdown', summary: 'Earlier bullet', detail: 'earlier detail' },
      { date: '2026-07-01', source: 'legacy', summary: 'Kickoff held before write-through', detail: 'pre-write-through evidence' },
    ]);
    expect(extractTimelineFromContent(body, slug).map(e => e.summary)).toEqual(['Earlier bullet', 'Kickoff held before write-through']);
    expect(sanitizeRemoteBody(body)).not.toContain('gbrain:materialized');
    expect(sanitizeRemoteBody(body, { keepMaterializedMarkers: true })).toContain(materializedMarker(normalized));
  });

  test('a materialized bullet after a dated header is not part of the header detail', () => {
    const body = `### 2026-06-01 — Planning\nHeader detail.\n${bullet}\n`;
    const header = extractTimelineFromContent(body, slug).find(e => e.summary === 'Planning');
    expect(header?.detail).toBe('Header detail.');
  });

  test('render then extract must return exactly the tuple', () => {
    expect(renderMaterializedBullet(legacy, slug)).toBe(bullet);
    expect(renderMaterializedBullet({ date: '2026-07-01', source: '', summary: 'x' }, slug)).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-07-01', source: 'a — b', summary: 'x' }, slug)).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-07-01', source: 'markdown', summary: 'Referenced in [X](x.md)' }, slug)).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-07-01', source: 'notes', summary: 'x', detail: '**2026-07-02** | nested' }, slug)).toBeNull();
  });
});

describe('#6226 rows the older citation reading stored', () => {
  const cited = '- **Widget-co:** per Alice, builds widgets. [Source: meeting transcript, 2026-10-06; Gmail "Intro", 2026-09-28]';
  const oldSource = 'meeting transcript, 2026-10-06; Gmail "Intro"';
  const oldRow = { date: '2026-09-28', source: oldSource, summary: 'Widget-co:** per Alice, builds widgets.' };
  const current = [
    { date: '2026-09-28', source: 'Gmail "Intro"', summary: 'Widget-co: per Alice, builds widgets.', detail: 'Source: Gmail "Intro"' },
    { date: '2026-10-06', source: 'meeting transcript', summary: 'Widget-co: per Alice, builds widgets.', detail: 'Source: meeting transcript' },
  ];

  test('an editing write retires the old multi-source row instead of writing it back into the page', async () => {
    await fixture(async f => {
      await f.put(slug, page(cited));
      await f.legacy(slug, { ...oldRow, detail: `Source: ${oldSource}` });
      await f.put(slug, page(`${cited}\n\nA later edit.`), { expected_revision: await f.revision(slug) });
      expect(await f.body(slug)).not.toContain('gbrain:materialized');
      expect(f.file(slug)).not.toContain(`| ${oldSource} —`);
      expect(await f.timeline(slug)).toEqual(current);
    });
  });

  test('a file-extracted old row (no detail) is retired too', async () => {
    await fixture(async f => {
      await f.put(slug, page(cited));
      await f.legacy(slug, oldRow);
      await f.put(slug, page(`${cited}\n\nA later edit.`), { expected_revision: await f.revision(slug) });
      expect(await f.timeline(slug)).toEqual(current);
    });
  });

  test('a row sharing the old tuple but carrying its own detail stays in the database and is never materialized (T3)', async () => {
    await fixture(async f => {
      await f.put(slug, page(cited));
      await f.legacy(slug, { ...oldRow, detail: 'confirmed by phone' });
      await f.put(slug, page(`${cited}\n\nA later edit.`), { expected_revision: await f.revision(slug) });
      expect(await f.body(slug)).not.toContain('gbrain:materialized');
      expect(await f.timeline(slug)).toEqual([{ ...oldRow, detail: 'confirmed by phone' }, ...current]
        .sort((a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary)));
    });
  });

  test('a preserving write that omits the Timeline section still retires the old row and never renders it', async () => {
    await fixture(async f => {
      await f.put(slug, page(cited, '- **2026-08-01** | markdown — Launch review'));
      await f.legacy(slug, { ...oldRow, detail: `Source: ${oldSource}` });
      await f.put(slug, page(`${cited}\n\nA later edit.`), { force: true });
      expect(await f.body(slug)).not.toContain(`| ${oldSource} —`);
      expect((await f.timeline(slug)).some(row => row.source === oldSource)).toBe(false);
    });
  });

  test('a database-only row the citation text never produced is still materialized', async () => {
    await fixture(async f => {
      await f.put(slug, page(cited));
      await f.legacy(slug, { date: '2026-10-06', source: 'meeting transcript', summary: 'Signed the pilot' });
      await f.put(slug, page(`${cited}\n\nA later edit.`), { expected_revision: await f.revision(slug) });
      expect(await f.body(slug)).toContain('- **2026-10-06** | meeting transcript — Signed the pilot');
    });
  });
});
