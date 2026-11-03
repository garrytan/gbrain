/**
 * GBRA-194: `gbrain bundled-skill`, the on-demand half of the spring-loaded skill
 * resolver: the skills index names it, so it must work wherever the index
 * was written, with no brain at all.
 *
 * Protects: reading a bundled skill and the files it names from the binary
 * with an empty HOME (no config, no brain, no MCP server, no skill
 * publication), the host-only audience on a thin client, and refusals that
 * say what to run instead.
 * Fails when: the command opens a brain, an index line cannot be loaded, a
 * dependency the skill's files name is refused, or a name/asset is treated
 * as a path.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { bundledCatalogId, bundledSkills } from '../src/core/skills/bundled.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-bundled-skill-'));
  roots.push(home);
  return home;
}
const SKILLS = join(import.meta.dir, '..', 'skills');
const cli = (home: string, args: string[]) => runCli(['bundled-skill', ...args], { env: { HOME: home, GBRAIN_HOME: home }, cwd: home });

describe('gbrain bundled-skill', () => {
  test('prints a skill from the binary with no brain, then the files it names', async () => {
    const home = emptyHome();
    const r = await cli(home, ['meeting-ingestion']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith(readFileSync(join(SKILLS, 'meeting-ingestion', 'SKILL.md'), 'utf8'))).toBe(true);
    expect(r.stdout).toContain('- _brain-filing-rules.md');
    expect(existsSync(join(home, '.gbrain'))).toBe(false);
  });

  test('a file the skill names, and a file that file names, both load', async () => {
    const home = emptyHome();
    const md = await cli(home, ['meeting-ingestion', '--asset', '_brain-filing-rules.md']);
    expect(md.exitCode).toBe(0);
    expect(md.stdout).toBe(readFileSync(join(SKILLS, '_brain-filing-rules.md'), 'utf8'));
    expect(md.stdout).toContain('_brain-filing-rules.json');
    const json = await cli(home, ['meeting-ingestion', '--asset=_brain-filing-rules.json', '--json']);
    expect(json.exitCode).toBe(0);
    const doc = JSON.parse(json.stdout);
    expect(doc).toMatchObject({ schema_version: 1, name: 'meeting-ingestion', asset: '_brain-filing-rules.json' });
    expect(doc.content).toBe(readFileSync(join(SKILLS, '_brain-filing-rules.json'), 'utf8'));
  });

  test('--json carries the body, the files and the catalog identity the index records', async () => {
    const r = await cli(emptyHome(), ['data-loss-gate', '--json']);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schema_version: 1, name: 'data-loss-gate', catalog: bundledCatalogId() });
    expect(doc.content).toBe(readFileSync(join(SKILLS, 'data-loss-gate', 'SKILL.md'), 'utf8'));
    expect(typeof doc.description).toBe('string');
    expect(doc.description.length).toBeGreaterThan(0);
  });

  test('no name lists every bundled skill', async () => {
    const r = await cli(emptyHome(), ['--json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).skills.map((s: { name: string }) => s.name)).toEqual(bundledSkills('owner').map(s => s.name));
  });

  test('an unknown name is skill_not_found with a did-you-mean; a path-shaped name or asset is never read', async () => {
    const home = emptyHome();
    const miss = await cli(home, ['meeting-ingestoin', '--json']);
    expect(miss.exitCode).not.toBe(0);
    expect(JSON.parse(miss.stdout)).toMatchObject({ code: 'skill_not_found' });
    expect(miss.stdout).toContain('meeting-ingestion');
    const path = await cli(home, ['../package.json']);
    expect(path.exitCode).not.toBe(0);
    expect(path.stdout).not.toContain('"name": "gbrain"');
    const asset = await cli(home, ['meeting-ingestion', '--asset', '../../package.json', '--json']);
    expect(asset.exitCode).not.toBe(0);
    expect(JSON.parse(asset.stdout)).toMatchObject({ code: 'skill_not_found' });
    expect(asset.stdout).toContain('_brain-filing-rules.md');
    const bare = await cli(home, ['meeting-ingestion', '--asset']);
    expect(bare.exitCode).not.toBe(0);
  });

  test('a thin client is not the brain host: host-only skills are not offered there', async () => {
    const home = emptyHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ remote_mcp: { mcp_url: 'https://brain.example.test/mcp' } }));
    const hostOnly = bundledSkills('owner').find(s => s.audience === 'owner')!;
    const r = await cli(home, [hostOnly.name, '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ code: 'skill_not_found' });
    const list = await cli(home, ['--json']);
    expect(JSON.parse(list.stdout).skills.map((s: { name: string }) => s.name)).toEqual(bundledSkills('downstream').map(s => s.name));
    expect((await cli(home, ['meeting-ingestion'])).exitCode).toBe(0);
  });
});

describe('gbrain bundled-skill: argument order', () => {
  test('--asset=<path> before the name, and a second name or unknown flag is refused', async () => {
    const home = emptyHome();
    const r = await cli(home, ['--asset=_brain-filing-rules.md', 'meeting-ingestion']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(readFileSync(join(SKILLS, '_brain-filing-rules.md'), 'utf8'));
    expect((await cli(home, ['meeting-ingestion', 'data-loss-gate'])).exitCode).not.toBe(0);
    expect((await cli(home, ['meeting-ingestion', '--bogus'])).exitCode).not.toBe(0);
    expect((await cli(home, ['meeting-ingestion', '--asset', 'a', '--asset', 'b'])).exitCode).not.toBe(0);
  });
});
