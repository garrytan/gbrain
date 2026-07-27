import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import type { OperationContext } from '../src/core/operations.ts';
import {
  buildSkillCatalog,
  getSkillDetail,
  crossReferenceTools,
  oneLineDescription,
  resolveSkillMdPath,
} from '../src/core/skill-catalog.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'skill-catalog', 'skills');

/** Minimal ctx stub — the pure catalog functions only read remote/auth. */
function ctx(remote: boolean, scopes?: string[]): OperationContext {
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

describe('buildSkillCatalog', () => {
  test('lists real skills, excludes _conventions, derives broken', () => {
    const res = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config');
    const names = res.skills.map(s => s.name).sort();
    expect(names).toContain('brain-ops');
    expect(names).toContain('query-helper');
    expect(names).toContain('broken'); // malformed frontmatter → derived name, listed
    expect(names).not.toContain('_conventions');
    expect(res.count).toBe(res.skills.length);
    expect(res.schema_version).toBe(1);
    expect(res.skills_dir_source).toBe('config');
  });

  test('malformed-frontmatter skill is listed with empty triggers, no throw', () => {
    const res = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config');
    const broken = res.skills.find(s => s.name === 'broken')!;
    expect(broken).toBeDefined();
    expect(broken.triggers).toEqual([]);
    expect(broken.tools).toEqual([]);
    expect(broken.writes_pages).toBe(false);
  });

  test('triggers union frontmatter + RESOLVER.md, deduped', () => {
    const res = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config');
    const qh = res.skills.find(s => s.name === 'query-helper')!;
    // frontmatter trigger + the RESOLVER.md row both present
    expect(qh.triggers).toContain('find a page');
    expect(qh.triggers).toContain('where is my note');
  });

  test('D7 usable/unavailable split honors caller scope', () => {
    const read = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config')
      .skills.find(s => s.name === 'brain-ops')!;
    expect(read.usable_tools.sort()).toEqual(['query', 'search']);
    // put_page is write-scope (blocked for read), web_search isn't an op at all
    expect(read.unavailable_tools.sort()).toEqual(['put_page', 'web_search']);

    const admin = buildSkillCatalog(ctx(true, ['admin']), FIXTURE, 'config')
      .skills.find(s => s.name === 'brain-ops')!;
    expect(admin.usable_tools.sort()).toEqual(['put_page', 'query', 'search']);
    expect(admin.unavailable_tools).toEqual(['web_search']);
  });

  test('local caller (remote=false) can use any real op', () => {
    const local = buildSkillCatalog(ctx(false), FIXTURE, 'config')
      .skills.find(s => s.name === 'brain-ops')!;
    expect(local.usable_tools.sort()).toEqual(['put_page', 'query', 'search']);
    expect(local.unavailable_tools).toEqual(['web_search']); // still not an op
  });

  test('section filter narrows the result set', () => {
    const all = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config');
    const someSection = all.skills[0].section;
    const filtered = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config', {
      section: someSection,
    });
    expect(filtered.skills.every(s => s.section === someSection)).toBe(true);
    const nomatch = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config', {
      section: 'no-such-section-xyz',
    });
    expect(nomatch.skills).toEqual([]);
  });

  test('instructions envelope present and shaped', () => {
    const res = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config');
    expect(res.instructions.fetch_op).toBe('get_skill');
    expect(res.instructions.how_to_use.length).toBeGreaterThan(0);
    expect(res.instructions.available_brain_tools).toContain('search');
    // read scope must NOT advertise a write op as available
    expect(res.instructions.available_brain_tools).not.toContain('put_page');
  });

  test('empty dir → count 0 but instructions still present', () => {
    const empty = join(import.meta.dir, 'fixtures', 'skill-catalog', 'does-not-exist');
    const res = buildSkillCatalog(ctx(true, ['read']), empty, 'config');
    expect(res.count).toBe(0);
    expect(res.skills).toEqual([]);
    expect(res.instructions.fetch_op).toBe('get_skill');
  });
});

describe('getSkillDetail', () => {
  test('returns prose body + allowlisted frontmatter (drops writes_to/sources)', () => {
    const res = getSkillDetail(ctx(true, ['read']), FIXTURE, 'brain-ops');
    expect(res.name).toBe('brain-ops');
    expect(res.body).toContain('Brain-first lookup');
    expect(res.body).not.toContain('---'); // fence stripped
    // allowlist: name/description/triggers/tools/writes_pages/mutating only
    const fmKeys = Object.keys(res.frontmatter).sort();
    expect(fmKeys).not.toContain('writes_to');
    expect(fmKeys).not.toContain('sources');
    expect(fmKeys).not.toContain('raw');
    expect(res.frontmatter.writes_pages).toBe(true);
    // the dropped fields must not leak anywhere in the response
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('/abs/path/should/be/dropped.ts');
    expect(blob).not.toContain('people/');
  });

  test('mirrors the D7 tool split + client_guidance', () => {
    const res = getSkillDetail(ctx(true, ['read']), FIXTURE, 'brain-ops');
    expect(res.usable_tools.sort()).toEqual(['query', 'search']);
    expect(res.unavailable_tools.sort()).toEqual(['put_page', 'web_search']);
    expect(res.client_guidance.mutating).toBe(true);
    expect(res.client_guidance.protocol.length).toBeGreaterThan(0);
  });
});

describe('oneLineDescription', () => {
  test('prefers frontmatter description', () => {
    expect(oneLineDescription('description: hello there', '# h\nbody')).toBe('hello there');
  });
  test('falls back to first prose line, skipping headings', () => {
    expect(oneLineDescription('', '# Title\n\nFirst real line.')).toBe('First real line.');
  });
  test('empty when nothing usable', () => {
    expect(oneLineDescription('', '# only a heading')).toBe('');
  });
});

describe('crossReferenceTools', () => {
  test('unknown tool is unavailable; read op usable for read scope', () => {
    const { usable_tools, unavailable_tools } = crossReferenceTools(
      ['search', 'put_page', 'totally_not_an_op'],
      ctx(true, ['read']),
    );
    expect(usable_tools).toEqual(['search']);
    expect(unavailable_tools.sort()).toEqual(['put_page', 'totally_not_an_op']);
  });
});

describe('resolveSkillMdPath (happy path)', () => {
  test('resolves a real skill to its SKILL.md', () => {
    const p = resolveSkillMdPath(FIXTURE, 'brain-ops');
    expect(p.endsWith('/brain-ops/SKILL.md')).toBe(true);
  });
});
