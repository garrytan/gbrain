import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { commitFile, git } from './helpers/worktree-refresh-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const FACTS_BEGIN = '<!--- gbrain:facts:begin -->';
const FACTS_END = '<!--- gbrain:facts:end -->';
const FACTS_HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|---|---|---|---|---|---|---|---|---|';
const upstreamBytes = `---\ntitle: Example\n---\nA synthetic page.\n\n${FACTS_BEGIN}\n${FACTS_HEADER}\n`
  + '| 1 | An example entity partners with an example vendor | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n'
  + `${FACTS_END}\n`;
const home = mkdtempSync(join(tmpdir(), 'gbrain-mirror-path-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('managed sync leaves another source mirror checkout unchanged while normalizing its page in the database', async () => {
  const path = 'notes/example.md';
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const root = join(home, 'content');
    mkdirSync(root);
    git(root, 'init', '-q');
    commitFile(root, path, upstreamBytes, 'upstream page');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    const mirrorId = `mirror-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await engine.executeRaw("UPDATE sources SET local_path=NULL,config=config||'{\"federated\":true}'::jsonb WHERE id='default'");
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
      [mirrorId, root, JSON.stringify({ mirror_read_only: true })]);
    await engine.setConfig('sync.repo_path', root);
    await engine.setConfig('sync.write_through', 'false');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    const result = await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });

    expect(result).toMatchObject({ status: 'first_sync', added: 1, fences_normalized: { count: 1 } });
    expect(await engine.executeRaw('SELECT kind FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=1',
      ['default', 'notes/example'])).toEqual([{ kind: 'fact' }]);
    expect(readFileSync(join(root, path), 'utf8')).toBe(upstreamBytes);
    expect(git(root, 'status', '--porcelain', '--', path)).toBe('');
  });
}, 120_000);
