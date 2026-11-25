/**
 * Engine parity for the default preview of `gbrain repair visibility` (every class: facts, events, aliases, lineage),
 * which `gbrain repair --all` and `doctor --remediate` run on every brain.
 *
 * - An empty brain previews nothing, the same on every arm.
 * - An atom and a Life Chronicle event of a private origin, and a page private by a privacy alias alone, are listed the
 *   same on every arm, with the open twin in another source.
 * - The apply of those page items stops on Rust by name at `repair visibility page write`, before any write: the page's
 *   frontmatter is unchanged. PGLite and Postgres apply them.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'));
}
async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-visibility-default-'));
  try { return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
const preview = async (engine: BrainEngine) =>
  shape(await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run('visibility', await resolveRepairScope(engine), { explicit: true }));
const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') => ({ type: type as 'note', title, compiled_truth: `${title} body.`, timeline: '', frontmatter });

describe('engine parity: gbrain repair visibility default preview', () => {

  parityTest('visibility default preview (all classes) on an empty brain answers the same on every arm', {
    methods: ['listWorldFactsFromPrivateSources', 'listConceptLineageRows'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    const out = await preview(engine);
    expect(out.affected).toBe(0);
    return out;
  }));

  parityTest('visibility default preview lists an atom, a chronicle event and an alias-only page of a private origin, and the open twin, the same on every arm', {
    methods: ['putPage', 'insertSource', 'listWorldFactsFromPrivateSources', 'listConceptLineageRows'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await engine.putPage('notes/origin', note('Origin', { visibility: 'private' }), { sourceId: 'default' });
    await engine.putPage('notes/aliased', note('Aliased', { access: 'private' }), { sourceId: 'default' });
    await engine.putPage('atoms/one', note('Atom', { source_slug: 'notes/origin', visibility: 'world' }, 'atom'), { sourceId: 'default' });
    await engine.putPage('events/one', note('Event', { captured_via: 'life-chronicle:example', event: { depth: 'notes/origin' } }, 'event'), { sourceId: 'default' });
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
    await engine.putPage('notes/aliased', note('Twin', { visibility: 'world' }), { sourceId: 'other-example' });
    const out = await preview(engine);
    const listed = (out.listing as Array<{ item: string }>).map(entry => entry.item).sort();
    expect(listed).toEqual(['default:atoms/one', 'default:events/one', 'default:notes/aliased'].sort());
    expect((out.residuals as Record<string, number>).open_twins).toBe(1);
    return out;
  }));
  parityTest('visibility apply of the page items stops on Rust only at the page write, and writes nothing there', {
    methods: ['putPage', 'listWorldFactsFromPrivateSources', 'listConceptLineageRows'], requires: 'raw_sql', timeout: 90_000,
  }, async (engine, backend) => withHome(async () => {
    await engine.putPage('notes/origin', note('Origin', { visibility: 'private' }), { sourceId: 'default' });
    await engine.putPage('notes/aliased', note('Aliased', { access: 'private' }), { sourceId: 'default' });
    const previewed = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run('visibility', await resolveRepairScope(engine), { explicit: true });
    try {
      const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('visibility', await resolveRepairScope(engine), { explicit: true, expect: previewed.preview_hash });
      return shape(applied);
    } catch (err) {
      if (backend === 'rust') {
        const text = JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });
        const page = await engine.getPage('notes/aliased', { sourceId: 'default' });
        expect(text).toContain('repair visibility page write');
        expect(page?.frontmatter).toEqual({ access: 'private' });
      }
      throw err;
    }
  }));
});
