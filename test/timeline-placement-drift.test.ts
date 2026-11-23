/**
 * A page's file and its database row hold the same page when they differ only in where the body's timeline section is
 * split. An import before v0.46.25.0 (#2225) kept a body's bare dated `## Timeline` section in compiled_truth with an
 * empty timeline, and a file rendered from such a row before #7738 has no sentinel, so today's parse of the unchanged file
 * moves the section to the timeline. Every write to such a page refused `source_changed` (file_database_drift) and sync held
 * its next edit `file_drift`. A real difference in any line still refuses and stays held with both copies kept. A
 * database-side hold (the file unchanged since its import) whose page and file agree now releases through the
 * `release_hold` route: its re-screen runs as database-side drift, which imports only when the file holds the page.
 * PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown, RECOVERY_VERSION, serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { fileMatchesSnapshot } from '../src/core/persistence/page-prepare.ts';
import { FILE_DRIFT_VERSION, holdRescreenDue, requestGitHoldRetry, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { operationsByName } from '../src/core/operations.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-timeline-placement-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});

const SLUG = 'people/alice-example';
const PROSE = 'Alice Example is a synthetic person.';
const BULLETS = ['- **2026-01-01** | meeting — Met about the plan.', '- **2026-02-01** | email — Sent the synthetic follow-up.'];
const folded = (bullets: string[] = BULLETS, prose = PROSE) => `${prose}\n\n## Timeline\n\n${bullets.join('\n')}`;
const SOURCE = `---\ntype: person\ntitle: Alice Example\n---\n${folded()}\n`;
const SENTINEL = '\n\n<!-- timeline -->';
type Folded = { compiled_truth: string; frontmatter?: Record<string, unknown> };

/**
 * A page whose row holds `database` as compiled_truth with an empty timeline, the way an import before #2225 stored it, and
 * whose file is `file` rendered from such a row: before #7738 (no sentinel), unless `sentinel`.
 */
async function fixture(engine: BrainEngine, database: Folded, file: Folded = { compiled_truth: folded() }, sentinel = false) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `placement-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(join(root, 'people'), { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await importFromContent(engine, SLUG, SOURCE, { sourceId: id, sourcePath: `${SLUG}.md`, noEmbed: true });
  const imported = (await engine.readPageSnapshot(SLUG, { sourceId: id }))!;
  expect(imported.page.timeline).not.toBe('');
  await engine.executeRaw("UPDATE pages SET compiled_truth=$3, timeline='', frontmatter=$4::jsonb WHERE source_id=$1 AND slug=$2",
    [id, SLUG, database.compiled_truth, JSON.stringify(database.frontmatter ?? imported.page.frontmatter)]);
  const stored = (await engine.readPageSnapshot(SLUG, { sourceId: id }))!;
  const rendered = serializePageToMarkdown({ ...stored.page, compiled_truth: file.compiled_truth, timeline: '', frontmatter: file.frontmatter ?? stored.page.frontmatter }, stored.tags);
  expect(rendered).toContain(SENTINEL);
  writeFileSync(join(root, `${SLUG}.md`), sentinel ? rendered : rendered.replace(SENTINEL, ''));
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const registration = await registerLocalWriter(engine, 'cli');
  const ctx: OperationContext = { engine, remote: false, sourceId: id, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  const local = <T>(fn: () => Promise<T>) => withVerifiedLocalRegistration(engine, registration, fn);
  return { id, file: join(root, `${SLUG}.md`), ctx, local, stored };
}
const remember = (ctx: OperationContext, fact: string) => operationsByName.remember!.handler(ctx,
  { fact, provenance: 'Synthetic operator conversation', entity: SLUG, request_id: randomUUID() }) as Promise<Record<string, unknown>>;

test('a file rendered before #7738 from a row an import before #2225 stored holds the page: writes land and both copies agree after', () => isolated(async engine => {
  const f = await fixture(engine, { compiled_truth: folded() });
  expect(readFileSync(f.file, 'utf8')).not.toContain('<!-- timeline -->');
  expect(parseMarkdown(readFileSync(f.file, 'utf8'), SLUG).timeline).toBe(`## Timeline\n\n${BULLETS.join('\n')}`);
  expect(await fileMatchesSnapshot(engine, SLUG, readFileSync(f.file, 'utf8'), f.stored, `${SLUG}.md`)).toBe(true);
  await f.local(async () => {
    expect((await liveFileDrift(engine, f.id, SLUG)).reason).toBe('agrees');
    expect(await remember(f.ctx, 'Prefers the synthetic morning review.')).toMatchObject({ status: 'inserted', state: 'committed' });
    const db = (await engine.readPageSnapshot(SLUG, { sourceId: f.id }))!;
    const onDisk = parseMarkdown(readFileSync(f.file, 'utf8'), SLUG);
    expect([onDisk.compiled_truth, onDisk.timeline]).toEqual([db.page.compiled_truth, db.page.timeline]);
    for (const line of [PROSE, ...BULLETS]) expect(`${db.page.compiled_truth}\n${db.page.timeline}`).toContain(line);
    expect((await liveFileDrift(engine, f.id, SLUG)).reason).toBe('agrees');
  });
}), 180_000);

test('a file written with #7738\'s empty sentinel over the same row still holds the page', () => isolated(async engine => {
  const f = await fixture(engine, { compiled_truth: folded() }, undefined, true);
  expect(await fileMatchesSnapshot(engine, SLUG, readFileSync(f.file, 'utf8'), f.stored, `${SLUG}.md`)).toBe(true);
}), 180_000);

test('placement plus an ordinary frontmatter key that drifted lands like #8109, and the file keeps its key', () => isolated(async engine => {
  const probe = await fixture(engine, { compiled_truth: folded() });
  const f = await fixture(engine, { compiled_truth: folded() }, { compiled_truth: folded(), frontmatter: { ...probe.stored.page.frontmatter, nickname: 'Al' } });
  await f.local(async () => {
    expect((await liveFileDrift(engine, f.id, SLUG)).reason).toBe('file_database_drift');
    expect(await remember(f.ctx, 'Reads synthetic newsletters.')).toMatchObject({ status: 'inserted', state: 'committed' });
    expect(parseMarkdown(readFileSync(f.file, 'utf8'), SLUG).frontmatter.nickname).toBe('Al');
  });
}), 180_000);

const extra = '- **2026-03-01** | call — A line only one side holds.';
for (const [name, database, file] of [
  ['the database holds a timeline line the file lacks', folded([...BULLETS, extra]), folded()],
  ['the file holds a timeline line the database lacks', folded(), folded([...BULLETS, extra])],
  ['one timeline line reads differently', folded([BULLETS[0]!, BULLETS[1]!.replace('follow-up', 'reminder')]), folded()],
  ['the prose differs', folded(BULLETS, 'Alice Example is a different synthetic person.'), folded()],
] as const) {
  test(`still drift when ${name}: the write refuses and both copies stay as they were`, () => isolated(async engine => {
    const f = await fixture(engine, { compiled_truth: database }, { compiled_truth: file });
    const before = readFileSync(f.file, 'utf8');
    expect(await fileMatchesSnapshot(engine, SLUG, before, f.stored, `${SLUG}.md`)).toBe(false);
    await f.local(async () => {
      expect((await liveFileDrift(engine, f.id, SLUG)).reason).toBe('file_database_drift');
      await expect(remember(f.ctx, 'A fact that must wait.')).rejects.toMatchObject({ writeError: 'source_changed' });
    });
    expect(readFileSync(f.file, 'utf8')).toBe(before);
    expect((await engine.readPageSnapshot(SLUG, { sourceId: f.id }))!.revision).toBe(f.stored.revision);
  }), 180_000);
}

test('a file_drift hold an earlier release wrote is screened again only when someone asks (a plain sync never imports over it, strict sources included)', () => {
  const hold = (drift_version: number, side?: string) => ({ code: 'file_drift', meta: { recovery_version: RECOVERY_VERSION, sides: side ?? 'database', ...(side ? { side } : {}), drift_version } }) as never;
  expect(FILE_DRIFT_VERSION).toBe(3);
  for (const side of [undefined, 'both', 'unknown']) {
    expect(holdRescreenDue(hold(3, side), false)).toBe(false);
    expect(holdRescreenDue(hold(3, side), true)).toBe(true);
  }
});

const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const raw = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ path: string; code: string }>(
  "SELECT completed_keys->0->>'path' AS path, completed_keys->0->>'code' AS code FROM op_checkpoints WHERE op='sync-hold' ORDER BY 1"));
const setup = (content: string) => ({ root }: { root: string }) => {
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'people'), { recursive: true }); writeFileSync(join(root, `${SLUG}.md`), content);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'first');
};
const retry = async (engine: BrainEngine) => {
  const [source] = await engine.executeRaw<{ i: string }>("SELECT incarnation::text AS i FROM sources WHERE id='default'");
  await requestGitHoldRetry(engine, 'default', source!.i, [`${SLUG}.md`]);
};
const opts = (backend: string) => ({ ...(backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {}), setup: setup(SOURCE) });

for (const backend of testBackends()) {
  test(`${backend}: sync imports the next edit of a page whose row holds its timeline in the body, and holds one whose row really differs`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await raw(engine, "UPDATE pages SET compiled_truth=$1, timeline='', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$2", [folded(), SLUG]);
    writeFileSync(join(root, `${SLUG}.md`), SOURCE.replace(BULLETS[1]!, `${BULLETS[1]}\n${extra}`)); git(root, 'commit', '-qam', 'edit');
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([]);
    expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page.timeline).toContain(extra);

    await raw(engine, "UPDATE pages SET compiled_truth=$1, timeline='', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$2",
      [folded([...BULLETS, extra, '- **2026-04-01** | note — Only the database holds this.']), SLUG]);
    writeFileSync(join(root, `${SLUG}.md`), `${readFileSync(join(root, `${SLUG}.md`), 'utf8')}- **2026-05-01** | call — A later file edit.\n`); git(root, 'commit', '-qam', 'edit again');
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([{ path: `${SLUG}.md`, code: 'file_drift' }]);

    // The row now differs from the file only in the split, and the hold names the page's current revision (as on a brain
    // whose page has not moved since its hold). A plain sync leaves the hold; a retry (sources retry-held) re-screens it, and the file imports.
    const later = '- **2026-05-01** | call — A later file edit.';
    await raw(engine, "UPDATE pages SET compiled_truth=$1 WHERE source_id='default' AND slug=$2", [folded([...BULLETS, extra, later]), SLUG]);
    await raw(engine, "UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,meta,page_revision}', to_jsonb((SELECT knowledge_revision::text FROM pages WHERE source_id='default' AND slug=$1))) WHERE op='sync-hold'", [SLUG]);
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([{ path: `${SLUG}.md`, code: 'file_drift' }]);
    await retry(engine);
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([]);
    expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page.timeline).toContain(later);
  }, opts(backend)), 240_000);

  test(`${backend}: a page whose file moved ahead in the body imports only when the row still holds the file's last import; lines on both sides stay held with both copies kept`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    const path = join(root, `${SLUG}.md`);
    const row = async () => { const s = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!; return { compiled_truth: s.page.compiled_truth, timeline: s.page.timeline }; };
    // The file gains body lines; the row still holds the last import, its timeline in the body: the file's lines import, every bullet kept.
    const fileLine = 'A paragraph the file gained after its last import.';
    await raw(engine, "UPDATE pages SET compiled_truth=$1, timeline='', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$2", [folded(), SLUG]);
    writeFileSync(path, SOURCE.replace(PROSE, `${PROSE}\n\n${fileLine}`)); git(root, 'commit', '-qam', 'file ahead');
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([]);
    const imported = await row();
    for (const line of [PROSE, fileLine, ...BULLETS]) expect(`${imported.compiled_truth}\n${imported.timeline}`).toContain(line);

    // Both sides now hold a line the other lacks: held, and neither copy changes, before and after a retry re-screens the hold.
    const dbLine = 'A paragraph only the database holds.';
    await raw(engine, "UPDATE pages SET compiled_truth=$1, timeline='', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$2",
      [folded(BULLETS, `${PROSE}\n\n${fileLine}\n\n${dbLine}`), SLUG]);
    const secondLine = 'Another paragraph only the file holds.';
    writeFileSync(path, readFileSync(path, 'utf8').replace(fileLine, `${fileLine}\n\n${secondLine}`)); git(root, 'commit', '-qam', 'both ahead');
    const before = { file: readFileSync(path, 'utf8'), row: await row() };
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([{ path: `${SLUG}.md`, code: 'file_drift' }]);
    await retry(engine);
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([{ path: `${SLUG}.md`, code: 'file_drift' }]);
    expect({ file: readFileSync(path, 'utf8'), row: await row() }).toEqual(before);
    expect(before.row.compiled_truth).toContain(dbLine);
  }, opts(backend)), 240_000);

  test(`${backend}: a database-side hold (file unchanged since its import) previews release_hold only when the split alone differs; the release keeps every line, and a row that really differs stays held with both copies kept`, () => managedBrain(async ({ engine, root }) => {
    await registerLocalWriter(engine, 'cli');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    const path = join(root, `${SLUG}.md`);
    const rowBody = async () => (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page.compiled_truth;
    // The hold an earlier release wrote when only the database had moved since the import, at the page's current revision.
    const seedHold = async () => {
      await raw(engine, "DELETE FROM op_checkpoints WHERE op='sync-hold'");
      const [row] = await engine.executeRaw<{ id: string; revision: string; incarnation: string }>(`SELECT p.id::text AS id, p.knowledge_revision::text AS revision,
        s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='default' AND p.slug=$1`, [SLUG]);
      await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: row!.incarnation, path: `${SLUG}.md`, source_path: `${SLUG}.md`, slug: SLUG,
        page_id: Number(row!.id), code: 'file_drift', message: `${SLUG}.md is held: file drift (database)`, upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
        meta: { recovery_version: RECOVERY_VERSION, sides: 'database', attempts: 1, drift_version: 3, page_revision: row!.revision, blob_oid: git(root, 'rev-parse', `HEAD:${SLUG}.md`) } }));
    };
    type Plan = { preview_hash?: string; listing?: Array<{ item: string; class: string }>; outcomes?: Record<string, number>; pages?: Array<{ slug: string; would: string }> };
    const repair = (options: Record<string, unknown>) => withVerifiedLocalRegistration(engine, registration, async () => (await repairRunner(engine, { apply: options.expect !== undefined, logger: { info() {}, warn() {}, error() {} } }))
      .run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...options })) as Promise<Plan>;
    // The read-only comparison of the held pages, then the release a release_hold verdict names: --slug with --prefer file.
    const compared = async () => JSON.stringify(await repair({ held: true }));
    const preview = (expect?: string) => repair({ slugs: [SLUG], prefer: 'file', ...(expect ? { expect } : {}) });
    const registration = await registerLocalWriter(engine, 'cli');
    const classes = (plan: Awaited<ReturnType<typeof preview>>) => (plan.listing ?? []).map(row => row.class);

    await raw(engine, "UPDATE pages SET compiled_truth=$1, timeline='', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$2",
      [folded(BULLETS.slice(0, 1), 'Alice Example is a synthetic person, rewritten in the database.'), SLUG]);
    await seedHold();
    const before = { file: readFileSync(path, 'utf8'), row: await rowBody() };
    expect(await compared()).not.toContain('release_hold');
    expect(classes(await preview())).not.toContain('release_hold');
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([{ path: `${SLUG}.md`, code: 'file_drift' }]);
    // Asked to re-screen anyway (sources retry-held), its guarded import refuses: held again, neither copy changes.
    await retry(engine);
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([{ path: `${SLUG}.md`, code: 'file_drift' }]);
    expect({ file: readFileSync(path, 'utf8'), row: await rowBody() }).toEqual(before);

    await raw(engine, "UPDATE pages SET compiled_truth=$1, timeline='', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$2", [folded(), SLUG]);
    await seedHold();
    expect(await compared()).toContain('"release_hold"');
    const ready = await preview();
    expect(classes(ready)).toEqual(['release_hold']);
    expect((await preview(ready.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    await performManagedSync(engine, SYNC);
    expect(await holds(engine)).toEqual([]);
    const page = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page;
    for (const line of [PROSE, ...BULLETS]) expect(`${page.compiled_truth}\n${page.timeline}`).toContain(line);
    expect(readFileSync(path, 'utf8')).toBe(SOURCE);
  }, opts(backend)), 240_000);
}
