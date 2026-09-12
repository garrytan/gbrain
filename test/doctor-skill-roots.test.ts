import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSkillPaths } from '../src/core/skill-paths.ts';
import { checkResolvable } from '../src/core/check-resolvable.ts';
import { skillConformanceCheck, skillBrainFirstCheck } from '../src/commands/doctor/skill-checks.ts';
import { computeSkillCurrency } from '../src/core/skillpack/skill-currency.ts';

const dirs: string[] = [];
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doctor-roots-'));
  dirs.push(root);
  const workspace = join(root, 'workspace');
  const skills = join(workspace, 'skills');
  const workshop = join(root, 'approved-workshop');
  const other = join(root, 'unapproved-store');
  for (const p of [skills, workshop, other]) mkdirSync(p, { recursive: true });
  return { root, workspace, skills, workshop, other };
}
function body(name: string, extra = '') { return `---\nname: ${name}\ntriggers: ["invoke ${name}"]\n${extra}---\n# Example skill\n`; }
function put(root: string, name: string, content = body(name)) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), content);
}
function manifest(root: string, names: string[]) {
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ skills: names.map(name => ({ name, path: `${name}/SKILL.md` })) }));
  writeFileSync(join(root, 'RESOLVER.md'), names.map(name => `| invoke ${name} | \`skills/${name}/SKILL.md\` |`).join('\n'));
}
const missing = (r: ReturnType<typeof checkResolvable>) => r.errors.filter(e => e.type === 'missing_file');

describe('Doctor approved skill roots', () => {
  test('relocated file resolves with provenance, without rewriting manifest or granting unapproved roots', () => {
    const f = fixture(); manifest(f.skills, ['alpha']); put(f.workshop, 'alpha');
    const before = readFileSync(join(f.skills, 'manifest.json'), 'utf8');
    expect(missing(checkResolvable(f.skills, { skillRoots: [] }))).toHaveLength(1);
    const opts = { skillRoots: [f.workshop] };
    const location = createSkillPaths(f.skills, opts).locate('alpha/SKILL.md');
    expect(location).toMatchObject({ path: join(f.workshop, 'alpha/SKILL.md'), root: f.workshop, source: 'explicit' });
    expect(checkResolvable(f.skills, opts).errors).toHaveLength(0);
    expect(skillConformanceCheck(f.skills, opts).message).toContain('1/1');
    expect(readFileSync(join(f.skills, 'manifest.json'), 'utf8')).toBe(before);
  });
  test('workspace collision wins even when its content is invalid', () => {
    const f = fixture(); manifest(f.skills, ['alpha']); put(f.workshop, 'alpha'); put(f.skills, 'alpha', '# invalid');
    const opts = { skillRoots: [f.workshop] };
    expect(createSkillPaths(f.skills, opts).locate('alpha/SKILL.md').source).toBe('workspace');
    expect(skillConformanceCheck(f.skills, opts).status).toBe('warn');
    expect(checkResolvable(f.skills, opts).warnings.some(e => e.type === 'mece_gap')).toBe(true);
  });
  test('first additional root wins; no manifest is required to discover a relocated skill', () => {
    const f = fixture(); put(f.workshop, 'alpha'); put(f.other, 'alpha', '# invalid');
    const opts = { skillRoots: [f.workshop, f.other] };
    expect(skillConformanceCheck(f.skills, opts).status).toBe('ok');
    expect(checkResolvable(f.skills, opts).summary.total_skills).toBe(1);
  });
  test('genuinely missing and relocated-but-unreachable stay errors', () => {
    const f = fixture(); manifest(f.skills, ['alpha', 'missing']); put(f.workshop, 'alpha');
    expect(missing(checkResolvable(f.skills, { skillRoots: [f.workshop] }))).toHaveLength(1);
    writeFileSync(join(f.skills, 'RESOLVER.md'), '# Resolver\n');
    put(f.workshop, 'alpha', '---\nname: alpha\n---\nNo triggers.');
    expect(checkResolvable(f.skills, { skillRoots: [f.workshop] }).ok).toBe(false);
  });
  test('external symlinks need explicit root approval and never authorize their target by themselves', () => {
    const f = fixture(); manifest(f.skills, ['alpha']); put(f.other, 'alpha');
    symlinkSync(join(f.other, 'alpha'), join(f.skills, 'alpha'), 'dir');
    const denied = checkResolvable(f.skills, { skillRoots: [f.workshop] });
    expect(denied.errors.some(e => e.type === 'invalid_skill_path')).toBe(true);
    expect(createSkillPaths(f.skills, { skillRoots: [f.other] }).locate('alpha/SKILL.md').path).not.toBeNull();
  });
  test('approved external symlink remains externally owned and has no workspace edit hint', () => {
    const f = fixture(); manifest(f.skills, ['alpha']);
    put(f.workshop, 'alpha', '---\nname: alpha\n---\n# External skill\n');
    symlinkSync(join(f.workshop, 'alpha'), join(f.skills, 'alpha'), 'dir');
    const opts = { skillRoots: [f.workshop] };
    const location = createSkillPaths(f.skills, opts).locate('alpha/SKILL.md');
    expect(location.source).toBe('explicit');
    expect(location.path).toBe(join(f.workshop, 'alpha', 'SKILL.md'));
    const report = checkResolvable(f.skills, opts);
    expect(report.warnings.some(e => e.type === 'mece_gap')).toBe(true);
    expect(report.issues.every(e => !e.fix?.file.startsWith(f.workshop))).toBe(true);
  });
  test('an out-of-root manifest is a visible failure, not silent derived fallback', () => {
    const f = fixture(); put(f.skills, 'alpha');
    writeFileSync(join(f.other, 'manifest.json'), JSON.stringify({ skills: [] }));
    symlinkSync(join(f.other, 'manifest.json'), join(f.skills, 'manifest.json'));
    const report = checkResolvable(f.skills, { skillRoots: [f.workshop] });
    expect(report.errors.some(e => e.type === 'skill_root_error')).toBe(true);
    expect(skillConformanceCheck(f.skills, { skillRoots: [f.workshop] }).status).toBe('warn');
  });
  test('in-root symlinks are contained and dangling links do not fall through', () => {
    const f = fixture(); put(f.skills, '_actual');
    symlinkSync(join(f.skills, '_actual'), join(f.skills, 'alpha'), 'dir');
    const paths = createSkillPaths(f.skills, { skillRoots: [f.workshop] });
    expect(paths.locate('alpha/SKILL.md').path).not.toBeNull();
    put(f.workshop, 'beta'); symlinkSync(join(f.root, 'absent'), join(f.skills, 'beta'), 'dir');
    expect(paths.locate('beta/SKILL.md').path).toBeNull();
  });
  test('non-file skill bodies fail and do not fall through', () => {
    const f = fixture(); manifest(f.skills, ['alpha']); put(f.workshop, 'alpha');
    mkdirSync(join(f.skills, 'alpha', 'SKILL.md'), { recursive: true });
    expect(skillConformanceCheck(f.skills, { skillRoots: [f.workshop] }).status).toBe('warn');
    expect(checkResolvable(f.skills, { skillRoots: [f.workshop] }).ok).toBe(false);
  });
  test.each(['../outside/SKILL.md', '/absolute/SKILL.md', 'a/../alpha/SKILL.md', 'a\\SKILL.md', 'a//SKILL.md', './alpha/SKILL.md', 'a\u0000/SKILL.md', 'C:/alpha/SKILL.md'])('malformed reference %j stays invalid', ref => {
    const f = fixture(); put(f.workshop, 'alpha');
    expect(createSkillPaths(f.skills, { skillRoots: [f.workshop] }).locate(ref).error).toBe('invalid skill reference');
    writeFileSync(join(f.skills, 'manifest.json'), JSON.stringify({ skills: [{ name: 'alpha', path: ref }] }));
    writeFileSync(join(f.skills, 'RESOLVER.md'), '# Resolver');
    expect(checkResolvable(f.skills, { skillRoots: [f.workshop] }).errors.some(e => e.type === 'invalid_skill_path')).toBe(true);
  });
  test('unavailable and relative roots are explicit failures, not silent empty inventories', () => {
    const f = fixture(); put(f.skills, 'alpha');
    for (const root of ['relative', join(f.root, 'missing')]) {
      const opts = { skillRoots: [root] };
      expect(checkResolvable(f.skills, opts).errors.some(e => e.type === 'skill_root_error')).toBe(true);
      expect(skillConformanceCheck(f.skills, opts).status).toBe('warn');
      expect(skillBrainFirstCheck(f.skills, { ...opts, audit: false }).status).toBe('warn');
    }
  });
  test('brain-first reads relocated content; missing files cannot be called compliant', () => {
    const f = fixture(); manifest(f.skills, ['alpha']);
    put(f.workshop, 'alpha', body('alpha', 'tools: [web_search]\n') + '\nUse web_search to search the web.\n');
    const opts = { skillRoots: [f.workshop], audit: false };
    expect(skillBrainFirstCheck(f.skills, opts).status).toBe('warn');
    put(f.workshop, 'alpha', body('alpha', 'brain_first: exempt\n'));
    expect(skillBrainFirstCheck(f.skills, opts).status).toBe('ok');
    manifest(f.skills, ['alpha', 'missing']);
    expect(skillBrainFirstCheck(f.skills, opts).message).toContain('Incomplete scan: 1/2');
  });
  test('conformance rejects an unfinished frontmatter fence', () => {
    const f = fixture(); put(f.workshop, 'alpha', '---\nname: alpha\n');
    expect(skillConformanceCheck(f.skills, { skillRoots: [f.workshop] }).status).toBe('warn');
  });

  test('resolver absolute paths stay invalid even if their target exists', () => {
    const f = fixture(); put(f.other, 'alpha');
    writeFileSync(join(f.skills, 'RESOLVER.md'), `| invoke alpha | \`${join(f.other, 'alpha/SKILL.md')}\` |`);
    expect(checkResolvable(f.skills, { skillRoots: [] }).errors.some(e => e.type === 'invalid_skill_path')).toBe(true);
  });
  test('invalid YAML is a conformance failure', () => {
    const f = fixture(); put(f.workshop, 'alpha', '---\nname: [unterminated\n---\n');
    expect(skillConformanceCheck(f.skills, { skillRoots: [f.workshop] }).message).toContain('invalid frontmatter');
  });
  test('relocated routing fixtures, filing rules and stub diagnostics still run', () => {
    const f = fixture();
    put(f.workshop, 'alpha', body('alpha', 'writes_pages: true\n'));
    writeFileSync(join(f.skills, '_brain-filing-rules.json'), JSON.stringify({ version: '1', rules: [{ kind: 'note', directory: 'notes/' }] }));
    writeFileSync(join(f.workshop, 'alpha/routing-eval.jsonl'), JSON.stringify({ intent: 'unmatched phrase', expected_skill: 'alpha' }) + '\n');
    mkdirSync(join(f.workshop, 'alpha/scripts'));
    writeFileSync(join(f.workshop, 'alpha/scripts/example.ts'), "throw new Error('never execute this fixture'); // SKILLIFY_STUB: replace before running check-resolvable --strict\n");
    const report = checkResolvable(f.skills, { skillRoots: [f.workshop] });
    expect(report.warnings.some(e => e.type === 'routing_miss')).toBe(true);
    expect(report.warnings.some(e => e.type === 'filing_missing_writes_to')).toBe(true);
    expect(report.warnings.some(e => e.type === 'skillify_stub_unreplaced')).toBe(true);
    expect(report.issues.every(e => !e.fix?.file.startsWith(f.workshop))).toBe(true);
  });
  test('environment roots require valid JSON and explicit options override them', () => {
    const f = fixture(); put(f.workshop, 'alpha');
    const module = join(import.meta.dir, '../src/core/skill-paths.ts');
    const code = `import { createSkillPaths } from ${JSON.stringify(module)}; console.log(JSON.stringify([createSkillPaths(${JSON.stringify(f.skills)}).errors, createSkillPaths(${JSON.stringify(f.skills)}, {skillRoots:[]}).roots]));`;
    const child = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env, GBRAIN_SKILL_ROOTS: 'not-json' }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0);
    const [errors, roots] = JSON.parse(child.stdout.toString());
    expect(errors).toHaveLength(1); expect(roots).toEqual([f.skills]);
    const validCode = `import { skillConformanceCheck } from ${JSON.stringify(join(import.meta.dir, '../src/commands/doctor/skill-checks.ts'))}; console.log(JSON.stringify(skillConformanceCheck(${JSON.stringify(f.skills)})));`;
    const valid = Bun.spawnSync([process.execPath, '-e', validCode], { env: { ...process.env, GBRAIN_SKILL_ROOTS: JSON.stringify([f.workshop]) }, stdout: 'pipe', stderr: 'pipe' });
    expect(valid.exitCode).toBe(0); expect(JSON.parse(valid.stdout.toString()).message).toContain('1/1');
  });
  test('currency compares actual relocated bytes and keeps missing support files drifted', () => {
    const f = fixture(); const bundle = join(f.root, 'bundle');
    mkdirSync(join(bundle, 'src'), { recursive: true }); writeFileSync(join(bundle, 'src/cli.ts'), '// fixture');
    for (const name of ['alpha', 'beta', 'gamma']) put(join(bundle, 'skills'), name);
    mkdirSync(join(bundle, 'skills/alpha/scripts')); writeFileSync(join(bundle, 'skills/alpha/scripts/helper.ts'), '// fixture only\n');
    writeFileSync(join(bundle, 'openclaw.plugin.json'), JSON.stringify({ name: 'fixture', version: '0.0.0.0', skills: ['skills/alpha', 'skills/beta', 'skills/gamma'], shared_deps: [] }));
    put(f.workshop, 'alpha'); put(f.workshop, 'beta');
    const opts = { gbrainRoot: bundle, targetWorkspace: f.workspace, skillRoots: [f.workshop] };
    const report = computeSkillCurrency(opts);
    expect(report.skills.find(s => s.slug === 'alpha')?.status).toBe('drifted');
    expect(report.skills.find(s => s.slug === 'beta')?.status).toBe('current');
    expect(report.skills.find(s => s.slug === 'gamma')?.status).toBe('new');
    put(f.skills, 'beta', body('beta') + 'Local override.');
    expect(computeSkillCurrency(opts).skills.find(s => s.slug === 'beta')?.status).toBe('drifted');
  });
});
