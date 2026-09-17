import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { currentExitCode, setCliExitVerdict, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
  _resetCliExitVerdictForTests();
});
afterEach(async () => {
  await disposePersistenceConsumer(engine);
  rmSync(home, { recursive: true, force: true });
  setCliExitVerdict(0); _resetCliExitVerdictForTests();
});

/** Real source rows, canonical bytes, revisions and journal authority. */
async function seed(sourceId = 'default', body = '') {
  const root = join(home, `${sourceId}-repo`); mkdirSync(root, { recursive: true });
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)
    ON CONFLICT(id) DO UPDATE SET local_path=EXCLUDED.local_path`, [sourceId, root]);
  const content = `---\ntype: note\ntitle: Shared page\n---\n\n# Shared page\n\n${body}`;
  await importFromContent(engine, 'shared/page', content, { sourceId, noEmbed: true });
  const snapshot = (await engine.readPageSnapshot('shared/page', { sourceId }))!;
  const file = join(root, 'shared/page.md'); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  return { root, file, snapshot };
}
async function call(args: string[], source?: string) {
  const logs: string[] = [], errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => logs.push(values.join(' ')));
  const error = spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: source, GBRAIN_BRAIN_ID: 'host', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => runTakes(engine, args));
    return { logs: logs.join('\n'), errors: errors.join('\n'), code: currentExitCode() };
  } finally { log.mockRestore(); error.mockRestore(); }
}
const take = () => renderTakesFence([{ rowNum: 3, claim: 'Current claim', kind: 'take', holder: 'self', weight: 0.8, active: true }]);
const add = (claim: string, root: string, slug = 'shared/page') => ['add', slug, '--claim', claim, '--kind', 'take', '--who', 'self', '--dir', root];

describe('gbrain takes CLI source scoping through the durable coordinator', () => {
  test('GBRAIN_SOURCE selects the matching page and canonical root among identical slugs (#2684)', async () => {
    const other = await seed(); const target = await seed('dept'); const before = readFileSync(other.file, 'utf8');
    const result = await call(add('Dept-scoped claim', target.root), 'dept');
    expect(result).toMatchObject({ code: 0 });
    expect(result.logs).toContain('Added take #1');
    const rows = await engine.executeRaw<{ page_id: number; claim: string }>('SELECT page_id,claim FROM takes');
    expect(rows).toEqual([{ page_id: target.snapshot.page.id, claim: 'Dept-scoped claim' }]);
    expect(readFileSync(target.file, 'utf8')).toContain('Dept-scoped claim');
    expect(readFileSync(other.file, 'utf8')).toBe(before);
    expect((await engine.readPageSnapshot('shared/page', { sourceId: 'default' }))!.revision).toBe(other.snapshot.revision);
  });

  test('no source routing override resolves to the seeded default source', async () => {
    const target = await seed();
    expect((await call(add('Default claim', target.root))).code).toBe(0);
    expect(await engine.executeRaw('SELECT page_id FROM takes')).toEqual([{ page_id: target.snapshot.page.id }]);
    expect(readFileSync(target.file, 'utf8')).toContain('Default claim');
  });

  test('unknown GBRAIN_SOURCE fails without falling back or touching any page', async () => {
    const target = await seed(); const before = readFileSync(target.file, 'utf8');
    const result = await call(add('Should never land', target.root), 'ghost');
    expect(result.code).toBe(1); expect(result.errors).toContain('Source "ghost" not found');
    expect(await engine.executeRaw('SELECT id FROM takes')).toEqual([]);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests')).toEqual([]);
    expect(readFileSync(target.file, 'utf8')).toBe(before);
  });

  test('a conflicting --dir cannot redirect a selected source into another canonical root', async () => {
    const other = await seed(); const target = await seed('dept');
    const result = await call(add('Should never land', other.root), 'dept');
    expect(result.code).toBe(1); expect(result.errors).toContain('directory must match');
    expect(await engine.executeRaw('SELECT id FROM takes')).toEqual([]);
    expect(readFileSync(target.file, 'utf8')).not.toContain('Should never land');
    expect(readFileSync(other.file, 'utf8')).not.toContain('Should never land');
  });

  test('supersede inherits holder and kind from the current canonical row (#2663)', async () => {
    const target = await seed('default', take());
    const result = await call(['supersede', 'shared/page', '--row', '3', '--claim', 'Replacement claim', '--dir', target.root]);
    expect(result.code).toBe(0); expect(result.logs).toContain('Superseded #3 → new #4 on shared/page.');
    const rows = await engine.executeRaw('SELECT row_num,active,superseded_by,kind,holder FROM takes ORDER BY row_num');
    expect(rows).toEqual([{ row_num: 3, active: false, superseded_by: 4, kind: 'take', holder: 'self' },
      { row_num: 4, active: true, superseded_by: null, kind: 'take', holder: 'self' }]);
    expect(readFileSync(target.file, 'utf8')).toContain('Replacement claim');
  });

  test('update of a missing fence row preserves canonical revision and bytes', async () => {
    const target = await seed('default', take()); const before = readFileSync(target.file, 'utf8');
    const result = await call(['update', 'shared/page', '--row', '5', '--weight', '0.9', '--dir', target.root]);
    expect(result.code).toBe(1); expect(result.errors).toContain('Row #5 not found');
    expect(readFileSync(target.file, 'utf8')).toBe(before);
    expect((await engine.readPageSnapshot('shared/page', { sourceId: 'default' }))!.revision).toBe(target.snapshot.revision);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE state='committed'")).toEqual([]);
  });

  test('resolve --outcome true maps to the same correct resolution in the fence and DB', async () => {
    const target = await seed('default', take());
    const result = await call(['resolve', 'shared/page', '--row', '3', '--outcome', 'true', '--dir', target.root]);
    expect(result.code).toBe(0); expect(result.logs).toContain('quality=correct');
    expect(await engine.executeRaw('SELECT resolved_quality,resolved_outcome FROM takes WHERE page_id=$1 AND row_num=3', [target.snapshot.page.id]))
      .toEqual([{ resolved_quality: 'correct', resolved_outcome: true }]);
    expect(readFileSync(target.file, 'utf8')).toContain('correct');
  });

  test('missing page leaves no orphaned Markdown and no committed mutation', async () => {
    const target = await seed();
    const result = await call(add('Orphan claim', target.root, 'missing/page'));
    expect(result.code).toBe(1); expect(result.errors).toMatch(/page.*(?:not found|no longer exists)/i);
    expect(existsSync(join(target.root, 'missing/page.md'))).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM takes')).toEqual([]);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE state='committed'")).toEqual([]);
  });
});
