/**
 * Ontology reads follow fact visibility (eval wave N1-3).
 *
 * An ontology observation is a `facts` row, so an untrusted caller sees only
 * `visibility = 'world'` rows, exactly like recall and the hot-memory block.
 * The filter applies before per-dimension resolution, so a remote caller
 * resolves the newest world value instead of a private one or a hole. Trusted
 * local callers keep every tier.
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';

function ctxOf(remote: boolean | undefined): OperationContext {
  return {
    engine, config: {} as never, dryRun: false, remote: remote as boolean, transport: 'stdio', sourceId: 'default',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as OperationContext;
}
const run = (name: string, remote: boolean | undefined, p: Record<string, unknown>) =>
  operationsByName[name].handler(ctxOf(remote), p) as Promise<unknown>;
const values = (rows: unknown) => (rows as Array<{ dimension: string; value: string }>).map(r => `${r.dimension}=${r.value}`).sort();

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await run('ontology_propose', false, { entity: ALICE, dimension: 'risk_tolerance', value: 'high privmarker', visibility: 'private' });
  await run('ontology_propose', false, { entity: ALICE, dimension: 'decision_style', value: 'deliberate', visibility: 'world' });
  // Backdated second write: both rows stay open, the private one is newer.
  await run('ontology_propose', false, { entity: BOB, dimension: 'role', value: 'founder privmarker', source: 'notes/b', valid_from: '2026-01-01', visibility: 'private' });
  await run('ontology_propose', false, { entity: BOB, dimension: 'role', value: 'advisor', source: 'notes/a', valid_from: '2025-01-01', visibility: 'world' });
}, 60_000);

describe('ontology reads hide private observations from untrusted callers', () => {
  test('ontology_get: remote gets world rows only; local keeps every tier', async () => {
    for (const remote of [true, undefined]) {
      expect(values(await run('ontology_get', remote, { entity: ALICE }))).toEqual(['decision_style=deliberate']);
    }
    expect(values(await run('ontology_get', false, { entity: ALICE }))).toEqual(['decision_style=deliberate', 'risk_tolerance=high privmarker']);
  });

  test('ontology_get: remote resolves the newest world value, not the newer private one', async () => {
    expect(values(await run('ontology_get', true, { entity: BOB }))).toEqual(['role=advisor']);
    expect(values(await run('ontology_get', false, { entity: BOB }))).toEqual(['role=founder privmarker']);
  });

  test('ontology_conflicts: a disagreement that needs a private row is not reported remotely', async () => {
    await run('ontology_propose', false, { entity: BOB, dimension: 'location', value: 'Lisbon', source: 'notes/c', valid_from: '2026-02-01', visibility: 'world' });
    await run('ontology_propose', false, { entity: BOB, dimension: 'location', value: 'Porto privmarker', source: 'notes/d', valid_from: '2025-02-01', visibility: 'private' });
    const remote = await run('ontology_conflicts', true, {});
    expect(JSON.stringify(remote)).not.toContain('privmarker');
    const local = await run('ontology_conflicts', false, {}) as Array<{ entity_slug: string; dimension: string }>;
    expect(local.map(c => `${c.entity_slug}:${c.dimension}`)).toContain(`${BOB}:location`);
  });

  test('volunteer_chronicle: remote ontologies carry no private observation', async () => {
    const remote = await run('volunteer_chronicle', true, { entities: `${ALICE},${BOB}` }) as { ontologies: Record<string, unknown> };
    expect(JSON.stringify(remote.ontologies)).not.toContain('privmarker');
    expect(values(remote.ontologies[ALICE])).toEqual(['decision_style=deliberate']);
    expect(values(remote.ontologies[BOB])).toEqual(['role=advisor']);
    const local = await run('volunteer_chronicle', false, { entities: ALICE }) as { ontologies: Record<string, unknown> };
    expect(JSON.stringify(local.ontologies)).toContain('privmarker');
  });

  test('MCP dispatch: the remote transport tier gets world rows only, the local tier every tier', async () => {
    const viaDispatch = async (remote: boolean) => {
      const r = await dispatchToolCall(engine, 'ontology_get', { entity: ALICE }, { remote, sourceId: 'default', transport: remote ? 'stdio' : undefined });
      expect(r.isError).toBeFalsy();
      return values(JSON.parse(r.content[0].text));
    };
    expect(await viaDispatch(true)).toEqual(['decision_style=deliberate']);
    expect(await viaDispatch(false)).toEqual(['decision_style=deliberate', 'risk_tolerance=high privmarker']);
  });
});
