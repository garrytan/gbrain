import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSkillHealth, parseSkillBudgets, registeredSkillSurface, setSkillSurfaceProvider, skillHealthSummary, type SkillBudget } from '../src/core/skill-health.ts';
import type { CliSurface } from '../src/core/skill-drift.ts';
import { skillHealthEntry } from '../src/commands/doctor/checks/skill-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

const surface: CliSurface = {
  isCommand: n => ['doctor', 'search'].includes(n),
  isCliOnly: n => n === 'doctor',
  subcommands: () => undefined,
  stripGlobalFlags: argv => argv,
  unknownFlag: (_c, args) => args.find(a => a.startsWith('--') && !['--json', '--limit'].includes(a)) ?? null,
  legalFlags: () => ['--json', '--limit'],
  isOperation: n => n === 'get_page',
  operationNames: () => ['get_page'],
};

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A skills folder in a fresh temp dir: no git repository anywhere above it, like a repo-less brain. */
function folder(skills: Record<string, string>, managed = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'gb-skill-health-'));
  roots.push(dir);
  if (managed) writeFileSync(join(dir, 'manifest.json'), '{"skills":[]}');
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), body);
  }
  return dir;
}
const skill = (body: string, extra = 'triggers:\n  - when x\n') => `---\nname: s\ndescription: d\n${extra}---\n\n${body}\n`;
const run = (dir: string, budgets = new Map<string, SkillBudget>(), bundled = new Set<string>(), only?: string) =>
  computeSkillHealth({ skillsDir: dir, surface, budgets, bundled, only });

describe('computeSkillHealth', () => {
  test('a clean managed folder has no findings and counts invocations', () => {
    const r = run(folder({ a: skill('Run `gbrain doctor --json`.') }));
    expect(r.scope).toBe('managed');
    expect(r.findings).toEqual([]);
    expect(r.totals).toMatchObject({ skills: 1, invocations: 1, drift: 0, size: 0 });
    expect(skillHealthSummary(r)).toContain('no findings');
  });

  test('each finding carries observed, expected, a fix and a read-only verify command', () => {
    const big = 'x'.repeat(2_000);
    const dir = folder({
      over: skill(big),
      grown: skill('y'.repeat(1_200)),
      nodesc: `---\nname: s\ndescription: ${'d'.repeat(1_100)}\ntriggers:\n  - t\n---\nbody\n`,
      untriggered: skill('body', ''),
      drifted: skill('Run `gbrain search q --no-such-flag`.'),
    });
    const budgets = new Map<string, SkillBudget>([['over', { max: 1_000, lastDiet: null }], ['grown', { max: 5_000, lastDiet: 1_000 }]]);
    const r = run(dir, budgets);
    const byCode = Object.fromEntries(r.findings.map(f => [f.code, f]));
    expect(Object.keys(byCode).sort()).toEqual([
      'SKILL_DRIFT_UNKNOWN_FLAG', 'SKILL_HEALTH_DESCRIPTION', 'SKILL_HEALTH_DIET_GROWTH', 'SKILL_HEALTH_MISSING_TRIGGERS', 'SKILL_HEALTH_OVER_BUDGET',
    ]);
    expect(byCode.SKILL_HEALTH_OVER_BUDGET).toMatchObject({ skill: 'over', file: 'over/SKILL.md', expected: 'at most 1000 bytes' });
    expect(byCode.SKILL_HEALTH_DIET_GROWTH!.expected).toContain('last diet 1000');
    expect(byCode.SKILL_DRIFT_UNKNOWN_FLAG).toMatchObject({ skill: 'drifted', line: 8 });
    for (const f of r.findings) {
      expect(f.fix.length).toBeGreaterThan(10);
      expect(f.verify).toBe(`gbrain skillpack health ${f.skill}`);
    }
    expect(r.totals).toMatchObject({ drift: 1, size: 4 });
  });

  test('an over-budget copy of a bundled skill points at the upstream version first', () => {
    const r = run(folder({ brainy: skill('x'.repeat(20_000)) }), new Map(), new Set(['brainy']));
    expect(r.findings[0]!.fix).toContain('gbrain skillpack reference brainy');
  });

  test('a folder gbrain does not manage gets no findings', () => {
    const r = run(folder({ theirs: skill('x'.repeat(20_000), '') }, false), new Map(), new Set(['brainy']));
    expect(r.scope).toBe('not_gbrain');
    expect(r.skills).toEqual([]);
    expect(skillHealthSummary(r)).toBe('no gbrain skills in this folder');
  });

  test('in an unmanaged folder only copies of bundled skills are checked', () => {
    const r = run(folder({ brainy: skill('body', ''), theirs: skill('body', '') }, false), new Map(), new Set(['brainy']));
    expect(r.scope).toBe('bundled_copies');
    expect(r.skills.map(s => s.skill)).toEqual(['brainy']);
  });

  test('without a CLI surface only size and frontmatter are checked, and the summary says so', () => {
    const r = computeSkillHealth({ skillsDir: folder({ a: skill('Run `gbrain search q --no-such-flag`.') }), surface: null, budgets: new Map(), bundled: new Set() });
    expect(r.drift_checked).toBe(false);
    expect(r.findings).toEqual([]);
    expect(skillHealthSummary(r)).toContain('not checked outside the CLI');
  });

  test('only narrows to one skill', () => {
    const r = run(folder({ a: skill('a'), b: skill('b') }), new Map(), new Set(), 'b');
    expect(r.skills.map(s => s.skill)).toEqual(['b']);
  });

  test('100 skills in under 500 ms', () => {
    const skills: Record<string, string> = {};
    for (let i = 0; i < 100; i++) skills[`s${i}`] = skill(`Run \`gbrain doctor --json\`.\n${'text '.repeat(2_000)}`);
    const dir = folder(skills);
    const t0 = performance.now();
    const r = run(dir);
    expect(r.totals.skills).toBe(100);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('surface registration', () => {
  test('loading the CLI dispatcher registers the real surface', async () => {
    await import('../src/cli/main.ts');
    expect(registeredSkillSurface()?.isCommand('doctor')).toBe(true);
    setSkillSurfaceProvider(null);
  });
});

describe('parseSkillBudgets', () => {
  test('reads rows and reports invalid and duplicate ones', () => {
    const p = parseSkillBudgets('# c\na\t100\t90\tnote\nb\t200\t-\tnote\nbad\tx\na\t50\t-\n');
    expect(p.rows.get('a')).toEqual({ max: 50, lastDiet: null });
    expect(p.rows.get('b')).toEqual({ max: 200, lastDiet: null });
    expect(p.invalid).toEqual(['bad\tx']);
    expect(p.duplicates).toEqual(['a']);
  });
});

describe('skill_health doctor check', () => {
  beforeAll(() => setSkillSurfaceProvider(() => surface));
  afterAll(() => setSkillSurfaceProvider(null));
  const ctx = (dir: string | null, scope: 'all' | 'brain' = 'all') =>
    ({ scope, skillsDirResolution: { dir, source: dir ? 'explicit' : 'none' } }) as unknown as DoctorContext;

  test('warns on drift and points at the fix command', async () => {
    const dir = folder({ doctor: skill('Run `gbrain doctor --no-such-flag`.') });
    const [c] = (await skillHealthEntry.run(ctx(dir))) as Array<{ name: string; status: string; message: string; issues?: unknown[] }>;
    expect(c!.status).toBe('warn');
    expect(c!.message).toContain('Run: gbrain skillpack health');
    expect(c!.issues).toHaveLength(1);
  });

  test('size findings alone do not warn', async () => {
    const dir = folder({ big: skill('x'.repeat(20_000)) });
    const [c] = (await skillHealthEntry.run(ctx(dir))) as Array<{ status: string; message: string }>;
    expect(c!.status).toBe('ok');
    expect(c!.message).toContain('gbrain skillpack health lists them');
  });

  test('is not applicable to a folder gbrain does not manage, and silent without a skills dir or under --scope=brain', async () => {
    const [c] = (await skillHealthEntry.run(ctx(folder({ theirs: skill('x', '') }, false)))) as Array<{ status: string; severity?: string }>;
    expect(c).toMatchObject({ status: 'ok', severity: 'info' });
    expect(await skillHealthEntry.run(ctx(null))).toEqual([]);
    expect(await skillHealthEntry.run(ctx(folder({ a: skill('a') }), 'brain'))).toEqual([]);
  });
});
