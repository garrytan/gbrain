/**
 * LPH (d) part 1: a recovery record of a version this gbrain does not know is refused, never misread.
 *
 * 1. Protects: a withdrawal-mirror effect recovery record (persistence_effects.recovery) or a write request recovery
 *    record (persistence_requests.recovery) whose `version` this binary does not know (a synthetic version 3, as a
 *    future release could write) is refused `recovery_version_unsupported` with fix.next `tell_user_to_run`
 *    `gbrain upgrade`, before anything reads it: the record stays byte for byte, its streamed stage stays on disk with
 *    its bytes, the canonical file keeps its bytes, nothing is cleared and the effect keeps retrying (never parks). The
 *    head blocker names it as needing intervention with the same upgrade fix.
 * 2. Fails when: recovery reads a version 3 record as version 1 (it embeds `after`, so the old reading removes the
 *    stage, publishes the embedded bytes and clears the record) or as anything else, `rebaseStaleEffectRecovery` (the
 *    `--keep withdrawn` rebase) reads it, `upgradeRecoveryStaging` rewrites an unknown request record's staging, the
 *    stuck-recovery preview mislabels it (`recovery_effect_unsupported`, `recovery_bundle_unsupported`), or the refusal
 *    is untyped (`recovery_required`, `effect_unavailable`, a bare Error).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. The record is written by the real segmented mirror (crash
 *    modelled at the `effect_recovery:staged` seam, where the hook rewrites the record's version while this pass still
 *    holds the worktree lock), so the stage, the reservation and the binding are real.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cliRenderContext, renderAction } from '../../src/core/agent-output.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { rebaseStaleEffectRecovery, recoverEffectPublication } from '../../src/core/persistence/effect-recovery.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { headBlockerAction } from '../../src/core/persistence/head-blocker.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { clearResolvedRecovery } from '../../src/core/persistence/journal.ts';
import { recoveryFiles } from '../../src/core/persistence/model.ts';
import { scanStuckRecoveries } from '../../src/core/persistence/recovery-resolve.ts';
import { upgradeRecoveryStaging } from '../../src/core/persistence/staging.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { fileOf, settle } from '../helpers/segmented-withdrawal.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';

const SEGMENTED = 'people/sei-example';
const CLAIM = 'Twin Example vault code is 4401';
const KEPT = 'Twin Example adopted a narwhalbot';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;

function expectUpgradeRefusal(error: unknown) {
  expect(error).toBeInstanceOf(OperationError);
  const refusal = error as OperationError;
  expect(refusal.code).toBe('recovery_version_unsupported');
  expect(refusal.fix?.argv).toEqual(['gbrain', 'upgrade']);
  expect(renderAction(refusal.fix!, cliRenderContext()).next).toBe('tell_user_to_run');
}

for (const kind of testBackends()) {
  describe(kind + ': a recovery record of an unknown version is refused, never misread', () => {
    let brain: TwinBrain;

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => { await seed.setSwitch(true); await seed.put(SEGMENTED, 1_100_000); });
      brain.setChatReply(JSON.stringify({ facts: [CLAIM, KEPT].map(fact => ({ fact, kind: 'fact', entity: SEGMENTED, confidence: 1, notability: 'high' })) }));
      expect(await brain.call('extract_facts', { turn_text: 'Synthetic meeting record. ' + CLAIM + '. ' + KEPT + '.', visibility: 'world', valid_from: '2026-10-15T00:00:00Z' }, SEGMENTED))
        .toMatchObject({ inserted: 2 });
      expect(await brain.storageOf(SEGMENTED)).toBe('segmented');
      await settle(brain, kind);
    }, 600_000);

    afterAll(() => { installFaultHook(undefined); return brain.close(); }, 120_000);

    test('a version 3 withdrawal-mirror record keeps its bytes, its stage and the file; the effect retries with recovery_version_unsupported', async () => {
      const file = fileOf(brain, SEGMENTED);
      const before = readFileSync(file);
      expect(before.toString('utf8')).toContain(CLAIM);
      // At the staged seam the version 2 record and its stage are durable; the hook turns the record into a version 3 one
      // that also embeds the staged bytes as `after` (a layout a version 1 reader would act on), then the pass "crashes".
      let written: any = null;
      let effectId = '';
      installFaultHook(async (point, detail) => {
        if (point !== 'effect_recovery:staged' || written) return;
        const [row] = await brain.engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_effects WHERE id=$1', [detail.effectId]);
        const v2 = json(row!.recovery);
        expect(v2).toMatchObject({ version: 2, after: null });
        effectId = String(detail.effectId);
        written = { ...v2, version: 3, after: readFileSync(v2.staging.publication.path).toString('base64'), next: { layout: 'future' } };
        await brain.engine.executeRaw('UPDATE persistence_effects SET recovery=$2::text::jsonb WHERE id=$1', [detail.effectId, JSON.stringify(written)]);
        throw new Error('modelled crash after the stage was written');
      });
      const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, SEGMENTED, CLAIM]);
      const dry = await brain.call('purge_fact', { id: Number(fact!.id), dry_run: true }, SEGMENTED);
      expect((await brain.call('purge_fact', { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }, SEGMENTED)).state).toBe('committed');
      const pass = () => withEnv(brain.env(), async () => {
        await brain.engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND state='queued'`, [brain.sourceId]);
        await runPersistenceEffects(brain.engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
      });
      try {
        // The resident consumer may hold the mirror's claim; passes run until one of them reaches the seam.
        await waitFor(async () => { if (!written) await pass(); return written !== null; }, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror reached the staged seam' });
        const counters = await brain.engine.executeRaw<{ key: string; bytes: string }>('SELECT key, recovery_bytes::text AS bytes FROM persistence_counters ORDER BY key');
        // Recovery attempts after the crash, more than PARK_AFTER_FAILURES of them, by this process or the resident consumer.
        const read = async () => (await brain.engine.executeRaw<{ id: string; state: string; error_code: string | null; recovery: unknown; data: any; attempts: number }>(
          'SELECT id::text AS id, state, error_code, recovery, data, attempts FROM persistence_effects WHERE id=$1', [effectId]))[0]!;
        const start = (await read()).attempts;
        // A reader that misreads the record may clear it; the wait ends then too, and the assertions below say so.
        await waitFor(async () => { await pass(); const row = await read(); return !row.recovery || row.attempts >= start + 7; }, { timeoutMs: 120_000, intervalMs: 100, label: 'seven recovery attempts' });
        // The row the wait read: the resident consumer may claim the effect again right after it is released.
        let effect = await read();
        await waitFor(async () => (effect = await read()).state !== 'running', { timeoutMs: 30_000, label: 'the effect released' });
        // Untouched: the record (byte for byte), its stage, the canonical file and the reserved capacity.
        expect(json(effect!.recovery)).toEqual(written);
        expect(existsSync(written.staging.publication.path)).toBe(true);
        expect(sha(readFileSync(written.staging.publication.path))).toBe(written.staging.publication.hash);
        expect(readFileSync(file).equals(before)).toBe(true);
        expect(await brain.engine.executeRaw<{ key: string; bytes: string }>('SELECT key, recovery_bytes::text AS bytes FROM persistence_counters ORDER BY key')).toEqual(counters);
        // Typed and retrying: the effect is queued with the code, never parked.
        expect(effect!.error_code).toBe('recovery_version_unsupported');
        expect(effect!.state).toBe('queued');
        expect(json(effect!.data).parked ?? []).toEqual([]);

        // The refusal itself, as the recovery worker meets it.
        const [claimed] = await brain.engine.executeRaw<any>(`UPDATE persistence_effects SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '2 minutes'
          WHERE id=$1 RETURNING *`, [effect!.id, randomUUID()]);
        const refused = await withEnv(brain.env(), () => recoverEffectPublication(brain.engine, claimed, localHostId())).then(() => null, error => error);
        expectUpgradeRefusal(refused);
        expect(json((await brain.engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_effects WHERE id=$1', [effect!.id]))[0]!.recovery)).toEqual(written);
        await brain.engine.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL WHERE id=$1`, [effect!.id]);

        // `--keep withdrawn` rebases a stale record before publishing it; an unknown version is refused there too, never respread as version 1.
        let persisted = false;
        const rebase = await withEnv(brain.env(), () => rebaseStaleEffectRecovery(brain.engine, effect!.id, localHostId(), async () => { persisted = true; })).then(() => null, error => error);
        expectUpgradeRefusal(rebase);
        expect(persisted).toBe(false);
        expect(json((await brain.engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_effects WHERE id=$1', [effect!.id]))[0]!.recovery)).toEqual(written);
        expect(existsSync(written.staging.publication.path)).toBe(true);

        // The stuck-recovery preview lists it refused with the upgrade fix, not as an effect it cannot write back.
        const scan = await withEnv(brain.env(), () => scanStuckRecoveries(brain.engine, [brain.sourceId]));
        const newer = scan.refused.find(refused => String(refused.effect_id) === String(effect!.id));
        expect(newer?.code).toBe('recovery_version_unsupported');
        expect(newer?.fix?.argv).toEqual(['gbrain', 'upgrade']);
        expect(json((await brain.engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_effects WHERE id=$1', [effect!.id]))[0]!.recovery)).toEqual(written);

        // The head blocker's exit for it is the same upgrade, told to the user.
        const action = headBlockerAction({ predicate: 'effect_recovery', ids: [effect!.id], state: 'recovery_version_unsupported', owner: null, intervention: true }, brain.sourceId, `gbrain sync --source ${brain.sourceId}`);
        expect(action.argv).toEqual(['gbrain', 'upgrade']);
        expect(renderAction(action, cliRenderContext()).next).toBe('tell_user_to_run');
      } finally { installFaultHook(undefined); }
    }, 600_000);

    test('a version 3 write request recovery record is refused by staging upgrade, file listing and clearing, and left as it is', async () => {
      const [request] = await brain.engine.executeRaw<{ id: string; request_id: string; worktree_id: string }>(
        `SELECT id::text AS id, request_id::text AS request_id, worktree_id::text AS worktree_id FROM persistence_requests WHERE source_id=$1 AND state='committed' AND worktree_id IS NOT NULL ORDER BY sequence DESC LIMIT 1`, [brain.sourceId]);
      // No staging: a version 1 reader's upgradeRecoveryStaging would allocate a restoration stage from `before` and rewrite the record.
      const record = { version: 3, path: fileOf(brain, SEGMENTED), root: brain.root, before: Buffer.from('prior bytes').toString('base64'), beforeHash: sha(Buffer.from('prior bytes')),
        afterHash: sha(readFileSync(fileOf(brain, SEGMENTED))), mode: null, ownerEpoch: '1', attempt: randomUUID(), next: { layout: 'future' } };
      // The request protocol trigger admits only the record shapes this schema knows; a newer gbrain's would come with its
      // own schema, so the trigger is set aside for this one write (replica role) to model that brain.
      const unguarded = (sql: string, params: unknown[]) => brain.engine.transaction(async tx => {
        await tx.executeRaw("SET LOCAL session_replication_role = 'replica'");
        await tx.executeRaw(sql, params);
      });
      await unguarded('UPDATE persistence_requests SET recovery=$2::text::jsonb WHERE id=$1::uuid', [request!.id, JSON.stringify(record)]);
      const stored = async () => json((await brain.engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_requests WHERE id=$1::uuid', [request!.id]))[0]!.recovery);
      try {
        expectUpgradeRefusal(await upgradeRecoveryStaging(brain.engine, 'persistence_requests', request!.id, request!.worktree_id, 'restore').then(() => null, error => error));
        expect(await stored()).toEqual(record);
        let listed: unknown = null;
        try { recoveryFiles(record as never); } catch (error) { listed = error; }
        expectUpgradeRefusal(listed);
        expectUpgradeRefusal(await clearResolvedRecovery(brain.engine, request!.id).then(() => null, error => error));
        expect(await stored()).toEqual(record);
        // A live (recovering) request with it: the stuck-recovery preview refuses it with the upgrade fix, not as a bundle it cannot read.
        await unguarded("UPDATE persistence_requests SET state='recovering' WHERE id=$1::uuid", [request!.id]);
        expectUpgradeRefusal(await withEnv(brain.env(), () => scanStuckRecoveries(brain.engine, [brain.sourceId], { requestId: request!.request_id })).then(() => null, error => error));
        expect(await stored()).toEqual(record);
      } finally {
        await unguarded("UPDATE persistence_requests SET recovery=NULL,state='committed' WHERE id=$1::uuid", [request!.id]);
      }
    }, 120_000);
  });
}
