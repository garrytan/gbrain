/**
 * GBRA-631: engine graduation (PGLite to Postgres) carries the owner's duplicate decisions. On a brain with no repository
 * the entity_identity_reviews rows are the only record of a confirm or a reject, so a graduation that dropped them would
 * lose the decision. After graduation the confirmed pair is still one identity that rank_entities counts once, and the
 * rejected pair is still recorded as different people.
 * Fails when: the target has no decision rows, the confirm's identity rows are missing, or rank_entities counts the
 * confirmed person twice.
 * Run: DATABASE_URL=... bun test test/e2e/graduation-identity-decisions.test.ts
 */
import { describe, expect } from 'bun:test';
import { DATABASE_URL, gbrain, graduationTest } from '../helpers/graduation-e2e.ts';
import { useGraduationCases } from '../helpers/graduation-cli-cases.ts';
import { planAndRun, withSource, withTarget } from '../helpers/graduation-scenarios.ts';
import { decisionId } from '../../src/core/entities/identity-decisions.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { fresh } = useGraduationCases();

const alice = [{ source_id: 'default', slug: 'people/alice-example-grad' }, { source_id: 'source-g', slug: 'people/alice-example-grad' }];
const bob = [{ source_id: 'default', slug: 'people/bob-sample-grad' }, { source_id: 'source-g', slug: 'people/bob-sample-grad' }];

async function rank(engine: BrainEngine): Promise<Array<[string, string, number]>> {
  const ctx = { engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false } as unknown as OperationContext;
  const r = await operations.find(o => o.name === 'rank_entities')!.handler(ctx, { types: ['person'] }) as { entities: Array<{ slug: string; source_id: string; inbound: number }> };
  return r.entities.filter(e => e.slug === 'people/alice-example-grad').map(e => [e.source_id, e.slug, e.inbound]);
}

async function decisions(engine: BrainEngine) {
  const read = await engine.listIdentityDecisions();
  const identities = await engine.executeRaw<{ source_id: string; slug: string; established_by: string; canonical: boolean }>(
    `SELECT ei.source_id, p.slug, ei.established_by, ei.canonical FROM entity_identities ei JOIN pages p ON p.id = ei.page_id ORDER BY ei.source_id, p.slug`);
  return { decisions: read.decisions.map(d => [d.verdict, d.decision_id, d.origin]).sort(), identities };
}

describe.skipIf(!DATABASE_URL)('graduation carries duplicate decisions', () => {
  graduationTest('a confirmed and a rejected group survive graduation, and the confirmed person still counts once', async () => {
    const c = await fresh('identity-decisions');
    const before = await withSource(c.fx, async engine => {
      await engine.initSchema();
      await engine.executeRaw(`SELECT set_config('gbrain.topology_change', 'on', false), set_config('gbrain.write_sources', '["source-g","default"]', false)`);
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-g', 'source-g')`);
      const insert = async (slug: string, src: string, type: string) => Number((await engine.executeRaw<{ id: number }>(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1, $2, $3, $2, 'Made-up page.') RETURNING id`, [src, slug, type]))[0]!.id);
      const ids: Record<string, number> = {};
      for (const m of [...alice, ...bob]) ids[`${m.source_id}:${m.slug}`] = await insert(m.slug, m.source_id, 'person');
      const notes = [await insert('notes/dedupe-grad-n1', 'default', 'note'), await insert('notes/dedupe-grad-n2', 'source-g', 'note')];
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'references'), ($3, $4, 'references')`,
        [notes[0], ids['default:people/alice-example-grad'], notes[1], ids['source-g:people/alice-example-grad']]);
      await engine.applyIdentityDecisions({ upsert: [
        { decision_id: decisionId(alice), verdict: 'same', members: alice, group_id: null, entity_id: 'alice-joined', canonical: alice[0]!,
          decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null },
        { decision_id: decisionId(bob), verdict: 'different', members: bob, group_id: null, entity_id: null, canonical: null,
          decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null },
      ] } as never);
      const state = await decisions(engine);
      expect(await rank(engine)).toEqual([['default', 'people/alice-example-grad', 2]]);
      return state;
    });
    expect(before.decisions).toHaveLength(2);
    expect(before.identities.map(r => [r.source_id, r.established_by, r.canonical])).toEqual([['default', 'dedupe:confirm', true], ['source-g', 'dedupe:confirm', false]]);
    const { argv, env } = await planAndRun(c);
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    const after = await withTarget(c.target.url, async engine => ({ ...(await decisions(engine)), rank: await rank(engine) }));
    expect({ decisions: after.decisions, identities: after.identities }).toEqual(before);
    expect(after.rank).toEqual([['default', 'people/alice-example-grad', 2]]);
  }, 1_200_000);
});
