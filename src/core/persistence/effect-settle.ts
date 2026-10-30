/**
 * #7423 / #7378: `gbrain sources writer settle-effects <source> (--request-id <id> | --parked-code <code>) [--unsettle]
 * [--dry-run | --apply --expect <plan_hash>]`, the operator exit for a parked or failed Git effect whose retry can never
 * succeed. A settlement is a disposition recorded on the effect row (`data.settled`, with every settle and unsettle
 * appended to `data.settlements`); the failure, its parked targets, the request, its intent and the target bytes are
 * never changed or deleted. Every reader of parked and held effects skips a settled row, and `--unsettle` (bound to its
 * own plan) restores it.
 *
 * An effect settles only on an exact-target proof, re-checked under row locks when the plan is applied:
 * - `db_only`: each target's slug falls under a `storage.db_only` directory of the current binding's gbrain.yml (not a
 *   push code: a commit that failed to push still owes its push);
 * - `superseded_remote`: the binding guard refuses the effect as `source_changed` because the source moved to a new
 *   worktree (same incarnation, this host owns the current binding), and for each target a later Git effect of the
 *   current worktree committed and pushed the bytes the canonical file holds now, and the already-fetched remote-tracking
 *   ref of the checkout's branch holds exactly those bytes at that path. Nothing is fetched: a missing ref, or a ref
 *   that lacks bytes a push reported, refuses.
 * Unknown targets, a withdrawal or other non-Git effect, a claimed effect, an open recovery record, a revoked original
 * writer, a replaced source and a binding this host does not own are refused. An effect of the current binding that is
 * not db_only is refused as `retry_instead`: `retry-effects` can still run it.
 * The plan hash (doctor --remediate's `computePlanHash`) binds the brain, source, selector, mode, the binding's owner epoch
 * and each effect's proof; an apply under another hash refuses `preview_changed` and changes nothing.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { computePlanHash } from '../consent.ts';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';
import { digest } from './digest.ts';
import { existingLocalHostId } from './identity.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { storedAuthorityRefusal } from './effect-retry.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { persistenceFileHash } from './coordinator.ts';
import { sourceDbOnlyDir } from './source-storage.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import { GIT_PUSH_CODES } from './git-push-holds.ts';
import type { EffectSettlement, ParkedTarget, PersistenceEffect, SettlementProof, SettledTarget } from './effect-model.ts';
import type { WriteRequest } from './model.ts';

export interface SettleEffectsInput { sourceId: string; requestId?: string; parkedCode?: string; unsettle?: boolean; apply?: boolean; expect?: string }
type Refusal = { code: string; message: string };
type Row = PersistenceEffect & { request: WriteRequest };
interface Entry {
  effect_id: string; request_id: string; kind: string; error_code: string | null; worktree_id: string | null; targets: ParkedTarget[];
  action: 'would_settle' | 'settled' | 'would_unsettle' | 'unsettled' | 'refused'; proof?: SettlementProof; settled?: EffectSettlement; refusal?: Refusal;
}

const statusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner with its retrying and parked effects, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const PUSH_CODES: readonly string[] = GIT_PUSH_CODES;

async function gitRead(root: string, args: string[]): Promise<string | null> {
  const { error, stdout } = await execFileBounded('git', ['-C', root, ...args], { timeout: 20_000, maxBuffer: 1024 * 1024, env: gitChildEnv(GIT_ENV) });
  return error ? null : stdout.trim() || null;
}

/** The targets an effect owes: its parked targets, or (a push that failed without parking) its own page. */
function effectTargets(effect: PersistenceEffect): ParkedTarget[] {
  return effect.data.parked ?? [{ ...(effect.data.slug ? { slug: effect.data.slug } : {}), error_code: effect.error_code ?? 'unknown' }];
}

/** The proof that a later, pushed Git effect of the current worktree holds this target's current canonical bytes on the fetched remote. */
async function remoteProof(tx: BrainEngine, effect: PersistenceEffect, binding: WorktreeBinding & { local_path: string }, slug: string): Promise<SettledTarget | Refusal> {
  const [receipt] = await tx.executeRaw<{ request_id: string; state: string; data: PersistenceEffect['data']; outcome: Record<string, unknown> | null }>(
    `SELECT r.request_id::text AS request_id,e.state,e.data,e.outcome FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      WHERE e.kind='git' AND e.source_id=$1 AND e.worktree_id=$2::uuid AND e.id>$3 AND e.data->>'slug'=$4 AND e.data ? 'relative_path'
      ORDER BY e.id DESC LIMIT 1`, [effect.source_id, binding.worktree_id, effect.id, slug]);
  if (!receipt) return { code: 'no_covering_receipt', message: `No later Git effect of source ${effect.source_id}'s current worktree committed page ${slug}, so nothing shows its current bytes were backed up. Write the page through gbrain (its Git effect commits and pushes it), then preview again.` };
  const path = receipt.data.relative_path!;
  if (effect.data.relative_path !== undefined && !effect.data.source_scan && effect.data.relative_path !== path) {
    return { code: 'unknown_target', message: `Page ${slug} is now filed at ${path}, not at ${effect.data.relative_path}, the path this effect owes; no exact target links them.` };
  }
  const file = join(binding.local_path, path);
  const page = await tx.readPageSnapshot(slug, { sourceId: effect.source_id });
  if (!page || !existsSync(file) || !statSync(file).isFile()) return { code: 'content_missing', message: `Page ${slug} or its canonical file ${path} is gone, so there are no current bytes to prove.` };
  if (persistenceFileHash(file) !== receipt.data.expected_hash) return { code: 'content_changed', message: `The canonical file ${path} no longer holds the bytes the latest Git effect of page ${slug} (request ${receipt.request_id}) wrote; inspect the checkout before preview again.` };
  if (receipt.state !== 'committed' || receipt.outcome?.push !== 'committed') return { code: 'bytes_unpushed', message: `The latest Git effect of page ${slug} (request ${receipt.request_id}) has not pushed (state ${receipt.state}), so its bytes are on this host only. Let it push (gbrain sources writer status shows it), then preview again.` };
  const ref = await gitRead(binding.local_path, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  const commit = ref ? await gitRead(binding.local_path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) : null;
  if (!ref || !commit) return { code: 'remote_ref_missing', message: `The checkout of source ${effect.source_id} has no fetched remote-tracking ref for its branch, so the remote cannot be read without fetching. Fetch in the checkout, then preview again.` };
  const [remoteBlob, fileBlob] = await Promise.all([gitRead(binding.local_path, ['rev-parse', '--verify', '-q', `${commit}:./${path}`]), gitRead(binding.local_path, ['hash-object', '--', path])]);
  if (!fileBlob || remoteBlob !== fileBlob) return { code: 'remote_ref_stale', message: `The fetched ${ref} (${commit}) does not hold the bytes of ${path} that request ${receipt.request_id} pushed: the ref is older than that push, or the remote moved past it. Fetch in the checkout, then preview again.` };
  return { slug, path, remote_ref: ref, remote_commit: commit, blob: fileBlob, receipt_request_id: receipt.request_id };
}

/** The exact-target proof for one effect, or why it cannot settle. */
async function settleProof(tx: BrainEngine, row: Row, hostId: string, binding: WorktreeBinding | null): Promise<SettlementProof | Refusal> {
  const { request, ...effect } = row;
  if (effect.kind === 'withdrawal-mirror') return { code: 'withdrawal_effect', message: 'A withdrawal effect is never settled: its file may still hold the withdrawn text.' };
  if (effect.kind !== 'git') return { code: 'not_git_effect', message: `Only Git effects settle; this ${effect.kind} effect keeps its own retry.` };
  if (effect.execution_token !== null) return { code: 'claimed', message: 'A worker holds this effect; preview again once it is released.' };
  if (effect.recovery || request.recovery) return { code: 'recovery_open', message: 'The effect or its request holds an open recovery record; it must be recovered first.' };
  if (!binding?.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') return { code: 'owner_unavailable',
    message: `This host does not own source ${effect.source_id}'s active canonical binding; settle runs on the owner host.` };
  let former = false;
  try { await guardEffectSource(tx, effect, hostId); }
  catch (error) {
    if (!(error instanceof OperationError)) throw error;
    if (error.code !== 'source_changed') return { code: error.code, message: error.message };
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [effect.source_id]);
    if (!source || source.archived || source.incarnation !== effect.source_incarnation || binding.source_incarnation !== effect.source_incarnation || binding.worktree_id === effect.worktree_id) {
      return { code: 'source_replaced', message: `Source ${effect.source_id} was archived, removed or re-created after this effect was recorded, so it owes nothing to the current source.` };
    }
    former = true;
  }
  const denied = await storedAuthorityRefusal(tx, request, effect.source_id);
  if (denied) return { code: 'authority_changed', message: `The original writer is no longer authorized (${denied.message}).` };
  const sourceRoot = join(binding.local_path, binding.relative_path);
  const targets: SettledTarget[] = [];
  for (const target of effectTargets(effect)) {
    if (!target.slug) return { code: 'unknown_target', message: 'A parked entry names no page, so its exact target is unknown.' };
    let declared: string | null;
    try { declared = PUSH_CODES.includes(target.error_code) ? null : sourceDbOnlyDir(sourceRoot, target.slug); }
    catch (error) { if (error instanceof OperationError) return { code: error.code, message: error.message }; throw error; }
    if (declared) { targets.push({ slug: target.slug, declared }); continue; }
    if (!former) return { code: 'retry_instead', message: `Page ${target.slug} is not declared db_only and the effect belongs to the current binding, so retry-effects can still run it.` };
    const proved = await remoteProof(tx, effect, binding as WorktreeBinding & { local_path: string }, target.slug);
    if ('code' in proved) return proved;
    targets.push(proved);
  }
  return targets.every(target => 'declared' in target)
    ? { kind: 'db_only', worktree_id: binding.worktree_id, targets }
    : { kind: 'superseded_remote', former_worktree_id: effect.worktree_id!, worktree_id: binding.worktree_id, targets };
}

export async function settleEffects(engine: BrainEngine, input: SettleEffectsInput): Promise<Record<string, unknown> & { plan_hash: string; effects: Entry[] }> {
  const { sourceId, requestId, parkedCode, unsettle = false, apply = false } = input;
  if ((requestId === undefined) === (parkedCode === undefined)) throw opError('invalid_params', 'settle-effects selects with exactly one of --request-id or --parked-code.',
    `Preview with gbrain sources writer settle-effects ${sourceId} and one parked code doctor parked_effects names (--parked-code), or name one request with --request-id.`, { fix: statusFix(sourceId) });
  if (apply && !input.expect) throw opError('invalid_params', 'settle-effects --apply needs --expect <plan_hash> from its preview.',
    'Run the preview (--dry-run), show the user the plan, and run the apply_command it prints after they agree.', { fix: statusFix(sourceId) });
  const hostId = existingLocalHostId();
  if (!hostId) throw opError('permission_denied', 'Settling effects requires the registered local CLI host.',
    `This machine has no registered gbrain host identity, so it cannot settle effects of source ${sourceId}; nothing changed. Run it on the brain host that owns ${sourceId}.`, { fix: statusFix(sourceId) });
  const selector = requestId !== undefined ? ['--request-id', requestId] : ['--parked-code', parkedCode!];
  const mode = unsettle ? 'unsettle' : 'settle';
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','2s',true),set_config('statement_timeout','10s',true)");
    const binding = await getWorktreeBinding(tx, sourceId, hostId);
    const rows = await tx.executeRaw<Row>(`SELECT e.*,r.request_id::text AS public_request_id,to_jsonb(r) AS request FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      WHERE e.source_id=$1 AND ($2::uuid IS NULL OR r.request_id=$2::uuid)
        AND ($3::text IS NULL OR e.error_code=$3 OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p WHERE p->>'error_code'=$3))
        AND (CASE WHEN $4::boolean THEN e.data ? 'settled'
          ELSE e.state='failed' AND NOT (e.data ? 'settled') AND (e.data ? 'parked' OR e.kind='git' AND e.error_code=ANY($5::text[])) END)
      ORDER BY e.id LIMIT 200 ${apply ? 'FOR UPDATE OF e' : ''}`, [sourceId, requestId ?? null, parkedCode ?? null, unsettle, PUSH_CODES]);
    const effects: Entry[] = [];
    for (const row of rows) {
      const entry = { effect_id: String(row.id), request_id: (row as Row & { public_request_id: string }).public_request_id, kind: row.kind, error_code: row.error_code,
        worktree_id: row.worktree_id, targets: effectTargets(row) };
      if (unsettle) { effects.push({ ...entry, action: 'would_unsettle', settled: row.data.settled }); continue; }
      const proof = await settleProof(tx, row, hostId, binding);
      effects.push('code' in proof ? { ...entry, action: 'refused', refusal: proof } : { ...entry, action: 'would_settle', proof });
    }
    const actionable = effects.filter(effect => effect.action !== 'refused');
    const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton=1');
    const planHash = computePlanHash({ brain: brain?.brain_id ?? 'unknown', source: sourceId, operation: `writer_${mode}_effects`,
      records: actionable.map(effect => ({ id: effect.effect_id, revision: digest(effect.proof ?? effect.settled ?? null) })),
      parameters: { request_id: requestId ?? null, parked_code: parkedCode ?? null, owner_epoch: binding?.owner_epoch ?? null, worktree_id: binding?.worktree_id ?? null }, effects: [] });
    if (apply) {
      if (input.expect !== planHash) throw opError('preview_changed', `The settle plan changed since its preview (--expect ${input.expect}, current plan ${planHash}); nothing was changed.`,
        'Preview again, show the user the new plan, and run its apply_command only if they approve it.',
        { fix: readFix('Shows the current settle plan and its plan_hash, read-only.', { argv: ['gbrain', 'sources', 'writer', 'settle-effects', sourceId, ...selector, ...(unsettle ? ['--unsettle'] : []), '--dry-run', '--json'] }) });
      const at = new Date().toISOString();
      for (const effect of actionable) {
        if (unsettle) {
          await tx.executeRaw(`UPDATE persistence_effects SET data=(data-'settled')||jsonb_build_object('settlements',COALESCE(data->'settlements','[]'::jsonb)||jsonb_build_array($2::text::jsonb)),
            updated_at=now() WHERE id=$1 AND data ? 'settled'`, [effect.effect_id, JSON.stringify({ action: 'unsettled', at, host_id: hostId, plan_hash: planHash, settled: effect.settled })]);
          effect.action = 'unsettled';
          continue;
        }
        const settled: EffectSettlement = { reason: effect.proof!.kind, at, host_id: hostId, plan_hash: planHash, proof: effect.proof! };
        await tx.executeRaw(`UPDATE persistence_effects SET data=data||jsonb_build_object('settled',$2::text::jsonb,'settlements',COALESCE(data->'settlements','[]'::jsonb)||jsonb_build_array($3::text::jsonb)),
          updated_at=now() WHERE id=$1 AND state='failed' AND execution_token IS NULL AND recovery IS NULL AND NOT (data ? 'settled')`,
        [effect.effect_id, JSON.stringify(settled), JSON.stringify({ action: 'settled', ...settled })]);
        effect.action = 'settled';
      }
    }
    const applyCommand = ['gbrain', 'sources', 'writer', 'settle-effects', sourceId, ...selector, ...(unsettle ? ['--unsettle'] : []), '--apply', '--expect', planHash];
    const preview = !apply && actionable.length > 0;
    return { action: 'writer_settle_effects', source_id: sourceId, mode, dry_run: !apply, plan_hash: planHash, settleable: actionable.length,
      refused: effects.length - actionable.length, effects,
      ...(preview ? { apply_command: applyCommand, fix: { ask_user: true, argv: applyCommand, consent: [], actor: 'agent', requires_exclusive: false,
        why: unsettle ? 'Removes the settled disposition so the effects are held and reported again; the settlement stays in their history.'
          : 'Records a settled disposition on each listed effect (its failure, request and target bytes are kept), so doctor and retries stop reporting it.',
        user_message: unsettle ? `Un-settle ${actionable.length} effect(s) of source ${sourceId}, so doctor reports them again?`
          : `Settle ${actionable.length} Git effect(s) of source ${sourceId} whose retry can never succeed? Each has the proof shown; their failures stay in history and --unsettle reverses it.`,
        verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] } } satisfies Action } : {}),
      next: preview ? 'Show the user each proof; run apply_command (bound to this plan_hash) only after they agree.'
        : apply ? `${actionable.length} effect(s) ${unsettle ? 'un-settled' : 'settled'}; doctor parked_effects and writer status reflect it now.`
          : effects.length ? 'No listed effect can settle; each refusal names its cause.' : `No ${unsettle ? 'settled' : 'unsettled parked or failed'} effect matches this selector.` };
  });
}
