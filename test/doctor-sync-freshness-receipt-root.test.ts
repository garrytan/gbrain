/**
 * A source whose root a content-setup receipt claims (an owned `--content-root` outside gbrain's own content
 * directory) on a brain whose persistence is off: the writer-owned exemption needs persistence on, and #9471's
 * content-directory exemption covers only roots inside gbrain's own content directory, so sync_freshness still fails
 * it (the graduation verify step relies on that fail). Sync refuses the source with `sync_not_applicable`, so the
 * advice names the import that refusal names instead of a `gbrain sync` that cannot run, and that import is accepted.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { runImport } from '../src/commands/import.ts';
import { assertSyncApplicable } from '../src/core/sync-applicability.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { contentSetupKey } from '../src/core/shared-skills/setup.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'gbrain-receipt-root-'));
});

test('a receipt-claimed root on a persistence-off brain still fails, names the import, and that import runs', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const sourceId = 'notes-example', root = join(home, 'content-root-example');
  mkdirSync(root);
  await engine.setConfig('embedding_disabled', 'true');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  const binding = await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  await engine.setConfig(contentSetupKey(sourceId, binding.source_incarnation), JSON.stringify({ version: 1, brain_id: brain!.brain_id,
    source_id: sourceId, source_incarnation: binding.source_incarnation, root, owned_root: true, repository_kind: 'content_directory', status: 'ready', stage: 'complete' }));

  const refusal = await assertSyncApplicable(engine, { sourceId }).then(() => null, (error: unknown) => error instanceof OperationError ? error.code : String(error));
  expect(refusal).toBe('sync_not_applicable');

  for (const localOnly of [true, false]) {
    const check = await checkSyncFreshness(engine, { localOnly, sourceIds: [sourceId] });
    expect(check.status).toBe('fail');
    expect(check.message).toContain(`'${sourceId}': no successful sync recorded`);
    expect(check.message).not.toContain('gbrain sync');
    expect(check.message).toContain(`gbrain import <dir> --no-embed --source ${sourceId}`);
    expect(check.fix?.argv).toEqual(['gbrain', 'import', '<dir>', '--no-embed', '--source', sourceId]);
  }

  const check = await checkSyncFreshness(engine, { localOnly: true, sourceIds: [sourceId] });
  const notes = join(home, 'markdown-example');
  mkdirSync(notes);
  writeFileSync(join(notes, 'alice-example.md'), '---\ntitle: Alice Example\n---\nA note about acme-example.\n');
  const result = await runImport(engine, check.fix!.argv!.slice(2).map(arg => arg === '<dir>' ? notes : arg));
  expect(result).toMatchObject({ imported: 1, errors: 0, failures: [] });
  const [page] = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM pages WHERE slug=$1', ['alice-example']);
  expect(page?.source_id).toBe(sourceId);
}), 120_000);
