/**
 * E2E: v0.11.0 migration-flow against real Postgres + temp $HOME.
 *
 * Exercises the full orchestrator from Phase A (schema apply via
 * `gbrain init --migrate-only`) through Phase G (completed.jsonl append),
 * skipping Phase F (autopilot install) to avoid writing a launchd plist
 * or crontab entry on the CI host. Worker supervision + autopilot-cycle
 * handler are covered by the unit-layer tests (test/handlers.test.ts and
 * test/autopilot-resolve-cli.test.ts); this E2E locks the schema → prefs
 * → host-rewrite → completed.jsonl chain against a live database.
 *
 * Gated by DATABASE_URL — skips gracefully when unset per CLAUDE.md
 * lifecycle.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { v0_11_0 } from '../../src/commands/migrations/v0_11_0.ts';
import { loadPreferences, loadCompletedMigrations } from '../../src/core/preferences.ts';
import { hasDatabase } from './helpers.ts';

const SKIP = !hasDatabase();
const describeE2E = SKIP ? describe.skip : describe;
const DATABASE_URL = process.env.DATABASE_URL ?? '';

let tmp: string;
let origHome: string | undefined;
let origPath: string | undefined;
let fakeBinDir: string;
const CLI_PATH = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

// Module-level PATH shim. The orchestrator shells out to `gbrain init
// --migrate-only` and `gbrain jobs smoke`. On source-install test envs
// there's no `gbrain` on $PATH. Install a tiny bash shim that `exec`s
// `bun run src/cli.ts` and prepend it to $PATH before any tests import
// the orchestrator. Running at module-init (not beforeAll) guarantees
// the shim exists before Bun's test runner loads described blocks.
if (!SKIP) {
  origPath = process.env.PATH;
  fakeBinDir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-bin-'));
  const shim = join(fakeBinDir, 'gbrain');
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\nexec bun run "${CLI_PATH}" "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${fakeBinDir}:${origPath ?? ''}`;
  console.log('[migration-flow.e2e] shim installed at', shim, 'PATH prepended');
}

function freshTempHome(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `gbrain-e2e-migration-${label}-`));
  process.env.HOME = dir;
  // Seed config so Phase A's `gbrain init --migrate-only` has a target.
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(
    join(dir, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'postgres', database_url: DATABASE_URL }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return dir;
}

beforeAll(() => {
  if (SKIP) {
    console.log('[migration-flow.e2e] DATABASE_URL not set — skipping.');
    return;
  }
  origHome = process.env.HOME;
});

afterAll(() => {
  if (SKIP) return;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  try { if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  if (SKIP) return;
  try { if (tmp) rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const COMMON_OPTS = {
  yes: true,
  mode: 'pain_triggered' as const,
  dryRun: false,
  hostDir: undefined,
  noAutopilotInstall: true, // critical: don't install launchd/systemd/crontab on CI
};

describeE2E('E2E: v0.11.0 orchestrator against live Postgres', () => {
  test('fresh install flow: schema → smoke → prefs → host-rewrite → completed', async () => {
    tmp = freshTempHome('fresh');
    const result = await v0_11_0.orchestrator(COMMON_OPTS);

    // Orchestrator returns a structured result (status is `complete` when
    // no pending-host-work TODOs fired, `partial` otherwise).
    expect(result.version).toBe('0.11.0');
    expect(['complete', 'partial']).toContain(result.status);

    // Phase D: preferences.json exists with 0o600 + mode=pain_triggered.
    const prefsPath = join(tmp, '.gbrain', 'preferences.json');
    expect(existsSync(prefsPath)).toBe(true);
    expect(statSync(prefsPath).mode & 0o777).toBe(0o600);
    const prefs = loadPreferences();
    expect(prefs.minion_mode).toBe('pain_triggered');
    expect(prefs.set_at).toBeTruthy();
    expect(prefs.set_in_version).toBeTruthy();

    // Bug 3 (v0.14.2) — orchestrator no longer writes completed.jsonl.
    // The runner (apply-migrations.ts) persists the result after the
    // orchestrator returns. A direct orchestrator call in E2E leaves the
    // ledger empty; the runner path is tested separately in
    // test/apply-migrations.test.ts + test/migration-resume.test.ts.
    const completed = loadCompletedMigrations();
    const v0110Entries = completed.filter(e => e.version === '0.11.0');
    expect(v0110Entries.length).toBe(0);

    // Phase F is skipped per COMMON_OPTS — autopilot should NOT have been
    // installed on this host.
    expect(result.autopilot_installed).toBe(false);
  }, 60_000);

  test('idempotent rerun: second invocation is a safe no-op', async () => {
    tmp = freshTempHome('rerun');
    const first = await v0_11_0.orchestrator(COMMON_OPTS);
    expect(['complete', 'partial']).toContain(first.status);

    const second = await v0_11_0.orchestrator(COMMON_OPTS);
    expect(['complete', 'partial']).toContain(second.status);

    // Bug 3 (v0.14.2) — orchestrator does not write completed.jsonl, so
    // repeated direct invocations don't accumulate ledger entries. Assert
    // the preferences state stays stable (the real idempotency signal for
    // this orchestrator is "running again doesn't corrupt preferences").
    expect(loadPreferences().minion_mode).toBe('pain_triggered');
    const completed = loadCompletedMigrations();
    expect(completed.filter(e => e.version === '0.11.0').length).toBe(0);
  }, 90_000);

  test('host rewrite: builtin handlers auto-rewritten, non-builtins queued as JSONL TODOs', async () => {
    tmp = freshTempHome('host-rewrite');
    // Fixture: AGENTS.md + cron/jobs.json with a mix of gbrain-builtin and
    // non-builtin handlers.
    const claudeDir = join(tmp, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'AGENTS.md'),
      '# Test AGENTS.md\n\nSome existing content referencing sessions_spawn routing.\n',
    );
    mkdirSync(join(claudeDir, 'cron'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'cron', 'jobs.json'),
      JSON.stringify({
        jobs: [
          { schedule: '*/5 * * * *', kind: 'agentTurn', skill: 'sync' },              // builtin
          { schedule: '0 */30 * * *', kind: 'agentTurn', skill: 'ea-inbox-sweep' },    // non-builtin
          { schedule: '*/10 * * * *', kind: 'agentTurn', skill: 'embed' },             // builtin
          { schedule: '0 8 * * *', kind: 'agentTurn', skill: 'morning-briefing' },      // non-builtin
        ],
      }, null, 2) + '\n',
    );

    const result = await v0_11_0.orchestrator(COMMON_OPTS);

    // Builtins rewritten in place; non-builtins left alone.
    const cronAfter = JSON.parse(readFileSync(join(claudeDir, 'cron', 'jobs.json'), 'utf-8'));
    expect(cronAfter.jobs[0].kind).toBe('shell');       // sync (builtin)
    expect(cronAfter.jobs[0].cmd).toContain('gbrain jobs submit sync');
    expect(cronAfter.jobs[1].kind).toBe('agentTurn');   // ea-inbox-sweep (non-builtin)
    expect(cronAfter.jobs[2].kind).toBe('shell');       // embed (builtin)
    expect(cronAfter.jobs[3].kind).toBe('agentTurn');   // morning-briefing (non-builtin)

    // files_rewritten counts the 2 builtin rewrites.
    expect(result.files_rewritten).toBeGreaterThanOrEqual(2);

    // pending_host_work counts the 2 non-builtin TODOs.
    expect(result.pending_host_work).toBe(2);

    // Status is "partial" because non-builtin TODOs remain.
    expect(result.status).toBe('partial');

    // AGENTS.md got the marker injected.
    const agentsMdAfter = readFileSync(join(claudeDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMdAfter).toContain('gbrain:subagent-routing v0.11.0');
    expect(agentsMdAfter).toContain('skills/conventions/subagent-routing.md');

    // JSONL TODO file written under ~/.gbrain/migrations/.
    const jsonlPath = join(tmp, '.gbrain', 'migrations', 'pending-host-work.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
    expect(lines.length).toBe(2);
    const todos = lines.map(l => JSON.parse(l));
    const handlers = todos.map(t => t.handler).sort();
    expect(handlers).toEqual(['ea-inbox-sweep', 'morning-briefing']);
    for (const todo of todos) {
      expect(todo.type).toBe('cron-handler-needs-host-registration');
      expect(todo.status).toBe('pending');
      expect(todo.manifest_path).toContain('cron/jobs.json');
    }
  }, 90_000);

  test('resumable: partial run → orchestrator re-run → complete', async () => {
    tmp = freshTempHome('resumable');
    // Simulate a stopgap-written partial entry BEFORE running the orchestrator.
    mkdirSync(join(tmp, '.gbrain', 'migrations'), { recursive: true });
    writeFileSync(
      join(tmp, '.gbrain', 'migrations', 'completed.jsonl'),
      JSON.stringify({
        version: '0.11.0',
        status: 'partial',
        apply_migrations_pending: true,
        mode: 'pain_triggered',
        source: 'fix-v0.11.0.sh',
        ts: new Date().toISOString(),
      }) + '\n',
    );

    // Orchestrator re-running on a partial → should succeed (schema apply
    // and smoke are idempotent; prefs are preserved from the partial
    // record; host-rewrite runs its safe-skip pass). Per Bug 3 (v0.14.2),
    // the orchestrator itself doesn't append to completed.jsonl — the
    // runner does. The stopgap's partial entry stays unchanged here.
    const result = await v0_11_0.orchestrator(COMMON_OPTS);
    expect(['complete', 'partial']).toContain(result.status);

    const completed = loadCompletedMigrations();
    const v0110 = completed.filter(e => e.version === '0.11.0');
    // Just the stopgap partial — orchestrator doesn't add its own entry.
    expect(v0110.length).toBe(1);
    expect(v0110[0].status).toBe('partial');
    expect(v0110[0].source).toBe('fix-v0.11.0.sh');
  }, 90_000);
});
