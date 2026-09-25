import { afterEach, expect, spyOn, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { frozenVerbWriteError, runMemoryWrite, writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import type { WriteReceipt } from '../src/core/persistence/types.ts';
import { reportPersistenceCliError, runDeferredPersistenceCommand } from '../src/commands/persistence-delegate.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { printSyncResult, type SyncResult } from '../src/commands/sync.ts';
import { writeDiagnostic, type Pending } from '../src/core/persistence/sync-run.ts';
import { WRITE_BLOCKED_REASONS } from '../src/core/persistence/types.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { ERROR_SCHEMA } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';
import { writerNextAction } from '../src/core/persistence/diagnostics.ts';

const requestId = '20000000-0000-4000-8000-000000000001';
const receipt: WriteReceipt = { request_id: requestId, state: 'conflict', retry_after_ms: null };
const driftMessage = 'The canonical file contains an uncoordinated local edit.';
afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

test('deferred reconciliation help does not acquire an engine', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runDeferredPersistenceCommand('sources', ['reconcile', '--help'], async () => { throw new Error('Help must not connect.'); });
    expect(log.mock.calls.flat().join('\n')).toContain('sources reconcile');
  } finally { log.mockRestore(); }
});

test('file/database drift preserves v1 vocabulary and names reviewed repair without privilege escalation', async () => {
  const cause = new OperationError('source_changed', driftMessage);
  cause.writeError = 'source_changed';
  cause.writeRequest = receipt;
  let error: OperationError | undefined;
  try { await runMemoryWrite(async () => { throw cause; }); } catch (caught) { error = caught as OperationError; }
  const body = error!.toJSON();
  expect(body).toMatchObject({ error: 'scope_denied', protocol_version: 1, write_error: 'source_changed',
    detail: 'file_database_drift', write_request: receipt });
  expect(body.message).toContain('file and database disagree');
  expect(body.suggestion).toContain('gbrain sources reconcile');
  expect(body.suggestion).toContain('--preview');
  expect(body.suggestion).toContain('new request_id');
  expect(body.suggestion).not.toMatch(/sources writer (claim|activate|transfer)/);
  expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
  await expect(runMemoryWrite(async () => { throw error; })).rejects.toBe(error);
});

test('pre-admission drift uses the same diagnosis without inventing a receipt', async () => {
  let error: OperationError | undefined;
  try { await runMemoryWrite(async () => { throw new OperationError('source_changed', driftMessage); }); }
  catch (caught) { error = caught as OperationError; }
  expect(error!.toJSON()).toMatchObject({ error: 'scope_denied', write_error: 'source_changed', detail: 'file_database_drift' });
  expect(error!.toJSON()).not.toHaveProperty('write_request');
});

test('human output leads with source_changed, JSON stays frozen and clean, both retain the request ID', async () => {
  const error = frozenVerbWriteError(receipt, 'source_changed', driftMessage);
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  let stdout = '';
  try {
    expect(await reportPersistenceCliError(error, true, async text => { stdout += text; })).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({ error: 'scope_denied', write_error: 'source_changed', write_request: receipt });
    const lines = stderr.mock.calls.map(args => args.join(' '));
    expect(lines[0]).toStartWith('Error [source_changed]:');
    expect(lines.join('\n')).toContain(`Request: ${requestId} (conflict)`);
    expect(stdout).not.toContain('Error [');
  } finally { stderr.mockRestore(); }
});

test('owner-unavailable pending writes name their blocked reason in human and JSON output', async () => {
  const pending: WriteReceipt = { request_id: requestId, state: 'queued', retry_after_ms: 1000, blocked_reason: 'owner_unavailable' };
  const error = frozenVerbWriteError(pending);
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  let stdout = '';
  try {
    expect(await reportPersistenceCliError(error, true, async text => { stdout += text; })).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({ error: 'unavailable', write_error: 'write_pending', write_request: pending });
    const lines = stderr.mock.calls.map(args => args.join(' ')).join('\n');
    expect(lines).toContain('Error [write_pending]:');
    expect(lines).toContain(`Request: ${requestId} (queued, owner_unavailable)`);
  } finally { stderr.mockRestore(); }
});

test.each(['queued', 'running', 'recovering'] as const)('%s cannot look committed or suggest a replacement request', state => {
  const body = frozenVerbWriteError({ ...receipt, state, retry_after_ms: 1000 }, 'write_pending').toJSON();
  expect(body.message).toContain('not committed');
  expect(body.suggestion).toContain(`same arguments and request_id ${requestId}`);
  expect(body.suggestion).toContain('Do not submit a new request_id');
  expect(body.write_request).not.toHaveProperty('revision');
});

test('CLI JSON and frozen error serialization retain the same allowlisted health', async () => {
  const diagnostic = { age_ms: 120000, assessment: 'stalled' as const,
    reason: 'cause_unknown' as const, next_action: 'inspect_owner' as const };
  const error = frozenVerbWriteError({ request_id: requestId, state: 'queued', retry_after_ms: 30000,
    diagnostic: { ...diagnostic, ...{ raw_error: 'PRIVATE_DRIVER_ERROR' } } }, 'write_pending');
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  let stdout = '';
  try {
    expect(await reportPersistenceCliError(error, true, async text => { stdout += text; })).toBe(true);
    const body = JSON.parse(stdout);
    expect(body.write_request.diagnostic).toEqual(diagnostic);
    expect(body.suggestion).toContain(requestId);
    expect(body.suggestion).toContain('gbrain sources writer status');
    expect(stdout).not.toContain('PRIVATE_DRIVER_ERROR');
    expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
  } finally { stderr.mockRestore(); }
});

test('unrecognized errors cannot echo private content, absolute paths, or credentials', () => {
  const privateMessage = '/private/source/example.md contains secret private fixture content with credential=redacted';
  for (const code of ['source_changed', 'storage_error', 'invalid_params', 'unknown_error']) {
    const detail = writeFailureDiagnostic(code, privateMessage);
    expect(JSON.stringify(detail)).not.toContain(privateMessage);
    expect(JSON.stringify(detail)).not.toContain('/private');
    expect(JSON.stringify(detail)).not.toContain('credential');
  }
  expect(writeFailureDiagnostic('source_changed', 'Newer working-tree bytes and the current page disagree with this pinned Git import.').reason)
    .toBe('pinned_git_worktree_conflict');
  expect(writeFailureDiagnostic('owner_unavailable').reason).toBe('owner_unavailable');
  expect(writeFailureDiagnostic('permission_denied').reason).toBe('permission_denied');
});

test.each(['blocked_by_failures', 'partial'] as const)('managed %s rendering uses the receipt instead of generic parse/skip advice', status => {
  const pending = status === 'partial';
  const result: SyncResult = { status, fromCommit: null, toCommit: '0123456789', added: 0, modified: 0, deleted: 0,
    renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], failedFiles: pending ? 0 : 1,
    managedWrite: { source_id: 'example-source', path: 'notes/example.md', slug: 'notes/example',
      write_error: pending ? 'write_pending' : 'source_changed', reason: pending ? 'write_pending' : 'file_database_drift',
      message: pending ? 'The accepted write is not committed.' : 'The file and database disagree.',
      suggestion: pending ? 'Resume this request.' : 'Review gbrain sources reconcile before retrying.',
      write_request: pending ? { ...receipt, state: 'queued', retry_after_ms: 1000 } : receipt, ledger_recorded: false } };
  let output = '';
  printSyncResult(result, { write: (text: string) => { output += text; return true; } } as NodeJS.WriteStream);
  expect(output).toContain('example-source');
  expect(output).toContain('notes/example.md');
  expect(output).toContain(requestId);
  expect(output).toContain('remains authoritative');
  expect(output).not.toContain('frontmatter validate');
  expect(output).not.toContain('sync --skip-failed');
  if (pending) { expect(output).toContain('not committed'); expect(output).not.toContain('First sync complete'); }
});

function syncRow(state: WriteRequest['state'], blocked: string | null): WriteRequest {
  const now = new Date('2026-01-01T00:00:00Z');
  return { id: requestId, request_id: requestId, state, blocked_reason: blocked, error_code: null, error_message: null,
    outcome: null, compacted: false, created_at: now, updated_at: now } as unknown as WriteRequest;
}
const syncPending = { requestId, slug: 'notes/example', pageId: null, intent: { path: 'notes/example.md' } } as unknown as Pending;
const syncCursor = { sourceId: 'example-source', root: '/nonexistent-example-root' };

test.each([...WRITE_BLOCKED_REASONS])('sync diagnostic reason and write_request agree for pending %s', blocked => {
  for (const state of ['queued', 'running', 'recovering'] as const) {
    const diagnostic = writeDiagnostic(syncCursor, syncPending, syncRow(state, blocked));
    expect(diagnostic.reason).toBe(blocked);
    expect(diagnostic.write_request.blocked_reason).toBe(blocked);
    expect(diagnostic.write_request.state).toBe(state);
    expect(diagnostic.write_error).toBe('write_pending');
    expect(diagnostic.suggestion).toBe(writerNextAction(blocked));
  }
});

test('an unknown or absent stored reason stays write_pending in both fields', () => {
  for (const blocked of [null, '/private/path', 'future_reason']) {
    const diagnostic = writeDiagnostic(syncCursor, syncPending, syncRow('queued', blocked));
    expect(diagnostic.reason).toBe('write_pending');
    expect(diagnostic.write_request).not.toHaveProperty('blocked_reason');
    expect(JSON.stringify(diagnostic)).not.toContain('/private/path');
  }
});

const OTHER_ID = '20000000-0000-4000-8000-000000000002';
async function reportFraming(receipts: WriteReceipt[], writeError: 'response_too_large' | 'storage_error' | 'write_pending' = 'response_too_large',
  detail: string | null = 'result_unframed_committed') {
  const error = new OperationError(writeError, 'Result could not be framed.');
  error.writeError = writeError;
  if (detail !== null) error.detail = detail;
  if (receipts.length === 1) error.writeRequest = receipts[0]; else error.writeRequests = receipts;
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  let stdout = '';
  try {
    expect(await reportPersistenceCliError(error, true, async text => { stdout += text; })).toBe(true);
    return { json: JSON.parse(stdout), lines: stderr.mock.calls.map(args => args.join(' ')).join('\n'), exit: currentExitCode() };
  } finally { stderr.mockRestore(); }
}
const committedCli = (id: string): WriteReceipt => ({ request_id: id, state: 'committed', retry_after_ms: null });

test('a committed write whose result could not be framed exits 0 with the unchanged error envelope', async () => {
  const single = await reportFraming([committedCli(requestId)]);
  expect(single.exit).toBe(0);
  expect(single.json).toMatchObject({ error: 'response_too_large', write_error: 'response_too_large', write_request: { state: 'committed' } });
  expect(single.lines).toContain('Committed [response_too_large]');
  _resetCliExitVerdictForTests();
  const batch = await reportFraming([committedCli(requestId), committedCli(OTHER_ID)], 'storage_error');
  expect(batch.exit).toBe(0);
  expect(batch.json.write_requests).toHaveLength(2);
  expect(batch.lines).toContain(`Request: ${OTHER_ID} (committed)`);
});

test('any uncommitted receipt, or a non-framing error, keeps exit 1', async () => {
  const mixed = await reportFraming([committedCli(requestId), { request_id: OTHER_ID, state: 'queued', retry_after_ms: 1000, blocked_reason: 'owner_unavailable' }]);
  expect(mixed.exit).toBe(1);
  expect(mixed.lines).toContain(`Request: ${OTHER_ID} (queued, owner_unavailable)`);
  _resetCliExitVerdictForTests();
  expect((await reportFraming([committedCli(requestId)], 'write_pending')).exit).toBe(1);
  _resetCliExitVerdictForTests();
  expect((await reportFraming([])).exit).toBe(1);
});

test('unattested or failure-flagged committed receipts never exit 0 (older owner, failed result, dropped receipt)', async () => {
  // An older owner sends committed receipts with no attestation.
  const legacy = await reportFraming([committedCli(requestId)], 'response_too_large', null);
  expect(legacy.exit).toBe(1);
  expect(legacy.lines).toContain('Error [response_too_large]');
  expect(legacy.lines).not.toContain('Committed');
  _resetCliExitVerdictForTests();
  // The owner saw a result-level failure or an invalid receipt.
  for (const plural of [[committedCli(requestId)], [committedCli(requestId), committedCli(OTHER_ID)]]) {
    const failed = await reportFraming(plural, 'storage_error', 'result_unframed');
    expect(failed.exit).toBe(1);
    expect(failed.lines).not.toContain('Committed');
    _resetCliExitVerdictForTests();
  }
});

test('a remote MCP error cannot claim a committed framing salvage', async () => {
  const { RemoteMcpError } = await import('../src/core/mcp-client.ts');
  const error = new RemoteMcpError('tool_error', 'framing', { code: 'response_too_large', write_error: 'response_too_large',
    server_detail: 'result_unframed_committed', write_request: committedCli(requestId) });
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await reportPersistenceCliError(error, false)).toBe(true);
    expect(currentExitCode()).toBe(1);
    expect(stderr.mock.calls.map(args => args.join(' ')).join('\n')).not.toContain('Committed');
  } finally { stderr.mockRestore(); }
});
