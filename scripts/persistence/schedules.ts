import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admitWrite, claimNextWrite, getWriteRequest, getWriteRequestById, releaseUnpublishedClaim, renewWriteClaim } from '../../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../../src/core/persistence/control.ts';
import { publishMutation, recoverPublication, type PublicationHooks } from '../../src/core/persistence/coordinator.ts';
import { admission, assertCommittedSnapshot, assertConservation, deferred, distribution, fixtures, openEngine,
  prepared, publish, random, timedAdmission, type HarnessConfig } from './harness.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

export const SCHEDULE_CASES = ['duplicate_intent', 'create_conflict', 'cancel_publish', 'publication_rollback',
  'stale_claim', 'root_fifo', 'coherent_read', 'blocked_recovery', 'admission_quota', 'revoked_authority'] as const;
const boundaries = ['prepared', 'before_publication', 'after_publication', 'before_commit', 'after_commit'] as const;

/** Seeded operation order with real transaction / filesystem barriers, no mocked engine. */
export async function runSchedules(config: HarnessConfig) {
  const engine = await openEngine(config); const sources = await fixtures(engine, config);
  const choose = random(config.seed); const cases = Object.fromEntries(SCHEDULE_CASES.map(c => [c, 0]));
  const boundaryCases = Object.fromEntries(boundaries.map(c => [c, 0]));
  const admissionMs: number[] = []; const commitMs: number[] = []; const started = performance.now();
  const claim = async () => { const row = await claimNextWrite(engine, config.hostId); assert(row, 'expected a claimable head'); return row; };
  const commit = async (row: WriteRequest) => { const at = performance.now(); const done = await publish(engine, row, sources, config);
    commitMs.push(performance.now() - at); await assertCommittedSnapshot(engine, done); return done; };
  try {
    for (let i = 0; i < config.schedules; i++) {
      const type = SCHEDULE_CASES[i % SCHEDULE_CASES.length];
      const source = sources[Math.floor(choose() * sources.length)];
      const other = sources[(sources.indexOf(source) + 1) % sources.length];
      const principal = Math.floor(choose() * config.principalIds.length);
      const slug = `schedule-${config.seed}-${i}`; const body = `value-${Math.floor(choose() * 1e9)}`;
      const a = admission(config, source, slug, body, principal);
      const accept = () => timedAdmission(engine, a, admissionMs);
      if (type === 'duplicate_intent') {
        const copies = await Promise.all(Array.from({ length: 2 + Math.floor(choose() * 4) }, accept));
        assert.equal(new Set(copies.map(r => r.id)).size, 1);
        await assert.rejects(admitWrite(engine, { ...a, callerIntent: { content: `${body}-different` } }), { code: 'idempotency_conflict' });
        const terminal = await cancelWriteRequest(engine, a.principal, a.requestId!); assert.equal(terminal!.state, 'cancelled');
        assert.deepEqual((await accept()).outcome, terminal!.outcome);
        // The same caller UUID in another principal's namespace remains independent.
        const independent = admission(config, other, slug, body, (principal + 1) % config.principalIds.length, { requestId: a.requestId });
        assert.notEqual((await admitWrite(engine, independent)).id, terminal!.id); await commit(await claim());
      } else if (type === 'create_conflict') {
        const b = { ...a, requestId: randomUUID(), callerIntent: { content: `${body}-second` }, intent: { content: `${body}-second` } };
        await Promise.all(choose() < .5 ? [accept(), admitWrite(engine, b)] : [admitWrite(engine, b), accept()]);
        const created = await commit(await claim()); const loser = await publish(engine, await claim(), sources, config);
        assert.equal(loser.state, 'conflict'); assert.equal(loser.error_code, 'page_identity_changed');
        const snapshot = (await engine.readPageSnapshot(slug, { sourceId: source.id }))!;
        const replacements = ['left', 'right'].map(side => ({ ...a, pageId: snapshot.page.id, requestId: randomUUID(),
          callerIntent: { content: `${body}-${side}`, expected_revision: created.outcome!.revision },
          intent: { content: `${body}-${side}`, expected_revision: created.outcome!.revision } }));
        await Promise.all(replacements.map(input => admitWrite(engine, input)));
        const winner = await claim();
        await assertCommittedSnapshot(engine, await publishMutation(engine, winner, prepared(winner, sources, snapshot.revision), config.hostId));
        const stale = await claim(); const conflict = await publishMutation(engine, stale, prepared(stale, sources, snapshot.revision), config.hostId);
        assert.equal(conflict.state, 'conflict'); assert.equal(conflict.error_code, 'revision_conflict');
      } else if (type === 'cancel_publish') {
        await accept(); const row = await claim();
        const cancel = () => cancelWriteRequest(engine, a.principal, a.requestId!);
        const write = () => publish(engine, row, sources, config);
        await Promise.all(choose() < .5 ? [cancel(), write()] : [write(), cancel()]);
        const final = (await getWriteRequestById(engine, row.id))!;
        assert(['committed', 'cancelled'].includes(final.state));
        if (final.state === 'committed') await assertCommittedSnapshot(engine, final);
        else assert.equal(await engine.readPageSnapshot(slug, { sourceId: source.id }), null);
      } else if (type === 'publication_rollback') {
        const boundary = boundaries[Math.floor(i / SCHEDULE_CASES.length) % boundaries.length];
        const path = join(source.root, `${slug}.md`); writeFileSync(path, 'original');
        await accept(); const row = await claim();
        const result = await publishMutation(engine, row, prepared(row, sources, null, true), config.hostId,
          { boundary: async name => { if (name === boundary) throw new Error(`injected:${boundary}`); } });
        if (boundary === 'after_commit') { await assertCommittedSnapshot(engine, result); assert.equal(readFileSync(path, 'utf8'), body); }
        else {
          assert.equal(readFileSync(path, 'utf8'), 'original'); assert.equal(await engine.readPageSnapshot(slug, { sourceId: source.id }), null);
          if (result.state === 'queued') {
            const retry = await claim(); const done = await publishMutation(engine, retry, prepared(retry, sources, null, true), config.hostId);
            await assertCommittedSnapshot(engine, done);
          } else assert.equal(result.state, 'failed');
        }
        assert.equal((await getWriteRequestById(engine, row.id))!.recovery, null); boundaryCases[boundary]++;
      } else if (type === 'stale_claim') {
        await accept(); const old = await claim(); await releaseUnpublishedClaim(engine, old, 'test_reprepare'); const current = await claim();
        assert.notEqual(old.execution_token, current.execution_token);
        assert.equal(await renewWriteClaim(engine, old.id, old.execution_token!), false);
        await releaseUnpublishedClaim(engine, old, 'stale_release');
        assert.equal((await getWriteRequestById(engine, old.id))!.execution_token, current.execution_token); await commit(current);
      } else if (type === 'root_fifo') {
        const first = await accept();
        const second = await admitWrite(engine, { ...a, slug: `${slug}-next`, requestId: randomUUID() });
        const unrelated = await admitWrite(engine, admission(config, other, slug, body, principal));
        const claimed = (await Promise.all([claimNextWrite(engine, config.hostId), claimNextWrite(engine, config.hostId), claimNextWrite(engine, config.hostId)])).filter((r): r is WriteRequest => r !== null);
        assert.deepEqual(new Set(claimed.map(r => r.id)), new Set([first.id, unrelated.id]));
        if (engine.kind === 'pglite') for (const row of claimed) await commit(row);
        else await Promise.all(claimed.map(commit));
        assert.equal((await claim()).id, second.id); await commit((await getWriteRequestById(engine, second.id))!);
      } else if (type === 'coherent_read') {
        const initial = { ...a, requestId: randomUUID(), callerIntent: { content: `${body}-old` }, intent: { content: `${body}-old` } };
        await admitWrite(engine, initial); await commit(await claim());
        const old = (await engine.readPageSnapshot(slug, { sourceId: source.id }))!;
        await timedAdmission(engine, { ...a, pageId: old.page.id }, admissionMs);
        const row = await claim(); const entered = deferred(); const resume = deferred();
        const hooks: PublicationHooks = { boundary: async name => { if (name === 'before_commit') { entered.resolve(); await resume.promise; } } };
        const writing = publishMutation(engine, row, prepared(row, sources, old.revision), config.hostId, hooks);
        await entered.promise;
        let readFinished = false;
        const reading = engine.readPageSnapshot(slug, { sourceId: source.id }).then(value => { readFinished = true; return value; });
        if (engine.kind === 'postgres') assert.deepEqual(await reading, old, 'MVCC reader must see the old complete content, timeline, tags and revision');
        else { await Promise.resolve(); assert.equal(readFinished, false, 'PGLite serializes the reader behind its transaction'); }
        resume.resolve(); const done = await writing; await reading; await assertCommittedSnapshot(engine, done);
      } else if (type === 'blocked_recovery') {
        const path = join(source.root, `${slug}.md`); writeFileSync(path, 'original'); await accept(); const row = await claim();
        const result = await publishMutation(engine, row, prepared(row, sources, null, true), config.hostId,
          { boundary: async name => { if (name === 'after_publication') { writeFileSync(path, 'external-change'); throw new Error('injected ambiguous rollback'); } } });
        assert.equal(result.state, 'recovering'); assert.equal(result.blocked_reason, 'unexpected_file_bytes');
        const next = await admitWrite(engine, { ...a, slug: `${slug}-next`, requestId: randomUUID() });
        const otherRow = await admitWrite(engine, admission(config, other, slug, body, principal));
        assert.equal((await claim()).id, otherRow.id); await commit((await getWriteRequestById(engine, otherRow.id))!);
        assert.equal(await claimNextWrite(engine, config.hostId), null, 'unknown bytes must block the entire root');
        await assertConservation(engine); writeFileSync(path, body);
        const recovered = await recoverPublication(engine, row.id, config.hostId);
        assert.equal(recovered.state, 'failed', 'A known failed transaction body must not run again after recovery');
        assert.equal(recovered.error_code, 'storage_error');
        assert.equal(readFileSync(path, 'utf8'), 'original');
        assert.equal((await claim()).id, next.id); await commit((await getWriteRequestById(engine, next.id))!);
      } else if (type === 'admission_quota') {
        const attempts = Array.from({ length: 3 + Math.floor(choose() * 4) }, () => ({ ...a, requestId: randomUUID() }));
        const results = await Promise.allSettled(attempts.map(input => admitWrite(engine, input, { principalOutstanding: 2 })));
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
        for (let n = 0; n < results.length; n++) {
          const result = results[n];
          if (result.status === 'rejected') assert.equal(result.reason.code, 'queue_capacity');
          else assert.equal((await admitWrite(engine, attempts[n], { principalOutstanding: 2 })).id, result.value.id);
        }
        for (const input of attempts) if (await getWriteRequest(engine, input.principal, input.requestId)) await cancelWriteRequest(engine, input.principal, input.requestId);
      } else {
        await accept(); const row = await claim();
        await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [a.principal.id]);
        try {
          const result = await publish(engine, row, sources, config); assert.equal(result.state, 'failed'); assert.equal(result.error_code, 'permission_denied');
          assert.equal(await engine.readPageSnapshot(slug, { sourceId: source.id }), null);
        } finally { await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=NULL WHERE id=$1::uuid', [a.principal.id]); }
      }
      await assertConservation(engine);
      assert.equal(await claimNextWrite(engine, config.hostId), null, `schedule ${i} left unresolved work`);
      cases[type]++;
      if ((i + 1) % 100 === 0) process.stderr.write(`[persistence] ${config.kind}: ${i + 1}/${config.schedules} schedules verified\n`);
    }
    return { executed: config.schedules, seed: config.seed, cases, boundaries: boundaryCases, duration_ms: performance.now() - started,
      admission: distribution(admissionMs), publication: distribution(commitMs), accounting_checks: config.schedules };
  } finally { await engine.disconnect(); }
}
