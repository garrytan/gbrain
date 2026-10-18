/**
 * #6650: the real `unexpected_file_bytes` blocked state, shared by the PGLite unit test and the Postgres E2E.
 * A source is claimed on this host; a write is admitted, claimed and records its recovery (prior bytes on disk),
 * the file is edited by hand, and one owner recovery pass parks the request.
 */
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, prepareRecovery } from '../../src/core/persistence/journal.ts';
import { recoverPublication } from '../../src/core/persistence/coordinator.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

export const PRIOR = 'line one\nline two\nline three\n';
export const AFTER = 'line one\nline two\nline three\nappended by the write\n';
export const EDITED = 'line one\nline two, edited by hand\nline three\n';

export interface Stuck { sourceId: string; root: string; path: string; id: string; requestId: string; follower: string | null }

let counter = 0;

export function stuckRecoveryFixture(engine: BrainEngine, roots: string[]) {
  const ctxFor = (sourceId: string) => ({ engine, remote: false, sourceId, config: { engine: engine.kind }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as OperationContext);

  async function source(): Promise<{ sourceId: string; root: string }> {
    const sourceId = `stuck-${process.pid}-${++counter}`;
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stuck-root-')); roots.push(root);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    return { sourceId, root };
  }

  async function stuck(opts: { prior: string | null; after: string; disk: string | null; slug?: string; failed?: boolean; follower?: boolean; at?: { sourceId: string; root: string } }): Promise<Stuck> {
    const { sourceId, root } = opts.at ?? await source();
    const slug = opts.slug ?? 'page';
    const path = join(root, `${slug}.md`);
    if (opts.prior !== null) writeFileSync(path, opts.prior, { mode: 0o644 });
    const binding = (await getWorktreeBinding(engine, sourceId))!;
    const authority = await submissionAuthority(ctxFor(sourceId), 'put_page', sourceId, binding.source_incarnation, slug);
    const admission = { principal: authority.principal, authority, operation: 'put_page', sourceId, sourceIncarnation: binding.source_incarnation, slug,
      worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation, callerIntent: { content: opts.after }, intent: { content: opts.after } };
    const accepted = await admitWrite(engine, admission);
    const [row] = await engine.executeRaw<any>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),claim_expires_at=now()+interval '1 hour'
      ${opts.failed ? ",error_code='storage_error',error_message='Publication failed before database completion.'" : ''} WHERE id=$1::uuid RETURNING *`, [accepted.id]);
    const lock = await acquireWorktree(binding); expect(lock).not.toBeNull();
    try {
      await prepareRecovery(engine, row, { version: 1, path, root, before: opts.prior === null ? null : Buffer.from(opts.prior).toString('base64'),
        beforeHash: opts.prior === null ? null : sha256(opts.prior), afterHash: sha256(opts.after), mode: 0o644, ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token }, 65536);
    } finally { await lock!.release(); }
    if (opts.disk === null) { if (existsSync(path)) unlinkSync(path); } else writeFileSync(path, opts.disk);
    await engine.executeRaw("UPDATE persistence_requests SET state='recovering' WHERE id=$1::uuid", [row.id]);
    expect(await recoverPublication(engine, row.id)).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
    const follower = opts.follower ? (await admitWrite(engine, { ...admission, callerIntent: { content: 'Later' }, intent: { content: 'Later' } })).id : null;
    return { sourceId, root, path, id: row.id, requestId: row.request_id, follower };
  }

  async function repair(sourceId: string, opts: { apply?: boolean; expect?: string; keep?: 'prior' | 'disk'; requestId?: string } = {}): Promise<RepairResult> {
    const runner = await repairRunner(engine, { apply: opts.apply === true });
    return runner.run('stuck-recovery', await resolveRepairScope(engine, sourceId), { sourceFlag: sourceId, explicit: true, expect: opts.expect, keep: opts.keep, requestId: opts.requestId });
  }

  return { source, stuck, repair };
}
