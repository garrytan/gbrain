/**
 * Unit tests for the v0.11.0 orchestrator's host-rewrite phase (Phase E).
 *
 * Focus is on the deterministic, side-effect-heavy parts that are the
 * highest risk: AGENTS.md marker injection, cron manifest rewriting for
 * builtin handlers, JSONL TODO emission for host-specific handlers, and
 * the safety guards (symlink escape, oversize, malformed JSON, mtime race).
 *
 * Full end-to-end orchestrator runs (schema, smoke, autopilot install)
 * live in test/e2e/migration-flow.test.ts (Lane C-5).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { __testing, type PendingHostWorkEntry } from '../src/commands/migrations/v0_11_0.ts';

const {
  injectAgentsMdMarker,
  rewriteCronManifest,
  findAgentsMdFiles,
  findCronManifests,
  BUILTIN_HANDLERS,
  AGENTS_MD_MARKER,
  loadPendingHostWork,
} = __testing;

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-v0_11_0-test-'));
  process.env.HOME = tmp;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeAgentsMd(dir: string, body: string) {
  const path = join(dir, 'AGENTS.md');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body);
  return path;
}

function writeCronJson(dir: string, jobs: unknown[]) {
  const path = join(dir, 'cron', 'jobs.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ jobs }, null, 2) + '\n');
  return path;
}
// Re-export dirname so writeCronJson can use it without another import
const dirname = (p: string) => p.substring(0, p.lastIndexOf('/'));

const DEFAULT_OPTS = {
  yes: true,
  mode: undefined,
  dryRun: false,
  hostDir: undefined,
  noAutopilotInstall: true,
};

describe('AGENTS.md marker injection', () => {
  test('injects the subagent-routing marker + ## section', () => {
    const dir = join(tmp, '.claude');
    const path = writeAgentsMd(dir, '# My AGENTS.md\n\nSome existing content.\n');
    const result = injectAgentsMdMarker(path, DEFAULT_OPTS);
    expect(result.injected).toBe(true);
    const after = readFileSync(path, 'utf-8');
    expect(after).toContain(AGENTS_MD_MARKER);
    expect(after).toContain('Subagent routing');
    expect(after).toContain('skills/conventions/subagent-routing.md');
    // Original content preserved
    expect(after).toContain('Some existing content.');
  });

  test('creates a timestamped .bak sibling before writing', () => {
    const dir = join(tmp, '.claude');
    const path = writeAgentsMd(dir, 'original content\n');
    injectAgentsMdMarker(path, DEFAULT_OPTS);
    const siblings = require('fs').readdirSync(dir) as string[];
    expect(siblings.some(n => n.startsWith('AGENTS.md.bak.'))).toBe(true);
    const bak = siblings.find(n => n.startsWith('AGENTS.md.bak.'))!;
    expect(readFileSync(join(dir, bak), 'utf-8')).toBe('original content\n');
  });

  test('idempotent — second call is a no-op', () => {
    const dir = join(tmp, '.claude');
    const path = writeAgentsMd(dir, '# Test\n');
    const first = injectAgentsMdMarker(path, DEFAULT_OPTS);
    expect(first.injected).toBe(true);
    const afterFirst = readFileSync(path, 'utf-8');

    const second = injectAgentsMdMarker(path, DEFAULT_OPTS);
    expect(second.injected).toBe(false);
    expect(second.skipReason).toContain('already has marker');
    expect(readFileSync(path, 'utf-8')).toBe(afterFirst);
  });

  test('--dry-run does not edit the file', () => {
    const dir = join(tmp, '.claude');
    const path = writeAgentsMd(dir, '# Test\n');
    const result = injectAgentsMdMarker(path, { ...DEFAULT_OPTS, dryRun: true });
    expect(result.injected).toBe(true);
    expect(result.skipReason).toBe('dry-run');
    const after = readFileSync(path, 'utf-8');
    expect(after).toBe('# Test\n');
    expect(after).not.toContain(AGENTS_MD_MARKER);
  });

  test('SKIPs symlink target that escapes scoped roots', () => {
    const outside = join(tmp, 'outside', 'AGENTS.md');
    mkdirSync(join(tmp, 'outside'), { recursive: true });
    writeFileSync(outside, '# escaped\n');

    const inside = join(tmp, '.claude', 'AGENTS.md');
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    symlinkSync(outside, inside);

    const result = injectAgentsMdMarker(inside, DEFAULT_OPTS);
    expect(result.injected).toBe(false);
    expect(result.skipReason).toContain('symlink target outside scoped root');
    // Outside file must not have been edited
    expect(readFileSync(outside, 'utf-8')).toBe('# escaped\n');
  });

  test('SKIPs files larger than 1 MB', () => {
    const dir = join(tmp, '.claude');
    const path = writeAgentsMd(dir, '#'.repeat(1_100_000));
    const result = injectAgentsMdMarker(path, DEFAULT_OPTS);
    expect(result.injected).toBe(false);
    expect(result.skipReason).toMatch(/1000000|bytes/);
  });
});

describe('cron manifest rewrite — gbrain builtins only', () => {
  test('rewrites `agentTurn` entries whose skill is a gbrain builtin', () => {
    const dir = join(tmp, '.claude');
    const path = writeCronJson(dir, [
      { schedule: '*/5 * * * *', kind: 'agentTurn', skill: 'extract' },
      { schedule: '*/10 * * * *', kind: 'agentTurn', skill: 'backlinks' },
    ]);

    const result = rewriteCronManifest(path, DEFAULT_OPTS);
    expect(result.rewritten).toBe(2);
    expect(result.todos_emitted).toBe(0);

    const after = JSON.parse(readFileSync(path, 'utf-8'));
    expect(after.jobs[0].kind).toBe('shell');
    expect(after.jobs[0].cmd).toContain('gbrain jobs submit extract');
    expect(after.jobs[0]._gbrain_migrated_by).toBe('v0.11.0');
    expect(after.jobs[1].kind).toBe('shell');
    expect(after.jobs[1].cmd).toContain('gbrain jobs submit backlinks');
  });

  test('emits JSONL TODO for non-builtin handlers (ea-inbox-sweep etc.)', () => {
    const dir = join(tmp, '.claude');
    const path = writeCronJson(dir, [
      { schedule: '0 */30 * * *', kind: 'agentTurn', skill: 'ea-inbox-sweep' },
      { schedule: '0 8 * * *', kind: 'agentTurn', skill: 'morning-briefing' },
    ]);

    const result = rewriteCronManifest(path, DEFAULT_OPTS);
    expect(result.rewritten).toBe(0);
    expect(result.todos_emitted).toBe(2);

    // Manifest itself unchanged (host hasn't registered handlers yet).
    const after = JSON.parse(readFileSync(path, 'utf-8'));
    expect(after.jobs[0].kind).toBe('agentTurn');
    expect(after.jobs[0].skill).toBe('ea-inbox-sweep');

    // JSONL TODO file created
    const todos = loadPendingHostWork();
    expect(todos.length).toBe(2);
    const handlers = todos.map(t => t.handler);
    expect(handlers).toContain('ea-inbox-sweep');
    expect(handlers).toContain('morning-briefing');
    expect(todos[0].status).toBe('pending');
    expect(todos[0].type).toBe('cron-handler-needs-host-registration');
  });

  test('mixed manifest: rewrites builtins + emits TODOs for non-builtins in one pass', () => {
    const dir = join(tmp, '.claude');
    const path = writeCronJson(dir, [
      { schedule: '*/5 * * * *', kind: 'agentTurn', skill: 'sync' },          // builtin
      { schedule: '0 */30 * * *', kind: 'agentTurn', skill: 'ea-inbox-sweep' }, // non-builtin
      { schedule: '*/10 * * * *', kind: 'agentTurn', skill: 'embed' },          // builtin
    ]);

    const result = rewriteCronManifest(path, DEFAULT_OPTS);
    expect(result.rewritten).toBe(2);
    expect(result.todos_emitted).toBe(1);

    const after = JSON.parse(readFileSync(path, 'utf-8'));
    expect(after.jobs[0].kind).toBe('shell'); // sync rewritten
    expect(after.jobs[1].kind).toBe('agentTurn'); // ea-inbox-sweep left alone
    expect(after.jobs[2].kind).toBe('shell'); // embed rewritten

    const todos = loadPendingHostWork();
    expect(todos.length).toBe(1);
    expect(todos[0].handler).toBe('ea-inbox-sweep');
  });

  test('idempotent: second run does not re-rewrite already-migrated entries', () => {
    const dir = join(tmp, '.claude');
    const path = writeCronJson(dir, [
      { schedule: '*/5 * * * *', kind: 'agentTurn', skill: 'sync' },
    ]);
    const first = rewriteCronManifest(path, DEFAULT_OPTS);
    expect(first.rewritten).toBe(1);
    const second = rewriteCronManifest(path, DEFAULT_OPTS);
    expect(second.rewritten).toBe(0);
  });

  test('TODO dedupe: running twice does not duplicate JSONL rows', () => {
    const dir = join(tmp, '.claude');
    const path = writeCronJson(dir, [
      { schedule: '*/30 * * * *', kind: 'agentTurn', skill: 'ea-inbox-sweep' },
    ]);
    rewriteCronManifest(path, DEFAULT_OPTS);
    rewriteCronManifest(path, DEFAULT_OPTS);
    const todos = loadPendingHostWork();
    expect(todos.length).toBe(1);
  });

  test('SKIPs malformed JSON manifest with a warning', () => {
    const dir = join(tmp, '.claude', 'cron');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'jobs.json');
    writeFileSync(path, '{ this is not valid json');
    const result = rewriteCronManifest(path, DEFAULT_OPTS);
    expect(result.rewritten).toBe(0);
    expect(result.skipReason).toContain('malformed JSON');
  });

  test('SKIPs manifest with no recognizable entry shape', () => {
    const dir = join(tmp, '.claude', 'cron');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'jobs.json');
    writeFileSync(path, JSON.stringify({ config: { enabled: true } }));
    const result = rewriteCronManifest(path, DEFAULT_OPTS);
    expect(result.rewritten).toBe(0);
    expect(result.skipReason).toContain('entries array');
  });

  test('--dry-run does not touch the file', () => {
    const dir = join(tmp, '.claude');
    const path = writeCronJson(dir, [
      { schedule: '*/5 * * * *', kind: 'agentTurn', skill: 'sync' },
    ]);
    const before = readFileSync(path, 'utf-8');
    const result = rewriteCronManifest(path, { ...DEFAULT_OPTS, dryRun: true });
    expect(result.rewritten).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});

describe('findAgentsMdFiles + findCronManifests scoping', () => {
  test('finds AGENTS.md in $HOME/.claude and $HOME/.openclaw scopes', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'AGENTS.md'), '# claude\n');
    mkdirSync(join(tmp, '.openclaw'), { recursive: true });
    writeFileSync(join(tmp, '.openclaw', 'AGENTS.md'), '# openclaw\n');

    const found = findAgentsMdFiles(DEFAULT_OPTS);
    expect(found.length).toBe(2);
    expect(found.some(p => p.includes('.claude'))).toBe(true);
    expect(found.some(p => p.includes('.openclaw'))).toBe(true);
  });

  test('does NOT walk $PWD unless --host-dir is passed', () => {
    mkdirSync(join(tmp, 'project'), { recursive: true });
    writeFileSync(join(tmp, 'project', 'AGENTS.md'), '# project\n');
    // No --host-dir
    const found = findAgentsMdFiles(DEFAULT_OPTS);
    expect(found.some(p => p.includes('/project/'))).toBe(false);

    // With --host-dir
    const foundWithHostDir = findAgentsMdFiles({ ...DEFAULT_OPTS, hostDir: join(tmp, 'project') });
    expect(foundWithHostDir.some(p => p.includes('/project/'))).toBe(true);
  });

  test('findCronManifests picks up cron/jobs.json under scoped roots', () => {
    mkdirSync(join(tmp, '.claude', 'cron'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'cron', 'jobs.json'), JSON.stringify({ jobs: [] }));
    const found = findCronManifests(DEFAULT_OPTS);
    expect(found.length).toBe(1);
    expect(found[0]).toContain('jobs.json');
  });
});

describe('BUILTIN_HANDLERS — lock the canonical set', () => {
  test('includes exactly the seven v0.11.0 builtins', () => {
    expect([...BUILTIN_HANDLERS].sort()).toEqual([
      'autopilot-cycle', 'backlinks', 'embed', 'extract', 'import', 'lint', 'sync',
    ]);
  });
});
