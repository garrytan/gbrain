/**
 * #8848: a doctor check must not send the operator to a repair whose preview then reports nothing to repair.
 *
 * 1. Protects: derived_visibility counts only what `gbrain repair visibility` previews: pages on active sources.
 *    A synthesized concept with no visibility on an archived source is neither counted nor previewed.
 * 2. Fails when: the check counts rows the repair's scope (every active source) never reads, so the advice it
 *    prints leads to a 0-item preview.
 * 3. No production seam: PGLite, the real check and the real repair preview.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

const ctx = () => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} },
  dryRun: false, remote: false, sourceId: 'default' }) as never;

test('derived_visibility ignores an archived source, as the repair preview does', async () => {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT (id) DO NOTHING");
  await engine.putPage('concepts/idea-a', { type: 'concept', title: 'Idea A', compiled_truth: 'An idea.', frontmatter: { synthesized_by: 'cycle' } } as never, { sourceId: 'source-a' });
  await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'source-a'");
  const preview = await runRepair(ctx(), visibilityRepair, await resolveRepairScope(engine), { apply: false });
  expect(preview.affected).toBe(0);
  const check = await derivedVisibilityCheck(engine);
  expect(check.status, check.message).toBe('ok');
});
