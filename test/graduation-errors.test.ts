/**
 * Engine graduation error contract (plan §8): one row per
 * GRADUATION_ERROR_CODES entry. Each refusal renders `why`, the expected
 * `fix.next`, a real argv (none only for `report`), a read-only
 * `fix.verify`, the registry row and exit code, and a docs anchor that
 * exists. Every emitted foresights argv names a real command, uses only flags
 * that command accepts, and `foresights migrate` argvs parse to the intended
 * graduation mode.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliRenderContext, toAgentError, type RenderedAction } from '../src/core/agent-output.ts';
import { CODES } from '../src/core/error-registry.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import type { OperationError } from '../src/core/ops/contract.ts';
import { GRADUATION_ERROR_CODES, type GraduationErrorCode } from '../src/core/persistence/engine-graduation.types.ts';
import {
  GRADUATION_DOCS, drainTimeoutError, embeddingDimensionMismatchError, engineGraduatedError, foreignHostBindingError,
  inProgressError, interruptedError, rollbackWritesLostError, sourceWriterHeldError, splitBrainError, targetAuthFailedError,
  targetDdlUnreachableError, targetNotEmptyError, targetUnsupportedError, unclassifiedTableError, unsupportedPlatformError,
  verifyFailedError,
} from '../src/core/persistence/graduation-errors.ts';
import { parseGraduationArgs, type GraduationMode } from '../src/commands/migrate-graduation.ts';

const ROOT = join(import.meta.dir, '..');
const tombstone = { targetDisplayUrl: 'postgresql://db.acme-example.test:5432/brain', movedTo: '/home/alice-example/.gbrain/brain.pglite.graduated-run1', runId: 'run1' };

interface Row {
  code: GraduationErrorCode;
  label: string;
  build: () => OperationError;
  next: RenderedAction['next'];
  exit: number;
  /** For `foresights migrate` fix argvs: the mode it must parse to. */
  mode?: GraduationMode;
}

const ROWS: Row[] = [
  { code: 'graduation_source_writer_held', label: 'live stdio serve', next: 'tell_user_to_run', exit: 1,
    build: () => sourceWriterHeldError({ owner: { pid: 4242, transport: 'stdio', is_self: false }, rerun: ['gbrain', 'migrate', '--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL'] }) },
  { code: 'graduation_source_writer_held', label: 'daemon, no serve owner', next: 'tell_user_to_run', exit: 1, mode: 'run',
    build: () => sourceWriterHeldError({ owner: null, pid: 99, subcommand: 'autopilot', rerun: ['gbrain', 'migrate', '--to', 'supabase', '--url-env', 'GBRAIN_TARGET_URL'] }) },
  { code: 'graduation_unclassified_table', label: 'newer target', next: 'tell_user_to_run', exit: 1,
    build: () => unclassifiedTableError({ relations: ['future_table'], side: 'target', cause: 'newer_schema' }) },
  { code: 'graduation_unclassified_table', label: 'missing inventory row', next: 'report', exit: 1,
    build: () => unclassifiedTableError({ relations: ['new_table'], side: 'source', cause: 'missing_inventory_row' }) },
  { code: 'graduation_embedding_dimension_mismatch', label: 'existing target', next: 'ask_user', exit: 1, mode: 'plan',
    build: () => embeddingDimensionMismatchError({ column: 'content_chunks.embedding', source: 'vector(1536)', target: 'vector(768)', host: 'db.acme-example.test' }) },
  { code: 'graduation_drain_timeout', label: 'blockers progressing', next: 'run', exit: 11, mode: 'resume',
    build: () => drainTimeoutError({ timeoutSec: 60, blockers: [{ kind: 'request', id: 'r1', detail: 'request r1 is running', needsUser: false }] }) },
  { code: 'graduation_drain_timeout', label: 'blocker needs a person', next: 'tell_user_to_run', exit: 11,
    build: () => drainTimeoutError({ timeoutSec: 60, blockers: [{ kind: 'writer_admin_lock', id: 'lock', detail: 'The writer admin lock is set.', argv: ['gbrain', 'sources', 'writer', 'unlock'], needsUser: true }] }) },
  { code: 'graduation_target_not_empty', label: 'foreign target', next: 'ask_user', exit: 1, mode: 'plan',
    build: () => targetNotEmptyError({ host: 'db.acme-example.test', tables: [{ relation: 'pages', rows: 12 }] }) },
  { code: 'graduation_foreign_host_binding', label: 'two-host transfer', next: 'tell_user_to_run', exit: 1,
    build: () => foreignHostBindingError({ sourceId: 'notes', ownerHost: 'host-b' }) },
  { code: 'graduation_verify_failed', label: 'first mismatch', next: 'run', exit: 1, mode: 'resume',
    build: () => verifyFailedError({ repeated: false, failures: [{ relation: 'pages', kind: 'digest', firstKey: '42', column: 'body', detail: 'pages digest differs' }] }) },
  { code: 'graduation_verify_failed', label: 'repeated mismatch', next: 'report', exit: 1,
    build: () => verifyFailedError({ repeated: true, failures: [{ relation: 'pages', kind: 'digest', detail: 'pages digest differs' }] }) },
  { code: 'graduation_interrupted', label: 'crashed run', next: 'run', exit: 1, mode: 'resume',
    build: () => interruptedError({ runId: 'run1', state: 'copying', dataDir: '/tmp/brain.pglite' }) },
  { code: 'graduation_in_progress', label: 'live run', next: 'wait', exit: 75, mode: 'status',
    build: () => inProgressError({ runId: 'run1', state: 'copying', pid: 7 }) },
  { code: 'graduation_split_brain', label: 'stray brain', next: 'ask_user', exit: 1, mode: 'resume',
    build: () => splitBrainError({ sourcePath: '/tmp/brain.pglite', strayPath: '/tmp/brain.pglite', strayRows: 3 }) },
  { code: 'graduation_rollback_writes_lost', label: 'confirmable page loss', next: 'ask_user', exit: 1, mode: 'rollback',
    build: () => rollbackWritesLostError({ final: false, planHash: 'ph_abc', losses: [{ relation: 'pages', rows: 2 }] }) },
  { code: 'graduation_rollback_writes_lost', label: 'withdrawal on target: final', next: 'report', exit: 1,
    build: () => rollbackWritesLostError({ final: true, losses: [{ relation: 'fact_withdrawals', rows: 1 }] }) },
  { code: 'graduation_target_auth_failed', label: 'password rotated', next: 'ask_user', exit: 1, mode: 'resume',
    build: () => targetAuthFailedError({ host: 'db.acme-example.test' }) },
  { code: 'graduation_target_ddl_unreachable', label: 'IPv6-only direct host', next: 'ask_user', exit: 1, mode: 'plan',
    build: () => targetDdlUnreachableError({ host: 'pooler.acme-example.test', ddlHost: 'db.acme-example.test' }) },
  { code: 'graduation_target_unsupported', label: 'no vector extension', next: 'ask_user', exit: 1, mode: 'plan',
    build: () => targetUnsupportedError({ requirement: 'vector', detail: 'the vector extension is not installed', host: 'db.acme-example.test' }) },
  { code: 'graduation_unsupported_platform', label: 'Windows with history', next: 'ask_user', exit: 1,
    build: () => unsupportedPlatformError({ platform: 'Windows' }) },
  { code: 'engine_graduated', label: 'graduating host (manifest past cutover)', next: 'run', exit: 1, mode: 'resume',
    build: () => engineGraduatedError({ tombstone, dataDir: '/tmp/brain.pglite', graduatingHost: true }) },
  { code: 'engine_graduated', label: 'stale CLI on another machine', next: 'tell_user_to_run', exit: 1,
    build: () => engineGraduatedError({ tombstone, dataDir: '/tmp/brain.pglite', graduatingHost: false, transport: 'cli' }) },
  { code: 'engine_graduated', label: 'stale MCP server config', next: 'tell_user_to_run', exit: 1,
    build: () => engineGraduatedError({ tombstone, dataDir: '/tmp/brain.pglite', graduatingHost: false, transport: 'stdio' }) },
];

function anchorsOf(path: string): Set<string> {
  const text = readFileSync(join(ROOT, path), 'utf8');
  const out = new Set<string>();
  for (const [, h] of text.matchAll(/^#{1,6}\s+(.+)$/gm)) out.add(h!.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-'));
  for (const [, id] of text.matchAll(/<a id="([^"]+)"><\/a>/g)) out.add(id!);
  return out;
}

const READ_ONLY_VERIFY = [/^(?:foresights|gbrain) migrate --status --json$/, /^(?:foresights|gbrain) migrate --to (postgres|supabase) --url-env \S+ --plan --json$/, /^(?:foresights|gbrain) doctor( |$)/, /^(?:foresights|gbrain) sources status /];

function assertArgvRunnable(argv: readonly string[], label: string): void {
  if (argv[0] !== 'gbrain') return;
  const command = argv[1]!;
  expect(CLI_COMMANDS.some(c => c.name === command) || command === 'sources', `${label}: unknown command ${command}`).toBe(true);
  const accepted = CLI_FLAG_REGISTRY[command];
  if (!accepted) return;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--')) expect(accepted, `${label}: ${command} does not accept ${a}`).toContain(a.split('=')[0]!);
  }
}

describe('graduation error contract', () => {
  test('every GRADUATION_ERROR_CODES entry has a registry row, a docs anchor and at least one fixture row', () => {
    for (const code of GRADUATION_ERROR_CODES) {
      const entry = (CODES as Record<string, { docs?: string }>)[code];
      expect(entry, `${code}: no registry row`).toBeDefined();
      expect(entry!.docs).toBe(GRADUATION_DOCS[code]);
      const [path, anchor] = GRADUATION_DOCS[code].split('#');
      expect(anchorsOf(path!).has(anchor!), `${code}: ${GRADUATION_DOCS[code]} anchor missing`).toBe(true);
      expect(ROWS.some(r => r.code === code), `${code}: no fixture row`).toBe(true);
    }
  });

  for (const row of ROWS) {
    test(`${row.code} (${row.label}) renders why, fix.next=${row.next}, argv and a read-only verify`, () => {
      const e = row.build();
      expect(e.code).toBe(row.code);
      const env = toAgentError(e, { transport: 'cli', command: 'migrate', render: cliRenderContext() });
      expect(env.code).toBe(row.code);
      expect(env.why?.length ?? 0).toBeGreaterThan(20);
      expect(env.suggestion.length).toBeGreaterThan(10);
      expect(env.docs).toContain(GRADUATION_DOCS[row.code].split('#')[1]!);
      const fix = env.fix!;
      expect(fix, 'every graduation refusal carries a fix').toBeDefined();
      expect(fix.next).toBe(row.next);
      if (row.next === 'report') expect(fix.argv).toBeUndefined();
      else expect(fix.argv?.length ?? 0).toBeGreaterThan(0);
      expect(fix.verify?.argv, 'read-only verify').toBeDefined();
      expect(READ_ONLY_VERIFY.some(re => re.test(fix.verify!.argv!.join(' '))), `verify not read-only: ${fix.verify!.argv!.join(' ')}`).toBe(true);
      expect(exitCodeForCode(row.code)).toBe(row.exit);
      if (fix.next === 'ask_user' || fix.next === 'tell_user_to_run') expect(fix.user_message ?? fix.then?.user_message ?? env.suggestion).toBeTruthy();
      for (const step of [fix, fix.then].filter(Boolean) as RenderedAction[]) {
        if (step.argv) assertArgvRunnable(step.argv, `${row.code} fix`);
        if (step.verify?.argv) assertArgvRunnable(step.verify.argv, `${row.code} verify`);
      }
      if (row.mode) {
        expect(fix.argv![1]).toBe('migrate');
        expect(parseGraduationArgs(fix.argv!.slice(2)).mode).toBe(row.mode);
      }
      const verifyArgv = fix.verify!.argv!;
      if (verifyArgv[1] === 'migrate') expect(['status', 'plan']).toContain(parseGraduationArgs(verifyArgv.slice(2)).mode);
    });
  }

  test('no refusal text or argv carries a URL password', () => {
    for (const row of ROWS) {
      const text = JSON.stringify(toAgentError(row.build(), { transport: 'cli', command: 'migrate', render: cliRenderContext() }));
      expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s/@"]+:[^\s/@"]+@/);
    }
  });

  test('a stale MCP config fix names the client restart; a stale CLI fix is one config command', () => {
    const mcp = engineGraduatedError({ tombstone, dataDir: '/tmp/brain.pglite', graduatingHost: false, transport: 'stdio' });
    expect(mcp.fix!.why).toContain('restart');
    const cli = engineGraduatedError({ tombstone, dataDir: '/tmp/brain.pglite', graduatingHost: false, transport: 'cli' });
    expect(cli.fix!.argv).toEqual(['gbrain', 'config', 'set', 'database_url', '<target_url>']);
    expect(cli.fix!.inputs?.[0]?.name).toBe('target_url');
    expect(cli.fix!.then).toBeUndefined();
  });

  test('a final rollback refusal offers no approval command', () => {
    const e = rollbackWritesLostError({ final: true, losses: [{ relation: 'oauth_tokens', rows: 1 }] });
    expect(e.fix!.argv).toBeUndefined();
    expect(JSON.stringify(e.fix)).not.toContain('--yes');
  });
});
