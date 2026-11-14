/**
 * GBRA-377 PR A: `gbrain skills index build|status|remove` and
 * `gbrain skills resolve` as a process, the interface adapters call.
 *
 * 1. Protects: exit codes (0 success and no_skill, 1 runtime error, 0 with
 *    --fail-open, 2 usage), the JSON documents on stdout matching the
 *    checked-in schemas, the commit-after-stdout rule, shadow logging, the
 *    route that sends only `skills index|resolve` to the resolver.
 * 2. Fails when: any of those drift.
 * 3. Every run uses a scratch GBRAIN_HOME with no brain (repo-less and
 *    brainless), once with a thin-client config.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { routeCommand } from '../src/cli/command-route.ts';
import { loadSchema, validate } from './helpers/json-schema-lite.ts';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'skres-cli-')); dirs.push(d); return d; };

function cli(home: string, args: string[], stdin?: string) {
  const r = Bun.spawnSync([process.execPath, 'src/cli.ts', ...args], {
    cwd: ROOT, env: { ...process.env, GBRAIN_HOME: home }, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe',
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const SKILLS = JSON.stringify([
  { id: 'gbrain:deploy', name: 'deploy', description: 'Ship a service to production after the tests pass' },
  { id: 'gbrain:reports', name: 'reports', description: 'Write weekly status reports' },
]);

describe('routing', () => {
  test('only skills index, skills resolve and skills library route to the resolver', () => {
    expect(routeCommand('skills', ['index', 'build']).command).toBe('skill-resolver');
    expect(routeCommand('skills', ['resolve', '--text', 'x']).command).toBe('skill-resolver');
    expect(routeCommand('skills', ['library', '--json']).command).toBe('skill-resolver');
    expect(routeCommand('skills', []).command).toBe('skills');
    expect(routeCommand('skills', ['--json']).command).toBe('skills');
    expect(routeCommand('skills', ['list']).command).toBe('skills');
  });
});

describe('gbrain skills (CLI)', () => {
  const home = tmp();
  test('build from stdin, resolve, dedupe after delivery, status and remove', () => {
    const b = cli(home, ['skills', 'index', 'build', '--catalog', 'c', '--from-json', '-', '--json'], SKILLS);
    expect(b.code).toBe(0);
    expect(validate(loadSchema('skill-resolver.v1.build-receipt'), JSON.parse(b.out))).toEqual([]);
    const r = cli(home, ['skills', 'resolve', '--text', 'deploy the service', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(validate(loadSchema('skill-resolver.v1.turn-output'), out)).toEqual([]);
    expect(out.suggestions[0].id).toBe('gbrain:deploy');
    const plain = cli(home, ['skills', 'resolve', '--text', 'deploy the service', '--session', 's1', '--harness', 'claude-code']);
    expect(plain.code).toBe(0);
    expect(plain.out.startsWith('<relevant_skills>\n')).toBe(true);
    expect(plain.out).toContain('Skill tool');
    const again = cli(home, ['skills', 'resolve', '--text', 'deploy the service', '--session', 's1', '--harness', 'claude-code']);
    expect([again.code, again.out]).toEqual([0, '']);
    const ack = cli(home, ['skills', 'resolve', '--input-json', '-', '--json'], JSON.stringify({ message: 'thanks!' }));
    expect([ack.code, JSON.parse(ack.out).no_skill_reason]).toEqual([0, 'ack']);
    const st = cli(home, ['skills', 'index', 'status', '--json']);
    expect(st.code).toBe(0);
    const status = JSON.parse(st.out) as { catalogs: { catalog: string; fresh: boolean; index_verified: boolean }[] };
    expect(status.catalogs.map(c => [c.catalog, c.fresh, c.index_verified])).toEqual([['c', true, true]]);
    const rm = cli(home, ['skills', 'index', 'remove', '--catalog', 'c']);
    expect(rm.code).toBe(0);
    expect(existsSync(join(home, '.gbrain', 'skill-index', 'c'))).toBe(false);
  }, 120_000);

  test('a runtime error exits 1 with the code on stderr and the error document under --json; --fail-open exits 0', () => {
    const h = tmp();
    const missing = cli(h, ['skills', 'resolve', '--catalog', 'nope', '--text', 'deploy', '--json']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('skill_index_missing');
    const doc = JSON.parse(missing.out);
    expect(validate(loadSchema('skill-resolver.v1.turn-output'), doc)).toEqual([]);
    expect([doc.error.code, doc.block]).toEqual(['skill_index_missing', '']);
    const open = cli(h, ['skills', 'resolve', '--catalog', 'nope', '--text', 'deploy', '--json', '--fail-open']);
    expect(open.code).toBe(0);
    expect([JSON.parse(open.out).error.code, JSON.parse(open.out).block]).toEqual(['skill_index_missing', '']);
    const quiet = cli(h, ['skills', 'resolve', '--catalog', 'nope', '--text', 'deploy', '--fail-open']);
    expect([quiet.code, quiet.out]).toEqual([0, '']);
    const unreadable = cli(h, ['skills', 'index', 'build', '--catalog', 'c', '--dir', join(h, 'no-such-dir')]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.err).toContain('skill_source_unreadable');
  }, 120_000);

  test('usage errors exit 2: unknown flag, no input, bad JSON, bad catalog name, bad catalog file', () => {
    const h = tmp();
    const cases: [string[], string | undefined, string][] = [
      [['skills', 'resolve', '--text', 'x', '--bogus'], undefined, 'unknown flag'],
      [['skills', 'resolve', '--input-json', '-'], '', 'skill_resolve_no_input'],
      [['skills', 'resolve', '--input-json', '-'], '{not json', 'skill_resolve_invalid_input'],
      [['skills', 'resolve', '--input-json', '-'], '[1]', 'skill_resolve_invalid_input'],
      [['skills', 'resolve'], undefined, 'skill_resolve_no_input'],
      [['skills', 'resolve', '--catalog', '../config', '--text', 'x'], undefined, 'skill_catalog_unknown'],
      [['skills', 'resolve', '--text', 'x', '--top-k', '9'], undefined, 'skill_resolve_invalid_input'],
      [['skills', 'resolve', '--text', 'x', '--min-match', 'weak'], undefined, 'skill_resolve_invalid_input'],
      [['skills', 'resolve', '--text', 'x', '--top-gate', 'high'], undefined, 'skill_resolve_invalid_input'],
      [['skills', 'resolve', '--text', 'x', '--top-gate', '101'], undefined, 'skill_resolve_invalid_input'],
      [['skills', 'index', 'build', '--catalog', 'c', '--from-json', '-'], '{"skills": 1}', 'skill_source_invalid'],
      [['skills', 'index', 'frobnicate'], undefined, 'Unknown subcommand'],
    ];
    for (const [args, stdin, needle] of cases) {
      const r = cli(h, args, stdin);
      expect({ args, code: r.code, has: r.err.includes(needle) }).toEqual({ args, code: 2, has: true });
    }
    expect(existsSync(join(h, 'config'))).toBe(false);
  }, 120_000);

  test('help for both verbs exits 0', () => {
    const h = tmp();
    for (const args of [['skills', 'index', '--help'], ['skills', 'index'], ['skills', 'resolve', '--help']]) {
      const r = cli(h, args);
      expect({ args, code: r.code, usage: r.out.includes('Usage: gbrain skills') }).toEqual({ args, code: 0, usage: true });
    }
  }, 60_000);

  test('shadow injects nothing on stdout and appends what it would have injected to --shadow-log; a thin-client config changes nothing', () => {
    const h = tmp();
    const gb = join(h, '.gbrain');
    expect(cli(h, ['skills', 'index', 'build', '--catalog', 'c', '--from-json', '-'], SKILLS).code).toBe(0);
    writeFileSync(join(gb, 'config.json'), JSON.stringify({ remote_mcp: { issuer_url: 'https://brain.example.invalid', mcp_url: 'https://brain.example.invalid/mcp' } }));
    const log = join(h, 'shadow.jsonl');
    const r = cli(h, ['skills', 'resolve', '--text', 'deploy', '--shadow', '--shadow-log', log, '--session', 'x']);
    expect([r.code, r.out]).toEqual([0, '']);
    const rec = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(rec.shadow).toBe(true);
    expect(rec.block).toContain('gbrain:deploy');
  }, 60_000);

  test('--top-gate empties the block with block_reason weak_top_match, and the output validates', () => {
    const h = tmp();
    expect(cli(h, ['skills', 'index', 'build', '--catalog', 'c', '--from-json', '-'], SKILLS).code).toBe(0);
    const gated = cli(h, ['skills', 'resolve', '--text', 'deploy', '--top-gate', '100', '--json']);
    const doc = JSON.parse(gated.out);
    expect(validate(loadSchema('skill-resolver.v1.turn-output'), doc)).toEqual([]);
    expect([gated.code, doc.block, doc.block_reason]).toEqual([0, '', 'weak_top_match']);
    expect(JSON.parse(cli(h, ['skills', 'resolve', '--text', 'deploy', '--top-gate', '0', '--json']).out).block).toContain('gbrain:deploy');
  }, 60_000);
});
