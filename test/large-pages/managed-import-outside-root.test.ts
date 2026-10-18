/**
 * Wave B PR 2 lane 2r: a managed import of a Markdown file over the
 * single-string ceiling from outside its source root.
 *
 * 1. Protects: with `pages.segmented_storage` on, such a file is refused
 *    (`invalid_params`, message prefix `File too large (`) with a message that
 *    itself says to move it into the source root and names the target path
 *    (`gbrain import` prints only the message), and a fix the user runs after
 *    moving it (`gbrain import <target> --source <id>`). Nothing is imported.
 *    The same file inside the root imports.
 * 2. Fails when: the refusal says only "File too large (max N bytes)." and
 *    hides the move in the suggestion.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-outside-root-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const content = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 61 });

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function fixture(engine: BrainEngine) {
  const sourceId = `outside-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'notes'), { recursive: true });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root };
}

test('a file over the ceiling from outside the root is refused with the move in the message and a fix', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    const f = await fixture(engine);
    const outside = join(home, `${f.sourceId}-outside`);
    mkdirSync(outside, { recursive: true });
    const file = join(outside, 'big.md');
    writeFileSync(file, content);
    const target = join(f.root, 'notes/big.md');
    let error: unknown;
    try { await importManagedFile(engine, file, 'notes/big.md', { sourceId: f.sourceId, noEmbed: true }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(OperationError);
    const e = error as OperationError;
    expect(e.code).toBe('invalid_params');
    expect(e.message.startsWith('File too large (')).toBe(true);
    expect(e.message).toContain(`${Buffer.byteLength(content)} bytes, max ${PAGE_MAX_BYTES}`);
    expect(e.message).toContain('imports only from its place inside the source root');
    expect(e.message).toContain(`Move it to ${target} and import it there.`);
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'import', target, '--source', f.sourceId], actor: 'user' });
    expect(e.fix?.user_message).toContain(`Move ${file} to ${target}`);
    expect(await engine.getPage('notes/big', { sourceId: f.sourceId })).toBeNull();
    renameSync(file, target);
    expect(await importManagedFile(engine, target, 'notes/big.md', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ slug: 'notes/big', status: 'imported' });
  }
}), 600_000);
