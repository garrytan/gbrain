/**
 * #8002: Tier 2 (e2e.yml) must wire gbrain's MCP server into the file
 * OpenClaw 2026.4.9 reads, and every Tier 2 test must prove the agent called
 * a gbrain tool. The job used to write `mcpServers` into
 * ~/.openclaw/config.json, which OpenClaw never reads (it reads
 * `mcp.servers` in ~/.openclaw/openclaw.json), so the agent ran with no gbrain
 * tools while every test checked only exit code and non-empty output.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { tapToolCalls } from '../../scripts/mcp-tap-calls.ts';
import { STARTER_OPS } from '../../src/mcp/surface.ts';

const REPO = join(import.meta.dir, '../..');
type Step = { name?: string; run?: string; env?: Record<string, string> };
const tier2 = (load(readFileSync(join(REPO, '.github/workflows/e2e.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }).jobs.tier2!;

/** A stand-in for the openclaw CLI: `mcp set` stores the JSON, `mcp show` prints it (or drops it when DROP=1). */
function fakeOpenclaw(dir: string): string {
  const bin = join(dir, 'openclaw');
  writeFileSync(bin, `#!/usr/bin/env bash
store="${dir}/saved.json"
case "$1 $2" in
  "mcp set") printf '%s' "$4" > "$store" ;;
  "mcp show") if [ "\${DROP:-}" = 1 ] || [ ! -f "$store" ]; then echo 'No MCP server named "gbrain"'; exit 1; fi; cat "$store" ;;
  *) exit 64 ;;
esac
`);
  chmodSync(bin, 0o755);
  return bin;
}

function configure(env: Record<string, string | undefined>) {
  return spawnSync('bash', ['scripts/ci-openclaw-mcp.sh'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('Tier 2 OpenClaw MCP wiring (#8002)', () => {
  test('e2e.yml registers gbrain through scripts/ci-openclaw-mcp.sh, never through config.json', () => {
    const cfg = tier2.steps.find(s => s.name === 'Configure OpenClaw MCP')!;
    expect(cfg.run).toBe('bash scripts/ci-openclaw-mcp.sh');
    expect(cfg.env!.DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5432/gbrain_test');
    for (const step of tier2.steps) {
      expect(step.run ?? '').not.toContain('.openclaw/config.json');
      expect(step.run ?? '').not.toContain('mcpServers');
    }
    const run = tier2.steps.find(s => s.name === 'Run Tier 2 skill tests')!;
    expect(cfg.env!.GBRAIN_TEST_TIER2_MCP_TAP_LOG).toBe('${{ runner.temp }}/gbrain-mcp-tap.jsonl');
    expect(run.env!.GBRAIN_TEST_TIER2_MCP_TAP_LOG).toBe(cfg.env!.GBRAIN_TEST_TIER2_MCP_TAP_LOG);
    const names = tier2.steps.map(s => s.name);
    expect(names.indexOf('Configure OpenClaw MCP')).toBeLessThan(names.indexOf('Run Tier 2 skill tests'));
  });

  test('the script saves gbrain behind the tap with openclaw mcp set and checks it reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-oc-mcp-'));
    try {
      const tap = join(dir, 'tap.jsonl');
      writeFileSync(tap, 'stale\n');
      const r = configure({ OPENCLAW: fakeOpenclaw(dir), DATABASE_URL: 'postgresql://u@localhost:5432/db', GBRAIN_TEST_TIER2_MCP_TAP_LOG: tap });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'saved.json'), 'utf8'))).toEqual({
        command: 'bash',
        args: ['scripts/ci-mcp-tap.sh', tap, '--', 'bun', 'run', 'src/cli.ts', 'serve', '--surface', 'starter'],
        cwd: REPO,
        env: { DATABASE_URL: 'postgresql://u@localhost:5432/db' },
      });
      expect(readFileSync(tap, 'utf8')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the script fails when OpenClaw does not report the saved server, or an input is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-oc-mcp-'));
    try {
      const base = { OPENCLAW: fakeOpenclaw(dir), DATABASE_URL: 'postgresql://u@localhost/db', GBRAIN_TEST_TIER2_MCP_TAP_LOG: join(dir, 't') };
      const dropped = configure({ ...base, DROP: '1' });
      expect(dropped.status).not.toBe(0);
      expect(dropped.stderr).toContain('OpenClaw does not report the gbrain MCP server');
      expect(configure({ ...base, DATABASE_URL: undefined }).status).not.toBe(0);
      expect(configure({ ...base, GBRAIN_TEST_TIER2_MCP_TAP_LOG: undefined }).status).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the server stays under the model API tool cap: it serves the starter surface', () => {
    // OpenClaw's default agent model is openai/gpt-5.4, and OpenAI refuses a
    // request with more than 128 tools. OpenClaw adds about 31 of its own;
    // gbrain's full surface is 158 tools, the starter surface 31.
    const script = readFileSync(join(REPO, 'scripts/ci-openclaw-mcp.sh'), 'utf8');
    expect(script).toContain('"serve", "--surface", "starter"');
    expect(STARTER_OPS.size).toBeLessThanOrEqual(64);
    for (const op of ['put_page', 'search', 'query', 'whoami', 'list_pages']) expect(STARTER_OPS.has(op)).toBe(true);
  });

  test('the tap passes the stream through unchanged and logs what the client sent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mcp-tap-'));
    try {
      const log = join(dir, 'tap.jsonl');
      const input = [
        '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"x"}}}',
      ].join('\n') + '\n';
      const r = spawnSync('bash', ['scripts/ci-mcp-tap.sh', log, '--', 'cat'], { cwd: REPO, input, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(input);
      expect(readFileSync(log, 'utf8')).toBe(input);
      expect(tapToolCalls(readFileSync(log, 'utf8'))).toEqual(['search']);
      expect(spawnSync('bash', ['scripts/ci-mcp-tap.sh', log, 'cat'], { cwd: REPO }).status).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('tapToolCalls counts only tools/call requests, batches included', () => {
    const handshakeOnly = '{"jsonrpc":"2.0","id":0,"method":"initialize"}\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    expect(tapToolCalls(handshakeOnly)).toEqual([]);
    expect(tapToolCalls('')).toEqual([]);
    expect(tapToolCalls('not json\n{"method":"tools/call","params":{}}\n')).toEqual([]);
    expect(tapToolCalls('[{"method":"tools/call","params":{"name":"put_page"}},{"method":"ping"}]\n{"method":"tools/call","params":{"name":"get_health"}}')).toEqual(['put_page', 'get_health']);
  });

  test('every Tier 2 test requires a gbrain tool call, and the file needs the tap log to run', () => {
    const src = readFileSync(join(REPO, 'test/e2e/skills.test.ts'), 'utf8');
    const runs = src.match(/runOpenClaw\(\n/g) ?? [];
    expect(runs.length).toBe(3);
    expect(src.match(/gbrainToolCalls\(\(\) => runOpenClaw\(/g)).toHaveLength(3);
    expect(src.match(/expect\(calls\.length, /g)).toHaveLength(3);
    expect(src).toContain("if (!process.env.GBRAIN_TEST_TIER2_MCP_TAP_LOG) return { ok: false");
    expect(existsSync(join(REPO, 'scripts/ci-mcp-tap.sh'))).toBe(true);
  });
});
