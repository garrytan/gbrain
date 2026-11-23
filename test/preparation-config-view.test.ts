/**
 * The preparation config view (src/core/persistence/config-snapshot.ts preparationConfigView) answers the typed
 * stored-config read from the values it captured.
 *
 * 1. Protects: a write's preparation reads `sync.admission` through `readStoredConfigValue` (sync-admission.ts
 *    readSyncAdmission). Inside a preparation view that read gives the value captured when preparation started, and a
 *    key that was absent then stays absent, whatever the stored config does in the meantime.
 * 2. Fails when: the view stops intercepting `readStoredConfigValue`, so the read goes live to the engine and a
 *    preparation sees a config change made after it started.
 * 3. Existing coverage: the batch tests exercise page-mutations.ts batchSharedReads, another proxy; no test read the
 *    typed member through this view.
 * 4. Seam: none. A real PGLite engine; the stored config is changed through the engine itself.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { preparationConfigView } from '../src/core/persistence/config-snapshot.ts';

let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('readStoredConfigValue in a preparation view keeps the captured value and the captured absence', async () => {
  await engine.setConfig('test.view_present', 'captured');
  await engine.unsetConfig('test.view_absent');
  const view = await preparationConfigView(engine);
  await engine.setConfig('test.view_present', 'changed later');
  await engine.setConfig('test.view_absent', 'added later');
  expect(await view.readStoredConfigValue('test.view_present')).toBe('captured');
  expect(await view.readStoredConfigValue('test.view_absent')).toBeNull();
  // Control: the engine itself reads the stored rows.
  expect(await engine.readStoredConfigValue('test.view_present')).toBe('changed later');
  expect(await engine.readStoredConfigValue('test.view_absent')).toBe('added later');
  await engine.unsetConfig('test.view_present');
  await engine.unsetConfig('test.view_absent');
});
