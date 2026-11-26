/**
 * G3: the moved-skills registry (skills/moved-skills.json, src/core/skillpack/moved.ts), what check-resolvable and
 * doctor make of a resolver row naming a moved skill, the guard on new skill folders, the announcement script, and
 * --update-untouched for a moved skill.
 *
 * Protects: the committed registry validates and its destination is null, so nothing announces a move yet; with a
 * destination set through the test seam each surface says where the skill went; with it null each behaves as before.
 * Fails when: a bad registry stops validating, a notice appears while the destination is null, a moved skill another
 * catalog provides is still reported missing, or the guard and the script act while the destination is null.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  committedMovedRegistry, isMovedSkill, movedSkillNotice, movedSkillNotices, parseMovedRegistry, setMovedRegistryForTests,
  unlistedSkillFolders, type MovedRegistry,
} from '../src/core/skillpack/moved.ts';
import { checkResolvable } from '../src/core/check-resolvable.ts';
import { buildSkillIndex } from '../src/core/skills/resolver/build.ts';
import { catalogFile } from '../src/core/skills/resolver/paths.ts';
import { runScaffold } from '../src/core/skillpack/scaffold.ts';
import { recordScaffoldBases, runSkillpackUpdate, skillsRootKey } from '../src/core/skillpack/safe-update.ts';
import { computeSkillsManifest, mergeSkillsLockHistory, renderSkillsLockHistory, renderSkillsManifest, SKILLS_LOCK_HISTORY_FILENAME, SKILLS_MANIFEST_FILENAME } from '../src/core/skills-integrity.ts';
import { main as guard } from '../scripts/check-moved-skills.ts';
import { main as announce } from '../scripts/announce-moved-skills.ts';
import { build as buildBehaviorChanges, parseNoticeFragment } from '../scripts/build-behavior-changes.ts';

const REPO = join(import.meta.dir, '..');
const created: string[] = [];
afterEach(() => {
  setMovedRegistryForTests(null);
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const DEST = { name: 'catalog-example', install: 'example-tool add {skill}', url: 'https://example.com/skills' };
const registry = (over: Partial<MovedRegistry> = {}): MovedRegistry => ({ schema_version: 1, destination: DEST, moved: ['briefing', 'retired-example'], kept: ['query'], ...over });

const MOVED_26 = ['academic-verify', 'archive-crawler', 'article-enrichment', 'ask-user', 'blog-ingest', 'book-mirror', 'brain-pdf', 'briefing',
  'bulk-ingestion', 'citation-graph-ingest', 'cold-start', 'company-brainify', 'conversation-archive', 'cron-scheduler', 'cross-modal-review',
  'daily-task-manager', 'daily-task-prep', 'fact-check', 'meeting-ingestion', 'perplexity-research', 'reports', 'research-compendium',
  'strategic-reading', 'two-tier-extraction', 'voice-note-ingest', 'webhook-transforms'];

describe('the committed registry', () => {
  test('validates, names no destination, moves the 26 approved skills and keeps the other 50 skill folders', () => {
    const r = committedMovedRegistry();
    expect(r.destination).toBeNull();
    expect([...r.moved].sort()).toEqual(MOVED_26);
    expect(r.kept.length).toBe(50);
    const folders = readdirSync(join(REPO, 'skills'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    for (const name of [...r.moved, ...r.kept]) expect(folders).toContain(name);
  });

  test('while the destination is null no skill has a notice, though the list still says which skills move', () => {
    for (const name of MOVED_26) {
      expect(isMovedSkill(name)).toBe(true);
      expect(movedSkillNotice(name)).toBeNull();
    }
    expect(movedSkillNotices(MOVED_26)).toEqual([]);
    expect(isMovedSkill('query')).toBe(false);
  });
});

describe('parseMovedRegistry', () => {
  test('refuses a bad file with every problem named', () => {
    const bad = (doc: unknown) => { try { parseMovedRegistry(doc); return ''; } catch (e) { return (e as Error).message; } };
    expect(bad([])).toContain('must be a JSON object');
    const msg = bad({ schema_version: 2, destination: { name: 'x', install: 'a\nb', url: 'http://x', extra: 1 }, moved: ['Bad Name', 'dup', 'dup', 'both'], kept: ['both', 'conventions'], more: true });
    for (const part of ['schema_version must be 1', 'unknown keys: more', 'destination.install must be a one-line', 'destination.url must be an https URL',
      'destination has unknown keys: extra', 'not skill folder names: "Bad Name"', 'moved lists dup more than once', 'both cannot be both moved and kept',
      'conventions hold shared files']) expect(msg).toContain(part);
    expect(bad({ schema_version: 1, destination: 'x', moved: [], kept: [] })).toContain('destination must be null or an object');
    expect(bad({ schema_version: 1, destination: null, moved: 'a', kept: [] })).toContain('moved must be a list');
  });

  test('accepts a null destination and a filled one', () => {
    expect(parseMovedRegistry({ schema_version: 1, destination: null, moved: ['a-skill'], kept: [] }).destination).toBeNull();
    expect(parseMovedRegistry(registry()).destination).toEqual(DEST);
  });
});

describe('notices', () => {
  test('a set destination gives each moved skill one notice naming where it went and how to install it', () => {
    setMovedRegistryForTests(registry());
    const notice = movedSkillNotice('briefing')!;
    expect(notice).toContain('The briefing skill moved to catalog-example (https://example.com/skills)');
    expect(notice).toContain('example-tool add briefing');
    expect(movedSkillNotice('query')).toBeNull();
    expect(movedSkillNotices(['query', 'briefing', 'retired-example'])).toHaveLength(2);
  });

  test('a null destination turns every notice off even for listed skills', () => {
    setMovedRegistryForTests(registry({ destination: null }));
    expect(isMovedSkill('briefing')).toBe(true);
    expect(movedSkillNotice('briefing')).toBeNull();
  });
});

describe('the new-skill-folder guard', () => {
  const tree = (reg: unknown, folders: string[]) => {
    const root = tmp('moved-guard-');
    write(root, { 'skills/moved-skills.json': JSON.stringify(reg) });
    for (const f of folders) mkdirSync(join(root, 'skills', f), { recursive: true });
    return root;
  };
  const run = (root: string) => { const lines: string[] = []; const code = guard(root, l => lines.push(l)); return { code, out: lines.join('\n') }; };

  test('does nothing while the destination is null, even with an unlisted folder', () => {
    const r = run(tree(registry({ destination: null }), ['query', 'briefing', 'new-content-skill']));
    expect(r.code).toBe(0);
    expect(r.out).toContain('GBRAIN_CHECK_SKIPPED');
    expect(unlistedSkillFolders(['new-content-skill'], registry({ destination: null }))).toEqual([]);
  });

  test('once the destination is set refuses a folder neither list names, and passes when every folder is listed', () => {
    const refused = run(tree(registry(), ['query', 'briefing', 'conventions', 'migrations', 'new-content-skill']));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('skills/new-content-skill/ is a new skill folder');
    expect(refused.out).toContain('https://example.com/skills');
    expect(run(tree(registry(), ['query', 'briefing', 'conventions'])).code).toBe(0);
  });

  test('a registry that does not validate fails the guard', () => {
    expect(run(tree({ schema_version: 1, destination: null, moved: ['x'], kept: ['x'] }, [])).code).toBe(1);
  });

  test('passes on this checkout', () => {
    expect(guard(REPO, () => {})).toBe(0);
  });
});

describe('scripts/announce-moved-skills.ts', () => {
  const TODAY = '2026-11-21';
  const root = (reg: unknown) => {
    const r = tmp('moved-announce-');
    write(r, {
      'skills/moved-skills.json': JSON.stringify(reg),
      VERSION: '0.1.0.0\n',
      'CHANGELOG.md': '# Changelog\n\n## [0.1.0.0] - 2026-11-01\n\n- First.\n',
      'src/core/behavior-change-notice.ts': 'export const BEHAVIOR_CHANGES = [];\n',
    });
    return r;
  };
  const run = (dir: string, args: string[]) => { const lines: string[] = []; const code = announce(args, { cwd: dir, today: TODAY, log: l => lines.push(l) }); return { code, out: lines.join('\n') }; };
  const ARGS = ['--remove-after', '2026-12-05', '--owner', 'alice-example'];

  test('refuses while the destination is null and writes nothing', () => {
    const dir = root(registry({ destination: null }));
    const r = run(dir, ARGS);
    expect(r.code).toBe(1);
    expect(r.out).toContain('names no destination yet');
    expect(existsSync(join(dir, 'deprecations.d'))).toBe(false);
  });

  test('refuses a removal date less than 14 days away, and a missing argument', () => {
    const dir = root(registry());
    const r = run(dir, ['--remove-after', '2026-12-04', '--owner', 'alice-example']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('less than 14 days away; use 2026-12-05 or later');
    expect(run(dir, ['--remove-after', '2026-12-05']).code).toBe(2);
    expect(existsSync(join(dir, 'deprecations.d'))).toBe(false);
  });

  test('writes one record per moved skill, the notice row and the changelog announcement, which the release builder accepts', () => {
    const dir = root(registry());
    const r = run(dir, ARGS);
    expect(r.code).toBe(0);
    expect(readdirSync(join(dir, 'deprecations.d')).sort()).toEqual(['skill_moved_briefing.md', 'skill_moved_retired_example.md']);
    const record = readFileSync(join(dir, 'deprecations.d', 'skill_moved_briefing.md'), 'utf8');
    for (const line of ['surface: bundled-skill', 'name: briefing', 'replacement: example-tool add briefing', 'owner: alice-example', 'remove_after: 2026-12-05']) expect(record).toContain(line);
    const row = parseNoticeFragment(readFileSync(join(dir, 'behavior-changes.d', 'skills_moved_20261205.md'), 'utf8'));
    expect(row.problems).toEqual([]);
    expect(row.front.kind).toBe('action');
    expect(row.body).toContain('briefing, retired-example');
    const changelog = readFileSync(join(dir, 'changelog.d', 'skills-moved-20261205.md'), 'utf8');
    expect(changelog).toStartWith('**2 bundled skills moved to catalog-example');
    expect(changelog).toContain('<!-- behavior-change: skills_moved_20261205 -->');
    expect(buildBehaviorChanges(dir).problems).toEqual([]);
    const again = run(dir, ARGS);
    expect(again.code).toBe(1);
    expect(again.out).toContain('already exist');
  });
});

describe('check-resolvable and doctor: a resolver row naming a moved skill', () => {
  const workspace = () => {
    const root = tmp('moved-resolvable-');
    write(root, {
      'skills/query/SKILL.md': '---\nname: query\ntriggers:\n  - "answer a question"\n---\n# query\n',
      'skills/manifest.json': JSON.stringify({ skills: [{ name: 'query', path: 'query/SKILL.md' }] }),
      'skills/RESOLVER.md': '# Resolver\n\n## Brain operations\n\n| Trigger | Skill |\n|---|---|\n| answer a question | \`skills/query/SKILL.md\` |\n| morning briefing | \`skills/briefing/SKILL.md\` |\n',
    });
    return join(root, 'skills');
  };
  const about = (report: ReturnType<typeof checkResolvable>, skill: string) => report.issues.filter(i => i.skill.includes(skill));

  test('missing everywhere with a null destination is the same missing_file error as before', () => {
    setMovedRegistryForTests(registry({ destination: null }));
    const report = checkResolvable(workspace(), { resolverHome: tmp('moved-home-') });
    expect(report.ok).toBe(false);
    expect(about(report, 'briefing').map(i => [i.type, i.severity])).toEqual([['missing_file', 'error']]);
  });

  test('a built skill catalog that indexes the skill makes the row present', async () => {
    const home = tmp('moved-home-');
    const elsewhere = tmp('moved-elsewhere-');
    write(elsewhere, { 'briefing/SKILL.md': '---\nname: briefing\ndescription: A morning briefing.\n---\n# briefing\n' });
    await buildSkillIndex({ catalog: 'other-catalog', dirs: [elsewhere] }, { home });
    const report = checkResolvable(workspace(), { resolverHome: home });
    expect(about(report, 'briefing')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('a catalog built from gbrain\'s own bundled skills does not make the row present', async () => {
    const home = tmp('moved-home-');
    await buildSkillIndex({ catalog: 'gbrain-bundled', bundled: true }, { home });
    expect(about(checkResolvable(workspace(), { resolverHome: home }), 'briefing').map(i => i.type)).toEqual(['missing_file']);
  });

  test('a configured skill directory holding the folder makes the row present', () => {
    const home = tmp('moved-home-');
    const elsewhere = tmp('moved-elsewhere-');
    write(elsewhere, { 'briefing/SKILL.md': '---\nname: briefing\ndescription: A morning briefing.\n---\n# briefing\n' });
    write(home, { 'config.json': JSON.stringify({ skills: { resolver: { per_harness: { codex: { dirs: [elsewhere] } } } } }) });
    expect(about(checkResolvable(workspace(), { resolverHome: home }), 'briefing')).toEqual([]);
  });

  test('an empty folder in a configured directory, or a catalog entry whose SKILL.md is gone, does not make the row present', async () => {
    const home = tmp('moved-home-');
    const elsewhere = tmp('moved-elsewhere-');
    mkdirSync(join(elsewhere, 'briefing'), { recursive: true });
    write(home, { 'config.json': JSON.stringify({ skills: { resolver: { per_harness: { codex: { dirs: [elsewhere] } } } } }) });
    expect(about(checkResolvable(workspace(), { resolverHome: home }), 'briefing').map(i => i.type)).toEqual(['missing_file']);
    const indexed = tmp('moved-indexed-');
    write(indexed, { 'briefing/SKILL.md': '---\nname: briefing\ndescription: A morning briefing.\n---\n# briefing\n' });
    const staleHome = tmp('moved-home-');
    await buildSkillIndex({ catalog: 'other-catalog', dirs: [indexed] }, { home: staleHome });
    rmSync(join(indexed, 'briefing'), { recursive: true });
    expect(about(checkResolvable(workspace(), { resolverHome: staleHome }), 'briefing').map(i => i.type)).toEqual(['missing_file']);
  });

  test('a catalog entry whose SKILL.md is a directory, or a JSON entry with no SKILL.md path, does not make the row present', async () => {
    const indexed = tmp('moved-indexed-');
    write(indexed, { 'briefing/SKILL.md': '---\nname: briefing\ndescription: A morning briefing.\n---\n# briefing\n' });
    const home = tmp('moved-home-');
    await buildSkillIndex({ catalog: 'other-catalog', dirs: [indexed] }, { home });
    rmSync(join(indexed, 'briefing', 'SKILL.md'));
    mkdirSync(join(indexed, 'briefing', 'SKILL.md'));
    expect(about(checkResolvable(workspace(), { resolverHome: home }), 'briefing').map(i => i.type)).toEqual(['missing_file']);
    const jsonHome = tmp('moved-home-');
    const listing = join(tmp('moved-json-'), 'skills.json');
    writeFileSync(listing, JSON.stringify([{ id: 'briefing', name: 'briefing', description: 'A morning briefing.' }]));
    await buildSkillIndex({ catalog: 'json-catalog', fromJson: listing }, { home: jsonHome });
    expect(about(checkResolvable(workspace(), { resolverHome: jsonHome }), 'briefing').map(i => i.type)).toEqual(['missing_file']);
  });

  test('a catalog receipt with no source does not stop the check', async () => {
    const home = tmp('moved-home-');
    const elsewhere = tmp('moved-elsewhere-');
    write(elsewhere, { 'briefing/SKILL.md': '---\nname: briefing\ndescription: A morning briefing.\n---\n# briefing\n' });
    await buildSkillIndex({ catalog: 'other-catalog', dirs: [elsewhere] }, { home });
    const receipt = catalogFile(home, 'other-catalog', 'receipt.json');
    const doc = JSON.parse(readFileSync(receipt, 'utf8'));
    delete doc.catalog.source;
    writeFileSync(receipt, JSON.stringify(doc));
    expect(about(checkResolvable(workspace(), { resolverHome: home }), 'briefing')).toEqual([]);
  });

  test('a skill that did not move is still missing when another catalog has it', async () => {
    setMovedRegistryForTests(registry({ moved: ['retired-example'] }));
    const home = tmp('moved-home-');
    const elsewhere = tmp('moved-elsewhere-');
    write(elsewhere, { 'briefing/SKILL.md': '---\nname: briefing\ndescription: A morning briefing.\n---\n# briefing\n' });
    await buildSkillIndex({ catalog: 'other-catalog', dirs: [elsewhere] }, { home });
    expect(about(checkResolvable(workspace(), { resolverHome: home }), 'briefing').map(i => i.type)).toEqual(['missing_file']);
  });

  test('with the destination set, missing everywhere reports the move as a warning with the notice', () => {
    setMovedRegistryForTests(registry());
    const report = checkResolvable(workspace(), { resolverHome: tmp('moved-home-') });
    const issues = about(report, 'briefing');
    expect(issues.map(i => [i.type, i.severity])).toEqual([['moved_skill', 'warning']]);
    expect(issues[0]!.message).toContain('example-tool add briefing');
    expect(report.ok).toBe(true);
  });

  test('a manifest.json entry for a moved skill is graded the same way', () => {
    setMovedRegistryForTests(registry());
    const skillsDir = workspace();
    writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify({ skills: [{ name: 'query', path: 'query/SKILL.md' }, { name: 'briefing', path: 'briefing/SKILL.md' }] }));
    const issues = about(checkResolvable(skillsDir, { resolverHome: tmp('moved-home-') }), 'briefing');
    expect(issues.map(i => i.type)).toEqual(['moved_skill']);
    expect(issues[0]!.message).toContain('manifest.json');
    setMovedRegistryForTests(registry({ destination: null }));
    expect(about(checkResolvable(skillsDir, { resolverHome: tmp('moved-home-') }), 'briefing').map(i => i.type)).toEqual(['missing_file']);
  });
});

describe('skillpack reference --update-untouched: a moved skill', () => {
  const skill = (name: string, body: string) => `---\nname: ${name}\ntriggers:\n  - run the ${name} flow\n---\n# ${name}\n\n${body}\n`;
  function release(gbrainRoot: string, version: string): void {
    const skillsDir = join(gbrainRoot, 'skills');
    write(skillsDir, { 'demo/SKILL.md': skill('demo', version), 'other/SKILL.md': skill('other', version) });
    const historyPath = join(skillsDir, SKILLS_LOCK_HISTORY_FILENAME);
    const previous = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf-8')) : null;
    writeFileSync(historyPath, renderSkillsLockHistory(mergeSkillsLockHistory(previous, computeSkillsManifest(skillsDir))));
    writeFileSync(join(skillsDir, SKILLS_MANIFEST_FILENAME), renderSkillsManifest(skillsDir));
  }
  async function installedThenReleased() {
    const gbrainRoot = tmp('moved-update-gbrain-');
    write(gbrainRoot, { 'src/cli.ts': '// stub\n', 'openclaw.plugin.json': JSON.stringify({ name: 'gbrain-test', version: '0.0.1', skills: ['skills/demo', 'skills/other'] }) });
    release(gbrainRoot, 'v1');
    const ws = tmp('moved-update-ws-');
    const state = join(tmp('moved-update-home-'), 'state.json');
    const result = runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: null });
    await recordScaffoldBases(join(ws, 'skills'), result.files, { statePath: state });
    release(gbrainRoot, 'v2');
    return () => runSkillpackUpdate({ gbrainRoot, skillsRoot: skillsRootKey(join(ws, 'skills')), slugs: null, statePath: state, backups: join(dirname(state), 'backups'), dryRun: true, validate: () => [] });
  }

  test('with the destination set it is skipped as moved and says where it went; other skills still update', async () => {
    const update = await installedThenReleased();
    setMovedRegistryForTests(registry({ moved: ['demo'], kept: ['other'] }));
    const result = await update();
    const demo = result.skills.find(s => s.slug === 'demo')!;
    expect([demo.result, demo.reason]).toEqual(['skipped', 'moved']);
    expect(demo.notes.join('\n')).toContain('The demo skill moved to catalog-example');
    expect(result.skills.find(s => s.slug === 'other')!.result).toBe('would_update');
  });

  test('with the destination null it updates as before', async () => {
    const update = await installedThenReleased();
    setMovedRegistryForTests(registry({ destination: null, moved: ['demo'], kept: ['other'] }));
    const demo = (await update()).skills.find(s => s.slug === 'demo')!;
    expect(demo.result).toBe('would_update');
    expect(demo.notes).toEqual([]);
  });
});
