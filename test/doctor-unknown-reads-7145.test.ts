/**
 * #7145: a doctor read that failed, sampled nothing, or stopped at its bound measured nothing, so it reports health
 * unknown (warn) instead of a known verdict: coverage, dangling aliases, the estimated orphan ratio. A sample is named
 * as one (conversation_format_coverage), and a partial frontmatter walk carries its bound in details. PGLite in-memory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkDanglingAliases, checkEntityLinkCoverage, checkTimelineCoverage } from '../src/core/onboard/checks.ts';
import { orphanRatioEntry } from '../src/commands/doctor/checks/graph-health.ts';
import { computeConversationFormatCoverageCheck } from '../src/commands/doctor/checks/conversation-coverage.ts';
import { frontmatterEntry } from '../src/commands/doctor/checks/content-quality.ts';
import { buildQuarantineMarker } from '../src/core/quarantine.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

const progress = new Proxy({}, { get: () => () => undefined });
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

/** The engine with every statement matching `match`, and every typed read named in `members`, failing the way a cancelled statement does. */
function failing(match: RegExp, members: readonly string[] = []): BrainEngine {
  return new Proxy(engine, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof key === 'string' && members.includes(key)) return () => Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
    return (sql: string, params?: unknown[]) => match.test(sql)
      ? Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
      : target.executeRaw(sql, params);
  } }) as BrainEngine;
}

/** The engine with the typed member `member` failing the way a cancelled statement does. */
function failingMember(member: keyof BrainEngine): BrainEngine {
  return new Proxy(engine, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key !== member) return typeof value === 'function' ? value.bind(target) : value;
    return () => Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
  } }) as BrainEngine;
}

describe('#7145 unknown reads', () => {
  test('coverage whose read failed is unknown, not 0% with a remediation', async () => {
    for (let n = 1; n <= MIN_ENTITY_PAGES_FOR_COVERAGE; n++) {
      await engine.putPage(`people/example-${n}`, { type: 'person', title: `Example ${n}`, compiled_truth: 'A synthetic entity.', timeline: '' });
    }
    const broken = failing(/$^/, ['entityFeatureCoverage']);
    for (const run of [checkEntityLinkCoverage, checkTimelineCoverage]) {
      const result = await run(broken);
      expect(result.check).toMatchObject({ status: 'warn', details: { health: 'unknown', reason: 'error' } });
      expect(result.check.message).toContain('Coverage unknown');
      expect(result.remediations).toEqual([]);
    }
  });

  test('coverage whose entity count failed is unknown, not "no entity pages"', async () => {
    const broken = failing(/$^/, ['countEntityPages']);
    for (const run of [checkEntityLinkCoverage, checkTimelineCoverage]) {
      const result = await run(broken);
      expect(result.check).toMatchObject({ status: 'warn', details: { health: 'unknown', reason: 'error' } });
      expect(result.check.message).toContain('Coverage unknown');
      expect(result.check.message).not.toContain('vacuous');
      expect(result.remediations).toEqual([]);
    }
  });

  test('dangling_aliases whose read failed is unknown, not clear', async () => {
    const result = await checkDanglingAliases(failingMember('listAliasTargets'));
    expect(result.check).toMatchObject({ name: 'dangling_aliases', status: 'warn', details: { health: 'unknown' } });
    expect(result.check.message).toContain('Dangling aliases unknown');
  });

  test('an estimated orphan ratio whose sample held no linkable page is unknown, not 0%', async () => {
    const source = 'orphan-src';
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,$1)", [source]);
    for (const n of [1, 2]) {
      await engine.putPage(`people/hidden-${n}`, { type: 'person', title: `Hidden ${n}`, compiled_truth: 'Quarantined.', timeline: '',
        frontmatter: { quarantine: buildQuarantineMarker('junk_pattern', 'synthetic fixture') } }, { sourceId: source });
    }
    await engine.setConfig('doctor.orphan_ratio.full_scan_max_pages', '1');
    try {
      const [check] = await orphanRatioEntry.run({ engine, progress, tier: 'standard', orphanRatioSourceId: source } as never) as Array<Record<string, any>>;
      expect(check).toMatchObject({ name: 'orphan_ratio', status: 'warn', details: { health: 'unknown', reason: 'empty_sample', sample_linkable: 0 } });
      expect(check.message).toContain('Orphan ratio unknown');
    } finally { await engine.unsetConfig('doctor.orphan_ratio.full_scan_max_pages'); }
  });

  test('conversation_format_coverage names a capped sample as one', async () => {
    await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth)
      SELECT 'conversations/example-' || i, 'conversation', 'Example ' || i, 'Alice: hello' || chr(10) || 'Bob: hi' FROM generate_series(1, 50) i`);
    const check = await computeConversationFormatCoverageCheck(engine);
    expect(check.details).toMatchObject({ exact: false, bound: 'sample', limit: 50 });
    expect(check.message).toContain('a sample of up to 50 pages per conversation type');
  });

  test('a partial frontmatter walk carries its time bound in details', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-7145-fm-'));
    try {
      for (let n = 0; n < 400; n++) {
        mkdirSync(join(dir, `d${n % 20}`), { recursive: true });
        writeFileSync(join(dir, `d${n % 20}`, `note-${n}.md`), '---\ntitle: [unclosed\n---\nBody.\n');
      }
      await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('fm-src','fm-src',$1)", [dir]);
      await withEnv({ GBRAIN_DOCTOR_FM_TIMEOUT_MS: '1' }, async () => {
        const [check] = (await frontmatterEntry.run({ engine, progress, args: [] } as never) as Array<Record<string, any>>).filter(c => c.name === 'frontmatter_integrity');
        expect(check).toMatchObject({ status: 'warn', details: { partial: true, exact: false, health: 'unknown', reason: 'bound', bound: 'time' } });
      });
    } finally {
      await engine.executeRaw("DELETE FROM sources WHERE id = 'fm-src'");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
