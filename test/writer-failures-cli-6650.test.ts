/**
 * #6650 (L3): `gbrain sources writer failures <source>`.
 *
 * Protects: the verb parses and dispatches through local administration (the same path a resident owner runs);
 * every option is validated with the usage it takes and an unknown or archived source is refused; the human table
 * names the next command and the JSON carries rendered `fix.command` / `inspect` for each row and group; a full
 * page prints `truncated` with the exact next command. The capability handshake stays compatible both ways: the
 * owner's frozen `administration` list is unchanged (an older client rejects an owner listing an entry it does not
 * know), the new operation rides `administration_extensions`, a client keeps only extension entries it knows, and a
 * client never sends `writer_failures` to an owner that does not list it. PGLite in-memory and a local socket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import net, { type Server } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { renderWriterFailures } from '../src/commands/sources-writer-failures.ts';
import type { TerminalFailureListing } from '../src/core/persistence/terminal-failures.ts';
import { PERSISTENCE_ADMIN_OPERATIONS } from '../src/core/persistence/admin-contract.ts';
import { ownerAdministers, requestPersistenceCapabilities, startPersistenceIpcServer, type PersistenceIpcBinding } from '../src/core/persistence/ipc.ts';

const SOURCE = 'wf-src';
const ARCHIVED = 'wf-archived';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  await engine.executeRaw('INSERT INTO sources(id,name,archived) VALUES($1,$1,true)', [ARCHIVED]);
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function seed(slug: string, code: string, detail: unknown, hoursAgo = 1): Promise<string> {
  const requestId = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
      state,error_code,error_message,error_detail,intent,completed_at,updated_at,admitter_version)
    VALUES('local_cli','fixture',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,'failed',$5,'x',$6::text::jsonb,'{"content":"x"}'::jsonb,
      now()-($7::double precision*interval '1 hour'),now()-($7::double precision*interval '1 hour'),'0.60.216.0')`,
  [requestId, SOURCE, slug, randomUUID(), code, JSON.stringify(detail), hoursAgo]);
  return requestId;
}

describe('sources writer failures', () => {
  test('parses the verb, its source and its options', () => {
    expect(parsePersistenceAdminArgs('writer', ['failures', SOURCE, '--group-by', 'category', '--limit', '5', '--json'])).toEqual({
      operation: 'writer_failures', params: { source_id: SOURCE, group_by: 'category', limit: 5 }, json: true });
    expect(parsePersistenceAdminArgs('writer', ['failures', SOURCE, '--state', 'all', '--since', '3d', '--origin', 'none', '--before', '12'])).toMatchObject({
      operation: 'writer_failures', params: { source_id: SOURCE, state: 'all', since: '3d', origin: 'none', before: '12' }, json: false });
  });

  test('refuses bad options, a missing source and an archived one with the usage to fix it', async () => {
    const run = (params: Record<string, unknown>) => runPersistenceAdministration(engine, 'writer_failures', params);
    await expect(run({})).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(run({ source_id: 'wf-missing' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('No active source') });
    await expect(run({ source_id: ARCHIVED })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(run({ source_id: SOURCE, since: '7' })).rejects.toMatchObject({ code: 'invalid_params', message: 'Invalid --since value.' });
    await expect(run({ source_id: SOURCE, group_by: 'slug' })).rejects.toMatchObject({ code: 'invalid_params', message: 'Invalid --group-by value.' });
    await expect(run({ source_id: SOURCE, limit: 0 })).rejects.toMatchObject({ code: 'invalid_params', message: 'Invalid --limit value.' });
    await expect(run({ source_id: SOURCE, before: 'abc' })).rejects.toMatchObject({ code: 'invalid_params', message: 'Invalid --before value.' });
    await expect(run({ source_id: SOURCE, slug: 'x' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('lists through administration, pages with the next command, and renders a table or JSON', async () => {
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) ids.push(await seed(`notes/owner-${i}`, 'storage_error', { origin: 'owner_exception', error_class: 'TypeError' }, 3 - i));
    await seed('notes/drift', 'file_database_drift', { origin: 'file_database_drift' });

    const page = await runPersistenceAdministration(engine, 'writer_failures', { source_id: SOURCE, limit: 2 }) as TerminalFailureListing & { status: 'ok' };
    expect(page.rows!.length).toBe(2);
    expect(page.truncated).toBe(true);
    expect(page.next).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE, '--limit', '2', '--before', page.next_cursor!, '--json']);
    const rest = await runPersistenceAdministration(engine, 'writer_failures', { source_id: SOURCE, limit: 2, before: page.next_cursor! }) as TerminalFailureListing & { status: 'ok' };
    expect(rest.truncated).toBe(false);
    expect([...page.rows!, ...rest.rows!].map(r => r.request_id).filter(id => ids.includes(id)).sort()).toEqual([...ids].sort());

    const json = JSON.parse(renderWriterFailures(page, true));
    expect(json.rows[0].inspect).toMatchObject({ next: 'run', command: `gbrain write-request ${page.rows![0].request_id} --json` });
    expect(typeof json.rows[0].fix.next).toBe('string');
    const table = renderWriterFailures(page, false);
    expect(table).toContain(`Source ${SOURCE}: 2 unresolved receipts of the last 7 d.`);
    expect(table).toContain(page.rows![0].request_id);
    expect(table).toContain(`More: gbrain sources writer failures ${SOURCE} --limit 2 --before ${page.next_cursor} --json`);

    const grouped = await runPersistenceAdministration(engine, 'writer_failures', { source_id: SOURCE, group_by: 'category' }) as TerminalFailureListing & { status: 'ok' };
    const owner = grouped.groups!.find(g => g.category === 'owner_exception')!;
    expect(owner.rows).toBe(3);
    expect(owner.drill_down).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE, '--category', 'owner_exception', '--code', owner.code, '--origin', 'owner_exception', '--json']);
    const groupedJson = JSON.parse(renderWriterFailures(grouped, true));
    expect(groupedJson.groups[0].samples[0].inspect.command).toStartWith('gbrain write-request ');
    expect(renderWriterFailures(grouped, false)).toContain(`rows: ${owner.drill_down.join(' ')}`);
  });

  test('an unknown read prints that nothing is concluded', () => {
    const out = renderWriterFailures({ status: 'unknown', source_id: SOURCE, reason: 'the read did not finish' }, false);
    expect(out).toContain('unknown (the read did not finish)');
    expect(out).not.toContain('Nothing to show');
  });
});

const bindings: PersistenceIpcBinding[] = [];
const rawServers: Server[] = [];
const dirs: string[] = [];
const BRAIN = '10000000-0000-4000-8000-000000006650';
function socketPath() { const dir = mkdtempSync(join(tmpdir(), 'gb-6650-ipc-')); dirs.push(dir); return join(dir, 'write.sock'); }
afterEach(async () => {
  for (const binding of bindings.splice(0)) { const closed = binding.server.listening ? once(binding.server, 'close') : Promise.resolve(); binding.close(); await closed; }
  for (const server of rawServers.splice(0)) if (server.listening) { const closed = once(server, 'close'); server.close(); await closed; }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function rawOwner(capabilities: Record<string, unknown>) {
  const path = socketPath();
  const server = net.createServer(socket => socket.once('data', () => socket.end(`${JSON.stringify({ version: 1, ok: true, result: capabilities })}\n`)));
  rawServers.push(server); server.listen(path); await once(server, 'listening');
  return path;
}

describe('capability handshake across releases', () => {
  // The administration list as of 0.60.216.0. An older client drops an owner whose list names anything else.
  const FROZEN = ['writer_status', 'writer_sync', 'writer_refresh', 'writer_extract_stale', 'writer_reindex_code', 'writer_retry_effects', 'writer_embed_facts',
    'writer_claim', 'writer_activate', 'writer_transfer_prepare', 'writer_transfer_accept', 'writer_deactivate', 'writer_lock', 'writer_unlock', 'writer_git_durability',
    'local_writer_list', 'local_writer_register', 'local_writer_revoke', 'source_lifecycle', 'source_add', 'company_brain_preview', 'company_brain_connect',
    'company_brain_resume', 'writer_reconcile_preview', 'writer_reconcile_apply', 'writer_reconcile_audit', 'writer_reconcile_backups',
    'trust_read', 'trust_preview', 'trust_apply'];

  test('a new owner keeps the frozen list and advertises writer_failures and writer_transfer_cancel as extensions', async () => {
    expect([...PERSISTENCE_ADMIN_OPERATIONS as readonly string[]].sort()).toEqual([...FROZEN].sort());
    const path = socketPath();
    const binding = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}), administer: async () => ({}) });
    bindings.push(binding!);
    const capability = await requestPersistenceCapabilities(path);
    expect((capability.administration ?? []).every(op => FROZEN.includes(op))).toBe(true);
    expect(capability.administration_extensions).toEqual(['writer_failures', 'writer_transfer_cancel']);
    expect(ownerAdministers(capability, 'writer_failures')).toBe(true);
    expect(ownerAdministers(capability, 'writer_transfer_cancel')).toBe(true);
    expect(ownerAdministers(capability, 'writer_status')).toBe(true);
  });

  test('a client keeps only extension entries it knows and never calls writer_failures on an owner that does not list it', async () => {
    const base = { version: 1, brain_id: BRAIN, operations: ['get_write_request'], max_frame_bytes: 1024, administration: ['writer_status'] };
    const future = await requestPersistenceCapabilities(await rawOwner({ ...base, administration_extensions: ['writer_failures', 'writer_from_the_future'] }));
    expect(future.administration_extensions).toEqual(['writer_failures']);
    const malformed = await requestPersistenceCapabilities(await rawOwner({ ...base, administration_extensions: 'writer_failures' }));
    expect(malformed.administration_extensions).toBeUndefined();
    expect(ownerAdministers(malformed, 'writer_failures')).toBe(false);
    const older = await requestPersistenceCapabilities(await rawOwner(base));
    expect(ownerAdministers(older, 'writer_failures')).toBe(false);
    expect(ownerAdministers(older, 'writer_status')).toBe(true);
  });
});
