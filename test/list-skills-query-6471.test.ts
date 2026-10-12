/**
 * #6471 (wave 15 P7.6): `list_skills query` ranks the version 1 host catalog
 * by lexical token overlap over each skill's name, triggers and description,
 * drops skills that match nothing, caps the list at `limit` (default 10) and
 * annotates each kept skill with `match`. Without `query` the response is
 * byte-identical to before. On the shared catalogs (`schema_version: 2`, or an
 * active shared catalog on a version 1 call) `query` is refused with
 * `invalid_params` before any catalog read, never silently ignored.
 *
 * Protects: the ranked order, the drop of zero-score skills, the unchanged
 * no-query bytes and the shared-catalog refusal. Fails when: ranking stops
 * reading descriptions (the query below shares no trigger words), when the
 * no-query shape changes, or when a shared catalog starts ignoring `query`.
 * Why new: `test/skill-catalog.test.ts` covers the unranked catalog only.
 * Seam: none; the ranking is a pure function of the catalog.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildSkillCatalog } from '../src/core/skill-catalog.ts';
import { skillsCatalogOperations } from '../src/core/ops/skills-catalog.ts';
import type { OperationContext } from '../src/core/operations.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'skill-catalog-query', 'skills');
const listSkills = skillsCatalogOperations.find(op => op.name === 'list_skills')!;

function stubCtx(remote: boolean, scopes?: string[]): OperationContext {
  return {
    remote,
    auth: scopes ? { token: 't', clientId: 'c', scopes } : undefined,
    config: {} as OperationContext['config'],
    engine: null as unknown as OperationContext['engine'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    sourceId: 'default',
  } as OperationContext;
}

describe('buildSkillCatalog with query (#6471)', () => {
  test('ranks by description overlap when the query shares no trigger words; zero-match skills are dropped', () => {
    const ranked = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: 'open loops and recent threads with a person' });
    expect(ranked.skills.map(s => s.name)).toEqual(['meeting-prep']);
    expect(ranked.count).toBe(1);
    expect(ranked.skills[0].match).toEqual({ score: expect.any(Number), matched_on: 'description' });
    expect(ranked.skills[0].match!.score).toBeGreaterThan(0);
  });

  test('a trigger phrase contained in the query outranks a description-only match', () => {
    const ranked = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: 'write a deal memo about the founder history before the meeting' });
    expect(ranked.skills.map(s => s.name)).toEqual(['deal-memo', 'meeting-prep']);
    expect(ranked.skills[0].match!.matched_on).toBe('trigger');
    expect(ranked.skills[0].match!.score).toBeGreaterThan(ranked.skills[1].match!.score);
  });

  test('RESOLVER.md triggers count, name tokens count, and limit caps the ranked list', () => {
    const byResolver = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: 'who am I meeting today' });
    expect(byResolver.skills[0]).toMatchObject({ name: 'meeting-prep', match: { matched_on: 'trigger' } });
    const byName = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: 'inbox' });
    expect(byName.skills.map(s => s.name)).toEqual(['inbox-zero']);
    const capped = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: 'memo meeting inbox', limit: 1 });
    expect(capped.skills).toHaveLength(1);
    expect(capped.count).toBe(1);
  });

  test('without query the catalog is byte-identical to the unranked build (no match field, name order, full count)', () => {
    const plain = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config');
    const withEmpty = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: '   ' });
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(plain));
    expect(plain.skills.map(s => s.name)).toEqual(['deal-memo', 'inbox-zero', 'meeting-prep']);
    expect(plain.skills.every(s => !('match' in s))).toBe(true);
    expect(plain.count).toBe(3);
  });

  test('section filtering runs before ranking', () => {
    const ranked = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: 'meeting memo inbox', section: 'no-such-section' });
    expect(ranked.skills).toEqual([]);
  });

  test('a query that matches nothing returns an empty ranked list, not the whole catalog', () => {
    const ranked = buildSkillCatalog(stubCtx(true, ['read']), FIXTURE, 'config', { query: 'zxqv plorth' });
    expect(ranked.skills).toEqual([]);
    expect(ranked.count).toBe(0);
  });
});

describe('list_skills query over the operation (#6471)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('mcp.publish_skills', 'true');
    await engine.setConfig('mcp.skills_dir', FIXTURE);
  });
  const ctx = (): OperationContext => ({
    engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: true,
    auth: { token: 't', clientId: 'c', scopes: ['read'] } as never, sourceId: 'default',
  });

  test('host catalog: query ranks, no query stays byte-identical', async () => {
    const plain = await listSkills.handler(ctx(), {}) as { skills: Array<{ name: string }> };
    const again = await listSkills.handler(ctx(), {}) as unknown;
    expect(JSON.stringify(again)).toBe(JSON.stringify(plain));
    expect(plain.skills.map(s => s.name)).toEqual(['deal-memo', 'inbox-zero', 'meeting-prep']);
    const ranked = await listSkills.handler(ctx(), { query: 'open loops and recent threads with a person' }) as { skills: Array<{ name: string; match?: unknown }> };
    expect(ranked.skills.map(s => s.name)).toEqual(['meeting-prep']);
    expect(ranked.skills[0].match).toMatchObject({ matched_on: 'description' });
  });

  test('schema_version 2 with query is refused invalid_params before any read', async () => {
    const queries: string[] = [];
    const recording = { ...ctx(), engine: { ...engine, executeRaw: async (sql: string) => { queries.push(sql); return []; } } as unknown as PGLiteEngine };
    await expect(listSkills.handler(recording, { schema_version: 2, query: 'meeting' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(queries).toEqual([]);
  });

  test('an active shared catalog with query is refused invalid_params; the catalog itself is never read', async () => {
    // A brain with skill bundles on: persistence_brain.skill_bundles_enabled is what routes list_skills to the shared catalog.
    const queries: string[] = [];
    const shared = { ...ctx(), engine: {
      getConfig: async (key: string) => (key === 'mcp.publish_skills' ? 'true' : null),
      executeRaw: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM persistence_brain')) return [{ skill_bundles_enabled: true }];
        throw new Error(`shared catalog read reached the engine: ${sql}`);
      },
    } as unknown as PGLiteEngine };
    const error = await listSkills.handler(shared, { query: 'meeting' }).catch((e: unknown) => e) as { code?: string; message?: string };
    expect(error.code).toBe('invalid_params');
    expect(String(error.message)).toContain('query');
    expect(queries.filter(q => !q.includes('FROM persistence_brain'))).toEqual([]);
  });
});
