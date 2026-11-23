/**
 * #6712 PR 4b lane A: the live pass's fences, stop reasons and completion dependencies (design v3.2 §8, §9, §3).
 *
 * Protects:
 * - probe 51 (pass half): `sync.admission` is re-read in each admission transaction of a pass (a delete admitted after
 *   it turns `imports_only` is refused and the pass stops `partial` / `admission_paused`, the page live), and a pass's
 *   `managed_sync_delete` re-reads it at publication (completed `cancelled` / `admission_paused`, nothing written);
 *   once it is `normal` again the next pass deletes the page.
 *
 * - not_converged (design v3.2 §9): a working copy that changes under every round ends the pass `partial` / `not_converged`;
 *   the pass row counts the streak server-side, and from the third consecutive pass the drain's `next` is `report`.
 *
 * - probe 49: a re-screen-due hold alone runs a hold-only round (not a full round), which clears it.
 * - item 7: a local CLI pass waits (to 30 s) on its own write while this process's consumer holds it or has yet to claim it.
 * - in-flight wait: the pass waits on the open work it classified, a pending Git effect included, before stopping writer_pending.
 * - probe 46 (reparse half): a parser change on a fileSame and dbSame page is a `reparse`: re-imported, no hold.
 * - probe 48: a request admitted before the stamp that publishes after it (`open_at_stamp`) makes the next tick a full round, not idle.
 * - probe 53: a repair that changes a candidate mid-pass meets no busy refusal (busy is open requests only), and the path
 *   settles in a later round with no hold.
 * - kill after a group's admission commit, before the stamp: the next run resumes the pass and converges, each path imported once.
 * - probe 40: a connection or pooler fault (SQLSTATE 08006, 57P01) in a pass never becomes a hold; the next run converges.
 * - #6727 on the pass route: a new file whose slug folds to a legacy page (no recorded origin) the importer cannot write is
 *   held legacy_slug_conflict and forks no second page.
 * - a committed edit under a different uncommitted edit (committed mode) is held worktree_dirty, the page and the local
 *   file untouched, and the next pass settles instead of counting a not_converged streak; sync.holds=fail stops the run.
 * - a page written straight to the database at a new file's slug is never overwritten by the file: held file_drift (side unknown).
 * - a commit during a pass: the next round reads the new HEAD and its batch freezes that commit (no storage_error from an older pin).
 * - --no-schema-pack: a first pass converges (its parser expects no pack); a cost-gate deferral is no inherited opt-out;
 *   a source configured with a strategy, synced with that strategy named (sync --all), stamps last_commit.
 * - idle-tick batching: a converged tick still clears a recorded failure, writes its pass row at the transaction clock
 *   (one pipelined statement set), and with no failure recorded and no tail owed at pin it issues neither the clears nor
 *   the post-lease tail read.
 * - probe 54: a pass intent keeps what the #6862 FIFO guard reads: a `managed_sync_` kind, the slug and page, and `renameFrom.slug`.
 *
 * Each test fails on capy/6712-pr4b (8cda2764b), where a non-company source still runs the cursor engine: the fences do not
 * cover its intents (both deletes publish), it has no pass kinds or pass row, and its manifest remainder makes a repair busy.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { SYNC_ADMISSION_KEY } from '../src/core/persistence/sync-admission.ts';
import { SYNC_TAIL_OP } from '../src/core/persistence/sync-tail-record.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { readGitHold, SYNC_IMPORT_PROVENANCE_OP, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { preparePageAdmission, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { createHash, randomUUID } from 'node:crypto';
import { drainNext, runDrain } from '../src/core/persistence/sync-drain.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../src/core/persistence/file-repair.ts';
import { readFileSync } from 'node:fs';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
/** A durability-hardened checkout (the brain-durability post-commit hook), where a repair's Git effect commits under the checkout's own identity. */
const hardened = ({ root }: { root: string }) => {
  setup({ root });
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
};
const liveSlugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const deletes = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string; state: string; error_code: string | null }>(
  "SELECT slug, state, error_code FROM persistence_requests WHERE source_id='default' AND intent->>'kind'='managed_sync_delete' ORDER BY sequence"));

afterEach(() => installFaultHook(undefined));

describe('#6712 PR 4b live pass fences (pglite)', () => {
  test('probe 51 (pass half): sync.admission is re-read in the admission transaction; a delete classified under normal and admitted after imports_only is refused, and the pass stops admission_paused', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-q', 'notes/a.md', 'notes/b.md'); commit(root, 'remove a and b');
    // After the pass classified both deletes under normal, before their admission transaction.
    let flipped = false;
    installFaultHook(async point => { if (point === 'sync:mid_checkpoint' && !flipped) { flipped = true; await engine.setConfig(SYNC_ADMISSION_KEY, 'imports_only'); } });
    const paused = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect({ status: paused.status, reason: paused.reason }).toEqual({ status: 'partial', reason: 'admission_paused' });
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b', 'notes/c']);
    expect(await deletes(engine)).toEqual([]);

    await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await liveSlugs(engine)).toEqual(['notes/c']);
  }, { setup }), 180_000);

  test('probe 51 (pass half): a managed_sync_delete re-reads sync.admission at publication: cancelled admission_paused, the page live', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-q', 'notes/a.md'); commit(root, 'remove a');
    installFaultHook(async (point, detail) => {
      // Prepared, before its publication transaction.
      if (point === 'consumer:prepared' && detail.operation === 'submit_job' && (await deletes(engine)).some(row => row.state === 'running')) await engine.setConfig(SYNC_ADMISSION_KEY, 'imports_only');
    });
    const paused = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect({ status: paused.status, reason: paused.reason }).toEqual({ status: 'partial', reason: 'admission_paused' });
    expect(await deletes(engine)).toEqual([{ slug: 'notes/a', state: 'cancelled', error_code: 'admission_paused' }]);
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b', 'notes/c']);

    await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await liveSlugs(engine)).toEqual(['notes/b', 'notes/c']);
  }, { setup }), 180_000);

  test('item 7: a CLI pass keeps waiting on its own write while this process\'s consumer still holds it, past the 5 s wait: synced, not writer_pending', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A body that takes longer than the wait to prepare.')); commit(root, 'edit a');
    // The write's preparation outlasts the pass's 5 s wait, as a publication over a high-latency link does.
    let slowed = false;
    installFaultHook(async (point, detail) => {
      if (point === 'consumer:prepared' && detail.operation === 'submit_job' && !slowed) { slowed = true; await new Promise(resolve => setTimeout(resolve, 6500)); }
    });
    const synced = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect({ slowed, status: synced.status, reason: synced.reason }).toEqual({ slowed: true, status: 'synced', reason: undefined });
    expect((await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))?.page.compiled_truth).toContain('takes longer than the wait');
  }, { setup }), 180_000);

  test('item 7: a CLI pass keeps waiting on its own queued write while this process\'s consumer is busy past the 5 s wait before claiming it: synced, not writer_pending', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A body admitted while the consumer is busy.')); commit(root, 'edit a');
    // The consumer is busy (an effect pass under load) for longer than the pass's 5 s wait before it claims the import.
    let slowed = false;
    installFaultHook(async point => {
      if (point !== 'consumer:claiming' || slowed) return;
      if (!(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE state='queued' AND intent->>'kind'='managed_sync_import'")).length) return;
      slowed = true; await new Promise(resolve => setTimeout(resolve, 6500));
    });
    const synced = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect({ slowed, status: synced.status, reason: synced.reason }).toEqual({ slowed: true, status: 'synced', reason: undefined });
    expect((await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))?.page.compiled_truth).toContain('admitted while the consumer is busy');
  }, { setup }), 180_000);

  test('in-flight wait: a pass waits out a put_page\'s pending Git effect (its request names no page or origin), then imports the committed change', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/d', request_id: randomUUID(), content: note('notes/d', 'The body put_page wrote.') } });
    // The page's Git effect is still pending (its publication landed; the commit is 2 s out) when an agent commits a change.
    const held = await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '2 seconds' WHERE kind='git' AND state='queued' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING id");
    expect(held).toHaveLength(1);
    writeFileSync(join(root, 'notes/d.md'), note('notes/d', 'A committed agent change of notes/d.')); commit(root, 'agent change of d');
    const synced = await performManagedSync(engine, OPTS);
    expect({ status: synced.status, reason: synced.reason, held: synced.held ?? [] }).toEqual({ status: 'synced', reason: undefined, held: [] });
    expect((await engine.readPageSnapshot('notes/d', { sourceId: 'default' }))?.page.compiled_truth).toContain('A committed agent change of notes/d.');
  }, { setup: hardened }), 180_000);

  test('a sliced pass that yields writer_yield reports the entries it settled in the stopped round', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `An edit of notes/${slug}.`));
    commit(root, 'edit all three');
    const sliced = await performManagedSync(engine, OPTS, { maxPages: 1, maxMs: 120_000 });
    expect({ status: sliced.status, reason: sliced.reason, filesImported: sliced.filesImported, settled: sliced.pass?.settled })
      .toEqual({ status: 'partial', reason: 'writer_yield', filesImported: 1, settled: 1 });
    const [row] = await engine.executeRaw<{ settled: number }>("SELECT (completed_keys->0->'telemetry'->>'settled')::int AS settled FROM op_checkpoints WHERE op='managed-sync-pass'");
    expect(row?.settled).toBe(1);
  }, { setup }), 180_000);

  test('not_converged: a working copy that changes under every round ends the pass not_converged; the third in a row reports', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    let edits = 0;
    installFaultHook(async point => { if (point === 'sync:mid_checkpoint') writeFileSync(join(root, 'notes/a.md'), note('notes/a', `An uncommitted edit ${++edits}.`)); });
    const streaks: number[] = [], loops: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'An uncommitted edit before the pass.'));
      const drained = await runDrain({ pass: () => performManagedSync(engine, { ...OPTS, workingTree: true }) });
      expect({ status: drained.status, reason: drained.reason, stop: drained.drain?.stop_reason }).toEqual({ status: 'partial', reason: 'not_converged', stop: 'not_converged' });
      streaks.push(drained.pass!.not_converged_streak);
      loops.push(drainNext(drained, 'gbrain sync --source default --no-pull', 'default')!.safe_to_loop);
    }
    installFaultHook(undefined);
    expect({ streaks, loops }).toEqual({ streaks: [1, 2, 3], loops: [true, true, false] });
    expect((await performManagedSync(engine, { ...OPTS, workingTree: true })).status).toBe('synced');
    const [row] = await engine.executeRaw<{ streak: number }>("SELECT (completed_keys->0->'obligations'->>'not_converged_streak')::int AS streak FROM op_checkpoints WHERE op='managed-sync-pass'");
    expect(row?.streak).toBe(0);
  }, { setup }), 240_000);

  const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'"))[0]!.incarnation;
  const passRow = async (engine: BrainEngine) => (await engine.executeRaw<{ value: { obligations: { converged?: { open_at_stamp: string[] | null } } } }>(
    "SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op='managed-sync-pass'"))[0]?.value;

  test('probe 49: a re-screen-due hold alone runs a hold-only round, which clears it; the next tick is idle', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const incarnation = await incarnationOf(engine);
    const page = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    const blob = execFileSync('git', ['-C', (await engine.executeRaw<{ p: string }>("SELECT local_path AS p FROM sources WHERE id='default'"))[0]!.p, 'rev-parse', 'HEAD:notes/a.md'], { encoding: 'utf8' }).trim();
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/a.md', source_path: 'notes/a.md', slug: 'notes/a', page_id: Number(page.page.id),
      code: 'frontmatter_slug_conflict', message: 'Synthetic frontmatter_slug_conflict hold.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
      meta: { recovery_version: RECOVERY_VERSION, blob_oid: blob, page_revision: page.revision } } as never));
    const round = await performManagedSync(engine, OPTS);
    expect({ status: round.status, kind: round.pass?.kind }).toEqual({ status: 'synced', kind: 'hold_only' });
    expect(await readGitHold(engine, 'default', incarnation, 'notes/a.md')).toBeNull();
    const idle = await performManagedSync(engine, OPTS);
    expect({ status: idle.status, pass: idle.pass }).toEqual({ status: 'up_to_date', pass: undefined });
  }, { setup }), 180_000);

  test('idle-tick batching: a converged tick clears a recorded failure and stamps the pass row at the transaction clock; with none recorded and no tail owed it issues neither the clears nor the post-lease tail read', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const incarnation = await incarnationOf(engine);
    const failure = "SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1";
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-failure',$1,'[{}]'::jsonb)", [`default:${incarnation}`]);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect((await engine.executeRaw<{ n: number }>(failure, [`default:${incarnation}`]))[0]!.n).toBe(0);
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const executeRaw = engine.executeRaw;
    // A transaction's engine inherits this method: only the engine's own statements are recorded.
    engine.executeRaw = function (this: BrainEngine, sql: string, params?: unknown[], opts?: never) {
      if (this === engine) statements.push({ sql, params: params ?? [] });
      return executeRaw.call(this, sql, params, opts);
    } as typeof engine.executeRaw;
    try { expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date'); } finally { delete (engine as { executeRaw?: unknown }).executeRaw; }
    expect({ clears: statements.filter(s => /DELETE FROM op_checkpoints WHERE op='managed-sync-failure'/.test(s.sql)).length,
      tailReads: statements.filter(s => s.params[0] === SYNC_TAIL_OP).length }).toEqual({ clears: 0, tailReads: 1 });
    const [row] = await engine.executeRaw<{ started: string; updated: string }>(`SELECT completed_keys->0->'telemetry'->>'started_at' AS started,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated FROM op_checkpoints WHERE op='managed-sync-pass' AND fingerprint=$1`, [`default:${incarnation}`]);
    expect({ started: new Date(row!.started).toISOString(), updated: row!.updated }).toEqual({ started: row!.updated, updated: row!.updated });
  }, { setup }), 180_000);

  test('probe 46 (reparse half): a parser change on a fileSame and dbSame page re-imports it as reparse, with no hold', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const fingerprint = `default:${await incarnationOf(engine)}:${(await engine.readPageSnapshot('notes/b', { sourceId: 'default' }))!.page.id}`;
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1 AND fingerprint=$2`, [SYNC_IMPORT_PROVENANCE_OP, fingerprint]);
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
    const pass = await performManagedSync(engine, OPTS);
    expect({ status: pass.status, kind: pass.pass?.kind, candidates: pass.pass?.candidates, held: pass.held ?? [] }).toEqual({ status: 'synced', kind: 'full', candidates: 1, held: [] });
    const [record] = await engine.executeRaw<{ v: string }>("SELECT completed_keys->0->'parser'->>'parser_version' AS v FROM op_checkpoints WHERE op=$1 AND fingerprint=$2", [SYNC_IMPORT_PROVENANCE_OP, fingerprint]);
    expect(record!.v).not.toBe('an-older-parser');
  }, { setup }), 180_000);

  test('probe 48: a write admitted before the stamp that publishes after it makes the next tick a full round', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
    let late: string | null = null, release = () => {};
    const ended = new Promise<void>(resolve => { release = resolve; });
    installFaultHook(async (point, detail) => {
      // The late write publishes once the pass has ended: a round that saw it commit would stamp again, past it.
      if (point === 'consumer:prepared' && late && detail.requestId === late) { await ended; return; }
      if (point !== 'consumer:prepared' || late || detail.operation !== 'submit_job') return;
      // The request that carries the pass stamp: its checkpoint, or the last import it folded into (#6926).
      const [row] = await engine.executeRaw<{ stamp: boolean }>("SELECT intent ? 'stamp' AS stamp FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
      if (!row?.stamp) return;
      const current = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
      const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/c', request_id: randomUUID(), expected_revision: current.revision, content: note('notes/c', 'A late agent edit.') } });
      late = (await admitWrite(engine, prepared.admission!)).request_id;
    });
    const stamped = await performManagedSync(engine, OPTS).finally(release);
    expect(stamped.status).toBe('synced');
    installFaultHook(undefined);
    expect(late).not.toBeNull();
    expect((await passRow(engine))!.obligations.converged!.open_at_stamp).toContain(`r:${late}`);
    await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [late]))[0]?.state === 'committed', { timeoutMs: 20_000, label: 'the late put_page commits' });
    const next = await performManagedSync(engine, OPTS);
    expect({ status: next.status, kind: next.pass?.kind }).toEqual({ status: 'up_to_date', kind: 'full' });
    const idle = await performManagedSync(engine, OPTS);
    expect(idle.pass).toBeUndefined();
  }, { setup }), 180_000);

  test('probe 53: a repair changes a candidate mid-pass: no busy refusal, and it settles later with no hold', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.'));
    writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'A committed change of notes/c.')); commit(root, 'change a and c');
    const repaired = note('notes/c', 'The repaired body of notes/c.');
    let outcome: Record<string, unknown> | null = null;
    installFaultHook(async (point, detail) => {
      if (point !== 'sync:after_freeze' || detail.path !== 'notes/a.md' || outcome) return;
      const snapshot = await engine.readPageSnapshot('notes/c', { sourceId: 'default', includeDeleted: true });
      const publication = await prepareRepairPublication(engine, { sourceId: 'default', slug: 'notes/c', sourcePath: 'notes/c.md', path: 'notes/c.md', root, content: repaired, snapshot, base: snapshot, ...await repairScreenConfig(engine, 'default') });
      if (publication.status !== 'ready') throw new Error(`the repair publication is ${publication.status}`);
      outcome = await submitManagedFileRepair(ctx, { sourceId: 'default', requestId: randomUUID(), slug: 'notes/c', path: 'notes/c.md', sourcePath: 'notes/c.md', content: repaired,
        beforeHash: createHash('sha256').update(readFileSync(join(root, 'notes/c.md'))).digest('hex'), resultDigest: publication.digest, expected_revision: snapshot!.revision, noEmbed: true });
    });
    const rounds = [await performManagedSync(engine, OPTS)];
    installFaultHook(undefined);
    expect(outcome).toMatchObject({ state: 'committed', file_repaired: true });
    await waitFor(async () => !(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id='default' AND kind='git' AND state<>'committed'")).length,
      { timeoutMs: 20_000, label: 'the repair commit lands in Git' });
    while (rounds.length < 5 && rounds.at(-1)!.status !== 'up_to_date') rounds.push(await performManagedSync(engine, OPTS));
    expect({ last: rounds.at(-1)!.status, held: rounds.flatMap(round => round.held ?? []) }).toEqual({ last: 'up_to_date', held: [] });
    expect((await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!.page.compiled_truth).toContain('The repaired body of notes/c.');
    expect((await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!.page.compiled_truth).toContain('A committed change of notes/a.');
    expect(git(root, 'show', 'HEAD:notes/c.md')).toContain('The repaired body of notes/c.');
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-hold'")).toEqual([]);
  }, { setup: hardened }), 180_000);

  const lastSequence = async (engine: BrainEngine) => Number((await engine.executeRaw<{ s: number }>('SELECT COALESCE(max(sequence),0) AS s FROM persistence_requests'))[0]!.s);
  const changeAll = (root: string) => { for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `A committed change of notes/${slug}.`)); commit(root, 'change all'); };
  const converged = async (engine: BrainEngine, after: number) => {
    for (const slug of ['a', 'b', 'c']) expect((await engine.readPageSnapshot(`notes/${slug}`, { sourceId: 'default' }))!.page.compiled_truth).toContain(`A committed change of notes/${slug}.`);
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-hold'")).toEqual([]);
    const imports = await engine.executeRaw<{ slug: string; n: number }>("SELECT slug, count(*)::int AS n FROM persistence_requests WHERE intent->>'kind'='managed_sync_import' AND state='committed' AND intent ? 'passId' AND sequence>$1 GROUP BY slug ORDER BY slug", [after]);
    expect(imports.map(row => [row.slug, Number(row.n)])).toEqual([['notes/a', 1], ['notes/b', 1], ['notes/c', 1]]);
    expect((await performManagedSync(engine, OPTS)).pass).toBeUndefined();
  };

  test('a kill after a group admission commits, before the stamp, resumes on the next run and converges', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const after = await lastSequence(engine);
    changeAll(root);
    let killed = false;
    installFaultHook(async point => { if (point === 'sync:mid_checkpoint' && !killed) { killed = true; throw new Error('killed after the group admission'); } });
    const dead = await performManagedSync(engine, OPTS).then(result => result.status, (error: Error) => error.message);
    installFaultHook(undefined);
    expect(killed).toBe(true);
    expect(dead).not.toBe('synced');
    await disposePersistenceConsumer(engine);
    const [row] = await engine.executeRaw<{ at: string | null }>("SELECT completed_keys->0->'obligations'->'converged'->>'target' AS at FROM op_checkpoints WHERE op='managed-sync-pass'");
    expect(row?.at).not.toBe(git(root, 'rev-parse', 'HEAD'));
    const resumed = await performManagedSync(engine, OPTS);
    expect({ status: resumed.status, held: resumed.held ?? [] }).toEqual({ status: 'synced', held: [] });
    await converged(engine, after);
  }, { setup }), 180_000);

  for (const code of ['08006', '57P01']) test(`probe 40: a connection fault (${code}) in a pass never becomes a hold, and the next run converges`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const after = await lastSequence(engine);
    changeAll(root);
    const fault = () => Object.assign(new Error('Connection terminated unexpectedly'), { code });
    const faults = new Set<string>();
    installFaultHook(async (point, detail) => {
      if (point === 'sync:mid_checkpoint' && !faults.has(point)) { faults.add(point); throw fault(); }
      if (point === 'consumer:prepared' && detail.operation === 'submit_job' && !faults.has(point)) { faults.add(point); throw fault(); }
    });
    const rounds = [await performManagedSync(engine, OPTS).then(result => result, (error: Error) => ({ status: `threw: ${error.message}`, held: [] as unknown[] }))];
    while (rounds.length < 5 && rounds.at(-1)!.status !== 'synced' && rounds.at(-1)!.status !== 'up_to_date')
      rounds.push(await performManagedSync(engine, OPTS).then(result => result, (error: Error) => ({ status: `threw: ${error.message}`, held: [] as unknown[] })));
    installFaultHook(undefined);
    expect([...faults].sort()).toEqual(['consumer:prepared', 'sync:mid_checkpoint']);
    expect({ last: rounds.at(-1)!.status, held: rounds.flatMap(round => round.held ?? []) }).toEqual({ last: 'synced', held: [] });
    await converged(engine, after);
  }, { setup }), 180_000);

  test('#6727 on the pass route: a new file whose slug folds to a legacy page it cannot write is held legacy_slug_conflict, never forked', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.transaction(async tx => {
      await tx.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await tx.executeRaw("INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth) VALUES('default','notes/Legacy Name','note','markdown','Legacy Name','A legacy page.')");
      await tx.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    });
    writeFileSync(join(root, 'notes/Legacy Name.md'), note('Legacy Name', 'The file of an unwritable legacy page.')); commit(root, 'legacy file');
    const result = await performManagedSync(engine, OPTS);
    expect((result.held ?? []).map(hold => [hold.path, hold.code])).toEqual([['notes/Legacy Name.md', 'legacy_slug_conflict']]);
    const pages = await engine.executeRaw<{ slug: string; source_path: string | null; body: string }>(
      "SELECT slug, source_path, compiled_truth AS body FROM pages WHERE source_id='default' AND deleted_at IS NULL AND lower(slug) LIKE 'notes/legacy%' ORDER BY slug");
    expect(pages.map(page => ({ slug: page.slug, source_path: page.source_path, body: page.body.trim() }))).toEqual([{ slug: 'notes/Legacy Name', source_path: null, body: 'A legacy page.' }]);
  }, { setup }), 180_000);

  test('a committed edit under a different uncommitted edit is held worktree_dirty, untouched, and the next pass settles', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'An uncommitted draft of notes/a.'));
    const first = await performManagedSync(engine, OPTS);
    expect((first.held ?? []).map(hold => [hold.path, hold.code])).toEqual([['notes/a.md', 'worktree_dirty']]);
    expect((await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!.page.compiled_truth).toContain('The committed body of notes/a.');
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('An uncommitted draft of notes/a.');
    const second = await performManagedSync(engine, OPTS);
    expect({ status: second.status, streak: second.pass?.not_converged_streak ?? 0 }).toEqual({ status: second.status === 'up_to_date' ? 'up_to_date' : 'synced', streak: 0 });
  }, { setup }), 180_000);

  test('with sync.holds=fail the same committed edit under an uncommitted edit stops the run, the page and the file untouched', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'An uncommitted draft of notes/a.'));
    const refused = await performManagedSync(engine, OPTS).then(result => ({ status: result.status, reason: result.reason ?? null }), (error: { code?: string }) => ({ status: 'threw', reason: error.code ?? null }));
    expect(refused).toEqual({ status: 'blocked_by_failures', reason: null });
    expect((await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!.page.compiled_truth).toContain('The committed body of notes/a.');
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('An uncommitted draft of notes/a.');
  }, { setup }), 180_000);

  test('a database-only page at a new file\'s slug is held file_drift and never overwritten', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.write_through', 'false');
    for (const [slug, body] of [['notes/d', 'A database-only page.'], ['notes/e', 'The same body.']] as const)
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: note(slug, body) } });
    await waitFor(async () => (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE state<>'committed'")).length === 0, { timeoutMs: 20_000, label: 'the put_pages commit' });
    writeFileSync(join(root, 'notes/d.md'), note('notes/d', 'A committed file at the same slug.'));
    writeFileSync(join(root, 'notes/e.md'), note('notes/e', 'The same body.')); commit(root, 'files at database-only slugs');
    const result = await performManagedSync(engine, OPTS);
    // Neither page records an origin, so neither side is attested: both are held (an equal body is not proof the file wrote it).
    expect((result.held ?? []).map(hold => [hold.path, hold.code])).toEqual([['notes/d.md', 'file_drift'], ['notes/e.md', 'file_drift']]);
    expect((await engine.readPageSnapshot('notes/d', { sourceId: 'default' }))!.page.compiled_truth).toContain('A database-only page.');
    expect((await engine.executeRaw<{ source_path: string | null }>("SELECT source_path FROM pages WHERE source_id='default' AND slug IN ('notes/d','notes/e') ORDER BY slug")).map(row => row.source_path)).toEqual([null, null]);
  }, { setup }), 180_000);

  test('a commit landing during a pass: the next round imports it from the new HEAD, and the pass ends there', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A committed change of notes/a.')); commit(root, 'change a');
    let moved = false;
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:prepared' || moved || detail.operation !== 'submit_job') return;
      moved = true;
      writeFileSync(join(root, 'notes/d.md'), note('notes/d', 'A file committed during the pass.')); commit(root, 'add d during the pass');
    });
    const during = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect(moved).toBe(true);
    expect({ status: during.status, to: during.toCommit, added: during.added, modified: during.modified }).toEqual({ status: 'synced', to: git(root, 'rev-parse', 'HEAD'), added: 1, modified: 1 });
    expect((await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!.page.compiled_truth).toContain('A committed change of notes/a.');
    expect((await engine.readPageSnapshot('notes/d', { sourceId: 'default' }))!.page.compiled_truth).toContain('A file committed during the pass.');
    expect((await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='default'"))[0]!.last_commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }, { setup }), 180_000);

  test('--no-schema-pack: a three-file first pass converges, and the next pass under the flag is idle', () => managedBrain(async ({ engine }) => {
    const first = await performManagedSync(engine, { ...OPTS, noSchemaPack: true });
    expect({ status: first.status, outcome: first.pass?.outcome, remaining: first.pass?.remaining }).toEqual({ status: 'first_sync', outcome: 'synced', remaining: 0 });
    expect((await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'"))[0]!.last_commit).not.toBeNull();
    expect((await performManagedSync(engine, { ...OPTS, noSchemaPack: true })).status).toBe('up_to_date');
  }, { setup }), 180_000);

  test('#6696: a cost-gate deferral is the pass\'s own constraint, never an opt-out the next flagless pass inherits', () => managedBrain(async ({ engine }) => {
    const deferred = await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, embedDeferred: true }, { maxPages: 1, maxMs: 60_000 });
    expect(deferred.status).toBe('partial');
    const [row] = await engine.executeRaw<{ episode: unknown }>("SELECT completed_keys->0->'obligations'->'episode' AS episode FROM op_checkpoints WHERE op='managed-sync-pass' AND completed_keys->0->>'source_id'='default'");
    expect(row!.episode ?? null).toBeNull();
    const imports = await engine.executeRaw<{ no_embed: boolean; deferred: boolean | null }>("SELECT (intent->'processingOptions'->>'noEmbed')::boolean AS no_embed, (intent->>'embedDeferred')::boolean AS deferred FROM persistence_requests WHERE source_id='default' AND intent->>'kind'='managed_sync_import'");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every(request => request.no_embed === false && request.deferred === true)).toBe(true);
    const next = await performManagedSync(engine, { sourceId: 'default', noPull: true });
    expect(next.status).toBe('first_sync');
    expect(next.inherited_options).toBeUndefined();
  }, { setup }), 180_000);

  test('#6696 C1: a source configured with a strategy, synced with that strategy named (sync --all), is the configured selection and stamps last_commit', () => managedBrain(async ({ engine, root }) => {
    await engine.executeRaw("UPDATE sources SET config=COALESCE(config,'{}'::jsonb)||jsonb_build_object('strategy','markdown') WHERE id='default'");
    const first = await performManagedSync(engine, { ...OPTS, strategy: 'markdown' });
    expect({ status: first.status, reason: first.reason }).toEqual({ status: 'first_sync', reason: undefined });
    expect((await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'"))[0]!.last_commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect((await performManagedSync(engine, { ...OPTS, strategy: 'markdown' })).status).toBe('up_to_date');
  }, { setup }), 180_000);

  test('probe 54: a pass intent keeps what the #6862 FIFO guard reads, renameFrom included', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'mv', 'notes/b.md', 'notes/renamed.md'); commit(root, 'rename b');
    const seen: Array<Record<string, unknown>> = [];
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:prepared') return;
      const [row] = await engine.executeRaw<{ kind: string; slug: string; page_id: number | null; rename_slug: string | null; pass_id: string | null }>(
        "SELECT intent->>'kind' AS kind, slug, page_id, intent->'renameFrom'->>'slug' AS rename_slug, intent->>'passId' AS pass_id FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
      if (row?.kind === 'managed_sync_import') seen.push({ kind: row.kind, slug: row.slug, page_id: row.page_id === null ? null : Number(row.page_id), rename_slug: row.rename_slug, pass: !!row.pass_id });
    });
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    installFaultHook(undefined);
    expect(seen).toEqual([{ kind: 'managed_sync_import', slug: 'notes/renamed', page_id: null, rename_slug: 'notes/b', pass: true }]);
  }, { setup }), 180_000);
});
