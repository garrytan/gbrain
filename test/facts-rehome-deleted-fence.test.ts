/**
 * Protects recall after a merge: removed fence rows reach the surviving alias.
 * The old repair skips these rows; existing pageless coverage seeds only
 * database-only facts. Uses the production repair without a new seam.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { factsRehomeRepair } from '../src/core/repair/facts-rehome.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const oldSlug = 'orgs/acme-old-example';
const survivor = 'orgs/acme-example';
const body = (title: string, aliases = '') => `---\ntitle: ${title}\ntype: organization\n${aliases}---\n\n# ${title}\n`;

test('rehome rescues removed fence rows, protects live owners and rejects a revived owner', async () => {
  await importFromContent(engine, oldSlug, body('Acme Old Example'), { noEmbed: true });
  await importFromContent(engine, survivor, body('Acme Example', `aliases:\n  - ${oldSlug}\n`), { noEmbed: true });
  await importFromContent(engine, 'notes/evidence-example', body('Evidence Example'), { noEmbed: true });
  const removed = await engine.insertFact({ fact: 'Acme Example shipped a beta', kind: 'fact', visibility: 'world',
    entity_slug: oldSlug, source: 'chat', context: 'entity relinked from model' }, { source_id: 'default' });
  const protectedFact = await engine.insertFact({ fact: 'Acme Example hired a team', kind: 'fact', visibility: 'world',
    entity_slug: oldSlug, source: 'chat' }, { source_id: 'default' });
  await engine.executeRaw('UPDATE facts SET source_markdown_slug=$2, row_num=1 WHERE id=$1', [removed.id, oldSlug]);
  await engine.executeRaw('UPDATE facts SET source_markdown_slug=$2, row_num=1 WHERE id=$1', [protectedFact.id, 'notes/evidence-example']);
  await engine.softDeletePage(oldSlug, { sourceId: 'default' });
  const ctx: OperationContext = { engine, config: { engine: 'pglite', embedding_disabled: true } as never,
    sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  const scope = await resolveRepairScope(engine);
  // Maintenance stamps write attribution; every claim/provenance field must survive.
  const read = async () => (await engine.executeRaw('SELECT * FROM facts ORDER BY id')).map(row => {
    const { last_write_principal_id, last_write_principal_kind, last_write_request_id, last_written_at, ...claim } = row;
    return claim;
  });
  const before = await read();
  const preview = await runRepair(ctx, factsRehomeRepair, scope, { apply: false, explicit: true });
  expect(preview.affected).toBe(1);
  expect(await read()).toEqual(before);

  // Restoring the fence owner invalidates the approved move.
  await importFromContent(engine, oldSlug, body('Acme Old Example'), { noEmbed: true });
  const stale = await runRepair(ctx, factsRehomeRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash });
  expect(stale.applied).toBe(0);
  expect(await read()).toEqual(before);
  await engine.softDeletePage(oldSlug, { sourceId: 'default' });
  const fresh = await runRepair(ctx, factsRehomeRepair, scope, { apply: false, explicit: true });
  const applied = await runRepair(ctx, factsRehomeRepair, scope, { apply: true, explicit: true, expect: fresh.preview_hash });
  expect(applied.applied).toBe(1);
  expect(await read()).toEqual(before.map(row => Number(row.id) === removed.id
    ? { ...row, entity_slug: survivor, source_markdown_slug: survivor, row_num: null } : row));
  expect((await engine.listFactsByEntity('default', survivor)).map(row => row.id)).toEqual([removed.id]);
  expect(await engine.executeRaw('SELECT id FROM facts WHERE source_markdown_slug=$1', [oldSlug])).toEqual([]);
  expect((await runRepair(ctx, factsRehomeRepair, scope, { apply: false, explicit: true })).affected).toBe(0);
});
