/**
 * #7098: `gbrain sources mirror-readonly <id>` (#5409) was honored by managed
 * publication but not by the legacy disk writers. On an unmanaged brain,
 * `sync --full` re-exported never-committed database pages into the mirror's
 * checkout, `brainstorm --save` wrote its page file there, and the fact fence,
 * timeline, unfenced-fact and forget writers rewrote its files, so the mirror
 * gained local changes and its `git pull --ff-only` could stop.
 *
 * Protects: every legacy writer treats a mirror-readonly source like a clone
 * gbrain owns (#6946): the database write lands, the checkout is untouched
 * (no modified or untracked file), and the outcome names `mirror_read_only`.
 * Seams: a plain git checkout registered as a source on an unmanaged brain,
 * imported with the real sync, then flagged with the real `mirror-readonly`
 * command. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMirrorMode } from '../src/commands/sources-mirror.ts';
import { formatSaveOutcome, persistSavedIdea } from '../src/commands/brainstorm.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { deletePageThrough, writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { writeTimelineEntryThrough } from '../src/core/timeline-write-through.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'source-a';
const ALICE = 'people/alice-example';
const ALICE_MD = '---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\nAlice Example works at Acme Example.\n';
const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quiet = async <T>(run: () => Promise<T>): Promise<{ value: T; stderr: string }> => {
  const lines: string[] = [];
  const log = console.log, error = console.error, warn = console.warn, write = process.stderr.write.bind(process.stderr);
  console.log = () => {}; console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); }; console.warn = console.error;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => { lines.push(String(c)); return true; };
  try { return { value: await run(), stderr: lines.join('\n') }; }
  finally { console.log = log; console.error = error; console.warn = warn; process.stderr.write = write; }
};

for (const flavor of ['pglite', ...(databaseUrl ? ['postgres'] : [])] as const) describe(`mirror-readonly legacy disk writers (${flavor})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (flavor === 'postgres') {
      const fixture = await isolatedPersistencePostgres(databaseUrl!);
      engine = fixture.engine; closePostgres = fixture.close;
    } else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    }
  }, 120_000);
  afterAll(async () => { if (closePostgres) await closePostgres(); else await engine?.disconnect(); });

  interface Mirror { root: string; alice: string; status(): string; sync(full?: boolean): Promise<string>; readOnly(): Promise<void> }
  async function withMirror(run: (m: Mirror) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mirror-7098-'));
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        _resetWriteThroughCacheForTest();
        await resetPgliteState(engine as PGLiteEngine);
        const root = join(dir, 'mirror');
        mkdirSync(join(root, 'people'), { recursive: true });
        git(root, ['init', '-q', '-b', 'main']);
        git(root, ['config', 'user.email', 't@example.com']);
        git(root, ['config', 'user.name', 't']);
        writeFileSync(join(root, `${ALICE}.md`), ALICE_MD);
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'initial']);
        await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [SOURCE, root]);
        const m: Mirror = {
          root, alice: join(root, `${ALICE}.md`),
          status: () => git(root, ['status', '--porcelain', '--untracked-files=all']).trim(),
          async sync(full = false) {
            const { performSync } = await import('../src/commands/sync.ts');
            return (await quiet(() => performSync(engine, { sourceId: SOURCE, repoPath: root, noEmbed: true, noExtract: true, noPull: true, full }))).stderr;
          },
          readOnly: async () => { await quiet(() => runMirrorMode(engine, [SOURCE], true)); },
        };
        await m.sync();
        expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1', [SOURCE])).toEqual([{ slug: ALICE }]);
        await run(m);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test('writePageThrough and deletePageThrough skip a mirror-readonly checkout with mirror_read_only', () => withMirror(async m => {
    await m.readOnly();
    expect(await writePageThrough(engine, ALICE, { sourceId: SOURCE })).toEqual({ written: false, skipped: 'mirror_read_only' });
    await importFromContent(engine, 'notes/db-only', '---\ntype: note\ntitle: DB only\n---\n\nOnly in the database.\n', { noEmbed: true, sourceId: SOURCE });
    expect(await writePageThrough(engine, 'notes/db-only', { sourceId: SOURCE, expectedFileBytes: null })).toEqual({ written: false, skipped: 'mirror_read_only' });
    expect(await deletePageThrough(engine, ALICE, { sourceId: SOURCE })).toEqual({ removed: false, skipped: 'mirror_read_only' });
    expect(readFileSync(m.alice, 'utf8')).toBe(ALICE_MD);
    expect(m.status()).toBe('');
  }), 60_000);

  test('sync --full keeps a never-committed database page in the database and out of the mirror', () => withMirror(async m => {
    await importFromContent(engine, 'notes/db-only', '---\ntype: note\ntitle: DB only\n---\n\nOnly in the database.\n', { noEmbed: true, sourceId: SOURCE, sourcePath: 'notes/db-only.md' });
    await m.readOnly();
    const stderr = await m.sync(true);
    expect(existsSync(join(m.root, 'notes/db-only.md'))).toBe(false);
    expect(m.status()).toBe('');
    expect(stderr).not.toContain('re-export failure');
    expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [SOURCE])).toEqual([{ slug: 'notes/db-only' }, { slug: ALICE }]);
  }), 60_000);

  test('brainstorm --save stores the idea database-only and names the mirror', () => withMirror(async m => {
    await m.readOnly();
    const outcome = await persistSavedIdea(engine, { slug: 'ideas/acme-example', content: '---\ntype: idea\ntitle: Acme Example idea\n---\n\nAn idea.\n', sourceId: SOURCE, provenanceVia: 'brainstorm' });
    expect(outcome).toMatchObject({ dbSaved: true, writeThrough: { written: false, skipped: 'mirror_read_only' } });
    expect(existsSync(join(m.root, 'ideas/acme-example.md'))).toBe(false);
    expect(m.status()).toBe('');
    const message = formatSaveOutcome(outcome, { profileLabel: 'brainstorm', slug: 'ideas/acme-example' });
    expect(message.exitCode).toBe(0);
    expect(message.stdout).toContain('read-only mirror');
    expect(message.stdout).not.toContain('file NOT written');
  }), 60_000);

  test('a timeline entry and a fact land database-only and leave the page file alone', () => withMirror(async m => {
    await m.readOnly();
    const timeline = await writeTimelineEntryThrough(engine, ALICE, SOURCE, { date: '2026-10-01', summary: 'Joined Acme Example.' });
    expect(timeline).toMatchObject({ handled: false, skipped: 'mirror_read_only' });
    const fact = await writeSingleFact(engine, SOURCE, { fact: 'Alice Example leads the platform team at Acme Example.', provenance: 'test:7098', entity: ALICE, visibility: 'world', remote: false });
    const [row] = await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE id=$1', [fact.id]);
    expect(row.row_num).toBeNull();
    expect(readFileSync(m.alice, 'utf8')).toBe(ALICE_MD);
    expect(m.status()).toBe('');
  }), 60_000);

  test('forget of a fenced fact expires it in the database without rewriting the mirror file', () => withMirror(async m => {
    const fact = await writeSingleFact(engine, SOURCE, { fact: 'Alice Example leads the platform team at Acme Example.', provenance: 'test:7098', entity: ALICE, visibility: 'world', remote: false });
    expect(readFileSync(m.alice, 'utf8')).toContain('Alice Example leads the platform team');
    git(m.root, ['commit', '-q', '-am', 'fence']);
    const fenced = readFileSync(m.alice, 'utf8');
    await m.readOnly();
    expect(await forgetFactInFence(engine, fact.id, { reason: 'test' })).toMatchObject({ ok: true, path: 'legacy_db' });
    expect((await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [fact.id]))[0].expired).toBe(true);
    expect(readFileSync(m.alice, 'utf8')).toBe(fenced);
    expect(m.status()).toBe('');
  }), 60_000);

  test('unfenced fact rows of a mirror stay database-only, and the extract guard does not count them', () => withMirror(async m => {
    await m.readOnly();
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
      VALUES ($1, $2, 'Alice Example ships the Acme Example search stack.', 'fact', 'world', 'medium', now(), 'test:7098', 1.0)`, [SOURCE, ALICE]);
    const outcome = await fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId: SOURCE }));
    expect(outcome).toMatchObject({ fenced: 0, skipped_mirror_read_only: 1 });
    const result = await runExtractFacts(engine, { sourceId: SOURCE, slugs: [ALICE] });
    expect(result).toMatchObject({ guardTriggered: false, legacyRowsPending: 0, unfencedRowsFenced: 0 });
    expect(readFileSync(m.alice, 'utf8')).toBe(ALICE_MD);
    expect(m.status()).toBe('');
  }), 60_000);
});
