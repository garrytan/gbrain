/**
 * #10286: the first remember with no entity creates memory/unattributed. The page was created with empty frontmatter,
 * so it had no trust_tier marker, and doctor provenance_stamp_drift counted it as marker_missing on a fresh brain.
 *
 * Protects: the holding page a remember creates carries the marker for the tier it is stored at, so the drift scan
 * stays at zero after the first and later saves.
 * Fails when: a fence write that creates the holding page leaves its frontmatter without the writer's marker.
 * Seams: none; the remember operation as the local CLI calls it, on PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { scanProvenanceDrift } from '../src/core/trust/provenance-drift.ts';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let engine: BrainEngine;
const ctx = (): OperationContext => ({ engine, config: { engine: engine.kind } as never, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as OperationContext);
const remember = (fact: string) => operationsByName.remember.handler(ctx(), { fact, provenance: 'install-check', request_id: randomUUID() });
const holding = async () => (await engine.executeRaw<{ marker: string | null; tier: string }>(
  "SELECT frontmatter->>'trust_tier' AS marker, trust_tier AS tier FROM pages WHERE source_id = 'default' AND slug = 'memory/unattributed'"))[0];

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

test('the holding page the first remember creates carries its trust marker, and the drift scan stays at zero (#10286)', async () => {
  expect(await holding()).toBeUndefined();
  await remember('gbrain install check');
  const page = await holding();
  expect(page).toBeDefined();
  expect(page!.marker).toBe(page!.tier);
  expect((await scanProvenanceDrift(engine, 'default')).marker_missing).toBe(0);
  await remember('a second unattributed fact');
  expect((await holding())!.marker).toBe(page!.tier);
  expect((await scanProvenanceDrift(engine, 'default')).marker_missing).toBe(0);
});
