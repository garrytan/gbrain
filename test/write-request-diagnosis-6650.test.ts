/**
 * #6650 (L3 item 2): `gbrain write-request <id>` (get_write_request) returns the suggestion `writeFailureDiagnostic`
 * already computes and the structured fix of the receipt's read-time classification, instead of dropping both.
 * A compacted receipt whose code covers several causes gets `diagnosis_required` with a read-only inspection,
 * never a guessed fix. PGLite in-memory.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { sha256 } from '../src/core/persistence/digest.ts';

const SOURCE = 'diag-6650';
let engine: PGLiteEngine;
let owner: LocalRegistration;
const context = (): OperationContext => ({ engine, config: { engine: 'pglite' }, remote: false, sourceId: SOURCE, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  owner = { id: randomUUID(), credential: randomBytes(32).toString('hex'), lane: 'cli' };
  await engine.executeRaw('INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling) VALUES($1,$2,$3,$4::jsonb)', [owner.id, owner.lane, sha256(owner.credential),
    JSON.stringify({ sourceIds: ['*'], operations: ['put_page', 'get_write_request'], scopes: ['read', 'write'], slugPrefixes: null })]);
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

async function receiptFor(slug: string, patch: { state: string; error_code: string; error_message: string | null; compacted?: boolean }) {
  const requestId = randomUUID();
  await withVerifiedLocalRegistration(engine, owner, async () => {
    const [s] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SOURCE]);
    const authority = await submissionAuthority(context(), 'put_page', SOURCE, s.incarnation, slug);
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: SOURCE, sourceIncarnation: s.incarnation, slug, requestId,
      callerIntent: { content: 'x' }, intent: { content: 'x' } });
  });
  await engine.executeRaw(`UPDATE persistence_requests SET state=$2, error_code=$3, error_message=$4, completed_at=now(), compacted=$5, intent=CASE WHEN $5 THEN NULL ELSE intent END
    WHERE request_id=$1::uuid`, [requestId, patch.state, patch.error_code, patch.error_message, patch.compacted === true]);
  const op = operations.find(operation => operation.name === 'get_write_request')!;
  return withVerifiedLocalRegistration(engine, owner, () => op.handler(context(), { request_id: requestId })) as Promise<Record<string, any>>;
}

test('a drift refusal returns the computed suggestion and the scoped file-drift preview as its structured fix', async () => {
  const receipt = await receiptFor('notes/drifted', { state: 'conflict', error_code: 'source_changed', error_message: 'The canonical file contains an uncoordinated local edit.' });
  expect(receipt.write_error).toBe('source_changed');
  expect(receipt.write_error_reason).toBe('file_database_drift');
  expect(receipt.suggestion).toContain('gbrain sources reconcile <source> <slug>');
  expect(receipt.diagnosis).toMatchObject({ category: 'file_conflict', class: 'page', safe_actions: ['reconcile'], needs_human: true });
  // #6712 PR 2 (L4): the scoped file-drift preview is the drift exit.
  expect(receipt.diagnosis.fix.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', SOURCE, '--slug', 'notes/drifted', '--prefer', 'database']);
  expect(receipt.diagnosis.fix.next).toBe('run');
  expect(receipt.diagnosis.fix.verify.argv.slice(0, 5)).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE]);
});

test('a compacted storage_error with no recorded origin is diagnosis_required, with a read-only inspection and no guessed fix', async () => {
  const receipt = await receiptFor('notes/opaque', { state: 'failed', error_code: 'storage_error', error_message: null, compacted: true });
  expect(receipt.diagnosis).toMatchObject({ category: 'diagnosis_required', code: 'storage_error', safe_actions: ['none'], needs_human: true });
  expect(receipt.diagnosis.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', SOURCE, '--json']);
  expect(receipt.diagnosis.human_reason).toContain('does not record enough to name a fix');
});

test('a receipt parked recovering with its record is diagnosed as the blocked recovery it is', async () => {
  const requestId = randomUUID();
  await withVerifiedLocalRegistration(engine, owner, async () => {
    const [s] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SOURCE]);
    const authority = await submissionAuthority(context(), 'put_page', SOURCE, s.incarnation, 'notes/parked');
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: SOURCE, sourceIncarnation: s.incarnation, slug: 'notes/parked', requestId,
      callerIntent: { content: 'z' }, intent: { content: 'z' } });
  });
  await engine.executeRaw(`UPDATE persistence_requests SET state='recovering', blocked_reason='unexpected_file_bytes',
    recovery='{"version":1,"path":"/nonexistent/p.md","root":"/nonexistent","beforeHash":null,"afterHash":"a"}'::jsonb WHERE request_id=$1::uuid`, [requestId]);
  const op = operations.find(operation => operation.name === 'get_write_request')!;
  const receipt = await withVerifiedLocalRegistration(engine, owner, () => op.handler(context(), { request_id: requestId })) as Record<string, any>;
  expect(receipt.diagnosis).toMatchObject({ category: 'recovery_blocked', needs_human: true });
  expect(receipt.diagnosis.fix.argv.slice(0, 4)).toEqual(['gbrain', 'sources', 'writer', 'status']);
});

test('a committed receipt carries no diagnosis', async () => {
  const requestId = randomUUID();
  await withVerifiedLocalRegistration(engine, owner, async () => {
    const [s] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SOURCE]);
    const authority = await submissionAuthority(context(), 'put_page', SOURCE, s.incarnation, 'notes/done');
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: SOURCE, sourceIncarnation: s.incarnation, slug: 'notes/done', requestId,
      callerIntent: { content: 'y' }, intent: { content: 'y' } });
  });
  await engine.executeRaw("UPDATE persistence_requests SET state='committed', completed_at=now() WHERE request_id=$1::uuid", [requestId]);
  const op = operations.find(operation => operation.name === 'get_write_request')!;
  const receipt = await withVerifiedLocalRegistration(engine, owner, () => op.handler(context(), { request_id: requestId })) as Record<string, unknown>;
  expect(receipt.diagnosis).toBeUndefined();
  expect(receipt.suggestion).toBeUndefined();
});
